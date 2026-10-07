// _tmp-cn-portal-harvest.mjs —— 门户列表页 discover 批量收割(国内官方征稿源,一源多条)
// 对每个源:fetch 列表页 → discoverDetailLinks 找同域详情 → 逐条 fetch → extract → verify → finalize → 入库
// 仅用于已核实的高产征稿门户(河南美协/辽宁文艺网/中国美术馆/广西艺院/喀什/甘肃书协等)。
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, rename } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";
import { extract } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import { normUrl } from "./lib/dedupe.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// 加载 .env
try {
  const _e = readFileSync(join(__dir, ".env"), "utf8");
  for (const _l of _e.split(/\r?\n/)) {
    const _m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(_l);
    if (_m && !_l.trim().startsWith("#") && process.env[_m[1]] == null) process.env[_m[1]] = _m[2];
  }
} catch (e) {}
const DATA = join(__dir, "..", "site", "data", "opportunities.json");

const SRC_FILE = join(__dir, "_tmp-cn-portal-srcs.txt");
const LIST_URLS = readFileSync(SRC_FILE, "utf8")
  .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"))
  .map(l => l.split("\t")[0].split("#")[0].trim());
// 白名单 = 清单文件里出现的全部主机(该清单已人工核实,放开到全量做一次彻底收割)
const allowed = new Set(LIST_URLS.map(u => { try { return new URL(u).host; } catch (e) { return null; } }).filter(Boolean));
const DISCOVER_CAP = 30;           // 每源最多详情链接
const DETAIL_CAP = 12;             // 每源最多入库详情数

function todayISO() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function slug(s) { return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item"; }
function computeStatus(deadline) {
  if (!deadline) return "open";
  return String(deadline).slice(0, 10) < todayISO() ? "expired" : "open";
}
function finalizeRecord(rec, { domain, url, srcUrl }) {
  const id = "search-" + domain.split(".")[0] + "-" + slug(rec.title_zh || rec.title_en || "item");
  return {
    id,
    category: rec.category || "opencall",
    title_zh: rec.title_zh || null, title_en: rec.title_en || null,
    org_zh: rec.org_zh || null,
    city_zh: rec.city_zh || "未知", country_zh: rec.country_zh || "中国",
    deadline: rec.deadline || null, deadline_note: rec.deadline_note || "",
    apply_fee: rec.apply_fee || { free: null, amount: null, currency: null },
    participation_fee: rec.participation_fee || { required: null, amount: null, currency: null },
    funding: rec.funding || { stipend: null, housing: null, travel: null },
    eligibility: rec.eligibility || { students_ok: null, age_limit: null, nationality: null },
    disciplines: rec.disciplines || [],
    summary_zh: rec.summary_zh || null,
    url, source_url: srcUrl || url, domain,
    org_type: "official", trust: "auto",
    status: computeStatus(rec.deadline),
    verified_at: null, first_seen: todayISO(), last_seen: todayISO(), updated_at: todayISO(), _via: "search"
  };
}

async function main() {
  const existing = JSON.parse(await readFile(DATA, "utf8"));
  const existUrls = new Set((existing.opportunities || []).map(o => (o.url || "").split("#")[0]));
  const out = [];
  let totalDropped = 0, totalErr = 0;

  for (const listUrl of LIST_URLS) {
    let host; try { host = new URL(listUrl).host; } catch (e) { continue; }
    const domain = host.replace(/^www\./, "");
    if (!allowed.has(host) && !allowed.has(domain)) continue;   // 只跑已确认高产源
    let f;
    try { f = await fetchSource({ url: listUrl, domain: host, type: "html" }, null, { timeoutMs: 10000 }); }
    catch (e) { totalErr++; console.log(`SRC-ERR ${domain}`); continue; }
    if (f.skipped || !f.rawHtml) { console.log(`SRC-skip ${domain} (${f && f.reason})`); continue; }
    const links = discoverDetailLinks(f.rawHtml, listUrl, domain, { cap: DISCOVER_CAP });
    // 过滤:只保留文本像征稿/展览/招募/大赛/驻留的详情
    const opp = links.filter(l => /(征集|征稿|招募|驻留|双年展|三年展|大赛|展览|申报|推优|人才培养|作品展)/.test(l.text || ""));
    console.log(`\n=== ${domain}: 详情 ${links.length}, 征稿类 ${opp.length} ===`);
    let added = 0;
    for (const l of opp) {
      if (added >= DETAIL_CAP) break;
      const u0 = (l.url || "").split("#")[0];
      if (existUrls.has(u0)) { console.log(`  skip(已入库) ${u0}`); continue; }
      let df;
      try { df = await fetchSource({ url: u0, domain: host, type: "html" }, null, { timeoutMs: 10000 }); }
      catch (e) { totalErr++; continue; }
      if (df.skipped || !df.text || df.text.length < 200) { totalDropped++; console.log(`  skip(薄|len=${(df&&df.text)||0}) ${u0}`); continue; }
      try {
        const ex = await extract(df.text, { org_zh: "", domain, url: u0, source_url: listUrl, sourceText: df.text });
        if (!ex.data || ex.data.applicable === false) { totalDropped++; console.log(`  drop(不适用) ${domain} ${(l.text||"").slice(0,20)}`); continue; }
        const v = verifyRecord(ex.data, { sourceText: df.text, url: u0, source_url: listUrl, domain });
        if (v.dropped) { totalDropped++; console.log(`  drop(${String(v.dropReason||"").slice(0,30)}) ${(l.text||"").slice(0,20)}`); continue; }
        const rec = finalizeRecord(v.record, { domain, url: u0, srcUrl: listUrl });
        console.log(`  ✓ ${rec.title_zh} | dl=${rec.deadline||"?"}`);
        out.push(rec); added++;
      } catch (e) { totalErr++; console.log(`  ERR ${domain}: ${String(e.message||e).slice(0,50)}`); }
    }
  }

  if (!out.length) { console.log("\n无新增"); return; }
  // 【只追加、绝不删既有条目】——早先这里对整库跑 dedupe(),会把同域近似条目(curatorspace/artconnect 等)
  // 当重复合并掉,造成既有数据静默丢失(2026-10-03 实测丢 6 条)。改为:按 id + URL 归一化,只并入新条目。
  const cur = existing;
  const ids = new Set((cur.opportunities || []).map(o => o.id));
  const urls = new Set((cur.opportunities || []).map(o => normUrl(o.url)));
  let saved = 0;
  for (const r of out) {
    if (ids.has(r.id)) continue;
    const nu = normUrl(r.url);
    if (nu && urls.has(nu)) continue;
    cur.opportunities.push(r); ids.add(r.id); urls.add(nu); saved++;
  }
  cur.count = cur.opportunities.length;
  cur.generated_at = new Date().toISOString().slice(0, 10);
  const tmp = DATA + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(cur, null, 2), "utf8");
  await rename(tmp, DATA);
  console.log(`\n完成: 新增 ${saved}, 丢弃 ${totalDropped}, 错误 ${totalErr}, 总数 ${cur.count}`);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });