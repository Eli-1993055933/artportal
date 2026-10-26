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

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
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

  // 与**已有 bundle 取并集**写回,绝不因为"本次没扫到"就把已有的修复清空。
  // 2026-10-03 教训:原实现是直接覆盖写,而探测会因网络抖动/站点超时漏掉域名 —— 那天 381 个
  // 域名有 129 个连不上、"链长=1"判为 0,于是写出一个 **0 字节**的 pem,把前一天刚修好的
  // cafa.edu.cn 又打回原样(表现为 fetch-error TypeError)。中间证书"多一张通常无妨"(故并集最稳),
  // 但**个别自签中间证书会反而破坏其它站点的链**——见下方面向 AI 端点的金丝雀自检。
  const existing = await readFile(OUT, "utf8").catch(() => "");
  const havePems = new Set(existing.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || []);
  const carried = havePems.size;
  for (const pem of pems) havePems.add(pem);
  let bundle = [...havePems];

  // —— 金丝雀自检(2026-10-26)——
  // 中间证书并非"多一张无妨":实测 TrustAsia DV TLS RSA CA 2024 这张自签中间证书一进 bundle,
  // NODE_EXTRA_CA_CERTS 会让 open.bigmodel.cn 的链解析失败(UNABLE_TO_GET_ISSUER_CERT)——
  // 免费大模型兜底全线死掉,而 DeepSeek 又恰好欠费,于是每日采集"跑成功但零新增"整整 8 天。
  // 对策:写盘前先用关键 AI 端点验一遍;哪张证书会让这些端点验不过,就从 bundle 剔除(宁可少补一个站,不可断采集)。
  const CANARY_HOSTS = [
    process.env.MOD_API_HOST || "open.bigmodel.cn",
    "api.deepseek.com",
    "dashscope.aliyuncs.com",
    "api.siliconflow.cn"
  ];
  // ⚠ 关键:必须用 NODE_EXTRA_CA_CERTS 的真实语义去验,而不是 ca 数组。
  //   实测同一张 TrustAsia DV TLS RSA CA 2024:放进 ca 数组能过,放进 NODE_EXTRA_CA_CERTS 就
  //   报 UNABLE_TO_GET_ISSUER_CERT(追加信任不启用 partial-chain,链必须走到根)。
  //   所以这里写临时 pem + 起子进程(child 里带 NODE_EXTRA_CA_CERTS)复现生产环境。
  const testBundle = (pems) => new Promise((resolve) => {
    const tmp = join(tmpdir(), "ca-canary-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".pem");
    const code = 'const tls=require("node:tls");const hosts=JSON.parse(process.argv[1]);' +
      '(async()=>{const out=[];for(const h of hosts){out.push({host:h,ok:await new Promise(r=>{' +
      'const s=tls.connect({host:h,port:443,servername:h,rejectUnauthorized:true,timeout:8000});' +
      'const d=v=>{try{s.destroy()}catch(e){};r(v)};s.once("secureConnect",()=>d(true));' +
      's.once("timeout",()=>d(false));s.once("error",()=>d(false))})})}' +
      'process.stdout.write(JSON.stringify(out))})()';
    writeFile(tmp, pems.join("\n") + "\n", "utf8").then(() => {
      const p = spawn(process.execPath, ["-e", code, JSON.stringify(CANARY_HOSTS)], {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: tmp }, stdio: ["ignore", "pipe", "ignore"]
      });
      let buf = "";
      p.stdout.on("data", d => { buf += d; });
      p.on("close", async () => {
        await rm(tmp, { force: true });
        try { resolve(JSON.parse(buf)); } catch (e) { resolve(CANARY_HOSTS.map(host => ({ host, ok: false }))); }
      });
      p.on("error", async () => { await rm(tmp, { force: true }); resolve(CANARY_HOSTS.map(host => ({ host, ok: false }))); });
    });
  });
  const failures = async (pems) => (await testBundle(pems)).filter(r => !r.ok).map(r => r.host);

  // 逐张判定:单独放进 NODE_EXTRA_CA_CERTS 就让某个金丝雀验不过 → 它有罪,剔除。
  // (组合式贪心会被一次网络抖动带偏,曾把 8 张全删光;单独判定稳定。)
  const removed = [];
  for (const pem of [...new Set(bundle)]) {          // 先去重(实测同一张证书会被并集写入两次)
    const bad = await failures([pem]);
    if (bad.length) { removed.push({ pem, bad }); bundle = bundle.filter(x => x !== pem); }
  }
  bundle = [...new Set(bundle)];
  if (removed.length) {
    console.log(`\n⚠ 金丝雀自检:剔除 ${removed.length} 张会破坏 AI 端点链的证书(宁可少补一个站,不可断采集)`);
    for (const { pem, bad } of removed) {
      const sub = (() => { try { return new X509Certificate(pem).subject.replace(/\n/g, " "); } catch (e) { return "(无法解析)"; } })();
      console.log(`  · 已剔除(${bad.join(",")}): ` + sub);
    }
  }
  // 剔除后再全量验一次;仍有不通的 → 清空 bundle(不带附加 CA 最安全,采集优先)
  const canaryStillBad = await failures(bundle);
  if (canaryStillBad.length) {
    console.log(`⚠ 剔除后 ${canaryStillBad.join(",")} 仍验不过 → 本轮清空 bundle(不带附加 CA)`);
    bundle = [];
  }

  if (!bundle.length) {
    console.log("⚠ 本次未收集到中间证书,且已有 bundle 也是空的 —— 不写文件(维持无附加 CA 的状态)");
  } else {
    await mkdir(P("state"), { recursive: true });
    await writeFile(OUT, bundle.join("\n") + "\n", "utf8");
    console.log(`\n已写出 ${OUT}(沿用原有 ${carried} 张 + 本次新增 ${bundle.length - carried} 张 = 共 ${bundle.length} 张)`);
  }

  // 复验:用 bundle 补链,rejectUnauthorized=true 再连一遍
  const ca = [...tls.rootCertificates, ...bundle];
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