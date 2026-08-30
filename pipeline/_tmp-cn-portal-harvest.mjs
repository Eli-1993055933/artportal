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
import { dedupe } from "./lib/dedupe.mjs";

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
const allowed = new Set([
  "www.henanshengmeixie.com",      // 河南美协
  "www.lnwyw.org.cn",              // 辽宁文艺网(走 /gsgd 公示公告栏目)
  "www.namoc.cn",                  // 中国美术馆公告
  "www.gxau.edu.cn",               // 广西艺术学院
  "design.gxau.edu.cn",
  "msy.ksu.edu.cn",                // 喀什大学美院
  "www.hnmsg.net",                 // 湖南美术馆
  "www.lnmsg.com",                 // 辽宁美术馆展览预告
  "www.ynmsg.cn",                  // 云南美术馆
  "www.dha.ac.cn",                 // 敦煌研究院
]);
const DISCOVER_CAP = 20;           // 每源最多详情链接
const DETAIL_CAP = 8;              // 每源最多入库详情数

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
  // 与现有合并去重写库
  const byId = new Map((existing.opportunities || []).map(o => [o.id, o]));
  for (const r of out) byId.set(r.id, r);
  const dd = dedupe(Array.from(byId.values()));
  const tmp = DATA + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify({ _meta: existing._meta || {}, generated_at: new Date().toISOString().slice(0, 10), count: dd.list.length, opportunities: dd.list }, null, 2), "utf8");
  await rename(tmp, DATA);
  console.log(`\n完成: 新增 ${out.length}, 丢弃 ${totalDropped}, 错误 ${totalErr}, 总数 ${dd.list.length}`);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });