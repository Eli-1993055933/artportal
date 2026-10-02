// ca-bootstrap.mjs —— 补全服务器缺失的 TLS 中间证书,让 Node 原生 fetch 能过校验。
//
// 背景(2026-10-02 排查):
//   国内不少机构官网(如 cafa.edu.cn / caa.edu.cn)只发叶子证书、不发中间证书。
//   浏览器和 curl 会用证书里的 AIA(Authority Information Access)字段自动补链,Node 不会,
//   于是 Node 原生 fetch 报 UNABLE_TO_VERIFY_LEAF_SIGNATURE → 整源抓取失败(表现为 "fetch-error TypeError")。
//   修法不是关校验(rejectUnauthorized:false 会失去安全性),而是把中间证书补进 CA bundle,
//   用 NODE_EXTRA_CA_CERTS 喂给 Node,校验保持开启。
//
// 本脚本做的事:
//   1. 扫 sources.json 取全部唯一域名 → tls.connect 探测证书链;
//   2. 对"只发叶子证书"(链长=1)的域名,读 AIA 的 CA Issuers URI,下载中间证书;
//   3. 逐张校验(issuer 必须与叶子签发者一致),去重后汇总成 PEM bundle;
//   4. 用 bundle 复验一遍(rejectUnauthorized=true),打印修复效果。
//
// 产物: pipeline/state/ca-intermediates.pem   (state/ 已 gitignore,不进仓库)
// 用法: node ca-bootstrap.mjs
//       NODE_EXTRA_CA_CERTS=<仓库>/pipeline/state/ca-intermediates.pem node --env-file=.env run.mjs

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const P = (...p) => join(__dir, ...p);
const OUT = P("state", "ca-intermediates.pem");
const UA = "ArtPortal-CA-Bootstrap/0.1 (+certificate chain repair; contact: atsang799@gmail.com)";
const CONCURRENCY = 24;
const TIMEOUT_MS = 8000;

function timeout(p, ms, tag) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout:" + tag)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function pool(items, limit, job) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const k = i++;
      if (k >= items.length) break;
      try { out[k] = await job(items[k]); } catch (e) { out[k] = { error: String(e.message || e) }; }
    }
  }));
  return out;
}

// 读 TLS 握手返回的证书链:链长 + 叶子证书(含 AIA)
function chainInfo(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: TIMEOUT_MS });
    const done = (v) => { try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.once("secureConnect", () => {
      try {
        const leaf = sock.getPeerCertificate(true);
        let n = 1, cur = leaf;
        while (cur && cur.issuerCertificate && cur.issuerCertificate.fingerprint256 !== cur.fingerprint256) {
          n++; cur = cur.issuerCertificate;
        }
        done({ host, chainLen: n, leaf, authorized: sock.authorized, authError: sock.authorizationError || null });
      } catch (e) { done({ host, error: String(e.message || e) }); }
    });
    sock.once("timeout", () => done({ host, error: "timeout" }));
    sock.once("error", (e) => done({ host, error: String(e.code || e.message || e) }));
  });
}

function aiaUris(cert) {
  const ia = cert && cert.infoAccess;
  if (!ia) return [];
  const uris = [];
  const push = (v) => { for (const x of [].concat(v || [])) if (typeof x === "string") uris.push(x.replace(/^\s*URI:/, "").trim()); };
  if (typeof ia === "string") {
    // 老版本 Node: "OCSP - URI:http://...\nCA Issuers - URI:http://..."
    for (const line of ia.split("\n")) if (/CA Issuers/i.test(line)) push(line.split(":").slice(1).join(":"));
  } else {
    push(ia["CA Issuers - URI"]);
  }
  return uris.filter(u => /^https?:\/\//i.test(u));
}

async function download(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) return { error: "http-" + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf };
  } catch (e) { return { error: String(e.name || e.message || e) }; }
  finally { clearTimeout(t); }
}

function toPem(buf) {
  const text = buf.toString("utf8");
  if (text.includes("-----BEGIN CERTIFICATE-----")) return text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g).join("\n") + "\n";
  return new X509Certificate(buf).toString();   // DER → PEM
}

// 取 CN。两种来源格式不同,不能直接比字符串:
//   · getPeerCertificate().issuer → OpenSSL 单行 "/C=BE/O=GlobalSign nv-sa/CN=GlobalSign GCC R6 AlphaSSL CA 2025"
//   · X509Certificate.subject      → RFC2253 "CN=GlobalSign GCC R6 AlphaSSL CA 2025,O=GlobalSign nv-sa,C=BE"
function cnOf(v) {
  // Node 24: getPeerCertificate().issuer 是对象 {C,O,CN};X509Certificate.subject 是多行/逗号串。
  if (v && typeof v === "object" && !Array.isArray(v)) return String(v.CN || "").trim();
  const str = String(v || "");
  const m = /(?:^|[\n,/])CN=([^\n,/]+)/.exec(str);
  return m ? m[1].trim() : "";
}

async function main() {
  const doc = JSON.parse(await readFile(P("sources.json"), "utf8"));
  const hosts = new Set();
  for (const s of doc.sources) {
    for (const u of [s.url, s.rss]) {
      if (!u) continue;
      try { const x = new URL(u); if (x.protocol === "https:") hosts.add(x.host); } catch (e) {}
    }
  }
  const list = [...hosts];
  console.log(`唯一 HTTPS 域名 ${list.length} 个,开始探测证书链…`);

  const probes = await pool(list, CONCURRENCY, chainInfo);
  const ok = probes.filter(p => !p.error);
  const needFix = ok.filter(p => p.chainLen === 1);
  console.log(`探测完成: 成功 ${ok.length} / 失败(连不上) ${probes.length - ok.length}`);
  console.log(`其中"只发叶子证书"(链长=1,Node 必挂): ${needFix.length}`);

  const pemSet = new Map();   // pem -> {subject, issuer}
  let aiaMissing = 0, dlFail = 0, mismatch = 0;

  await pool(needFix, CONCURRENCY, async (pr) => {
    const uris = aiaUris(pr.leaf);
    if (!uris.length) { aiaMissing++; return; }
    const want = pr.leaf.issuer;   // 叶子的签发者,中间证书的 subject 必须等于它
    for (const u of uris) {
      const d = await download(u);
      if (d.error) { dlFail++; continue; }
      let pem, cert;
      try { cert = new X509Certificate(d.buf); pem = toPem(d.buf); }
      catch (e) { dlFail++; continue; }
      if (!cnOf(cert.subject) || cnOf(cert.subject) !== cnOf(want)) { mismatch++; continue; }
      if (!pemSet.has(pem)) pemSet.set(pem, { subject: cert.subject, issuer: cert.issuer, src: u, host: pr.host });
      return;
    }
  });

  const pems = [...pemSet.keys()];
  console.log(`AIA 缺失(无法自动补): ${aiaMissing} · 下载/解析失败: ${dlFail} · subject 不匹配(丢弃): ${mismatch}`);
  console.log(`收集到去重中间证书: ${pems.length} 张`);
  for (const [pem, m] of pemSet) console.log(`  · ${m.subject}  (来自 ${m.host})`);

  await mkdir(P("state"), { recursive: true });
  await writeFile(OUT, pems.join("\n"), "utf8");
  console.log(`\n已写出 ${OUT}`);

  // 复验:用 bundle 补链,rejectUnauthorized=true 再连一遍
  const ca = [...tls.rootCertificates, ...pems];
  const verify = (host) => new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, ca, rejectUnauthorized: true, timeout: TIMEOUT_MS });
    sock.once("secureConnect", () => { try { sock.destroy(); } catch (e) {} resolve(true); });
    sock.once("timeout", () => { try { sock.destroy(); } catch (e) {} resolve(false); });
    sock.once("error", () => { try { sock.destroy(); } catch (e) {} resolve(false); });
  });
  const before = needFix.length;
  const results = await pool(needFix.map(p => p.host), CONCURRENCY, verify);
  const after = results.filter(Boolean).length;
  console.log(`\n复验(开启校验): 修复前可用 0 / ${before} → 修复后可用 ${after} / ${before}`);
  const stillBad = needFix.map(p => p.host).filter((h, i) => !results[i]);
  if (stillBad.length) console.log("仍不可用: " + stillBad.slice(0, 20).join(", ") + (stillBad.length > 20 ? ` …共${stillBad.length}` : ""));
}

main().catch(e => { console.error("ca-bootstrap 失败:", e); process.exit(1); });