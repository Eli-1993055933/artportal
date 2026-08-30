// _tmp-cn-opp-insert.mjs —— 官方机会批量入库(带无头浏览器渲染降级)
// 输入:URL 列表文件(默认 _tmp-cn-batch7.txt,每行 URL [可选 # 说明])
// 处理:空闲先 fetchSource;拿不到足量正文(len<200)则用 Puppeteer(renderPage)渲染 JS 后再抓;
//       渲染得到的正文走 extract→verifyRecord→finalizeRecord→入库(与 _tmp-cn-verify-insert.mjs 同逻辑,含 evidence 校验)。
// 目的:突破政企/美术馆站 JS 空壳与部分反爬,让官方机会能走 evidence 管线入库。
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource, htmlToText } from "./lib/fetch.mjs";
import { extract } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import { dedupe } from "./lib/dedupe.mjs";
import { renderPage, closeBrowser } from "./lib/render.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
import { readFileSync as _rf } from "node:fs";
try {
  const _env = _rf(join(__dir, ".env"), "utf8");
  for (const _l of _env.split(/\r?\n/)) {
    const _m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(_l);
    if (_m && !_l.trim().startsWith("#") && process.env[_m[1]] == null) process.env[_m[1]] = _m[2];
  }
} catch (e) { process.stderr.write("[opp-insert] 未找到 .env(" + e.message + ")\n"); }
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const URL_FILE = new URL(process.env.URL_FILE || "./_tmp-cn-batch7.txt", import.meta.url);
const URLS = _rf(URL_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));

function todayISO() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
}
function computeStatus(deadline) {
  if (!deadline) return "open";
  return String(deadline).slice(0, 10) < todayISO() ? "expired" : "open";
}
function finalizeRecord(rec, { domain, url }) {
  const id = "search-" + domain.split(".")[0] + "-" + slug(rec.title_zh || rec.title_en || "item");
  return {
    id, category: rec.category || "opencall",
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
    url, source_url: url, domain,
    org_type: "official", trust: "auto",
    status: computeStatus(rec.deadline),
    verified_at: null, first_seen: todayISO(), last_seen: todayISO(), updated_at: todayISO(), _via: "search"
  };
}

// 抓正文:纯 fetch,正文不足则浏览器渲染再抓
async function fetchBody(u) {
  const u0 = u.split("#")[0];
  let host; try { host = new URL(u0).host; } catch (e) { return { u: u0, host: null, text: "", skipped: true, reason: "bad-url" }; }
  const f = await fetchSource({ url: u0, domain: host, type: "html" }, null, { timeoutMs: 10000 });
  let text = (f && f.text) ? f.text : "";
  let used = f ? ("fetch:" + (f.skipped ? f.reason : text.length)) : "fetch:fail";
  if (!f || f.skipped || text.length < 200 || f.status === 403 || f.status === 412 || f.status === 400) {
    // 渲染降级:绕过 JS 空壳 / http-403/412/400 等简单反爬
    try {
      const r = await renderPage(u0, { timeout: 25000, settleMs: 1800 });
      if (r && r.ok && r.body) { text = htmlToText(r.body); used = "render"; }
      else { used = "render-fail(" + (r && r.status) + ")"; }
    } catch (e) { used = "render-err(" + (e.name || e.message || "").slice(0, 30) + ")"; }
  }
  return { u: u0, host, text, skipped: false, reason: used };
}

async function main() {
  if (!URLS.length) { console.error("URLS 为空,请填充 " + URL_FILE.pathname); process.exit(1); }
  const existing = JSON.parse(await readFile(DATA, "utf8"));
  const existUrls = new Set((existing.opportunities || []).map(o => (o.url || "").split("#")[0]));
  const out = [];
  let dropped = 0, err = 0, rendered = 0, already = 0;
  for (const line of URLS) {
    const u0 = line.split("#")[0].trim();
    if (!u0) continue;
    if (existUrls.has(u0)) { already++; console.log("skip(已入库) " + u0); continue; }
    let host;
    try { host = new URL(u0).host; const domain = host.replace(/^www\./, ""); }
    catch (e) { err++; console.log("bad-url " + u0); continue; }
    const domain = host.replace(/^www\./, "");
    try {
      const f = await fetchBody(u0);
      if (!f.host || !f.text || f.text.length < 200) { dropped++; console.log(`skip(页面空|len=${f.text.length}) ${u0}`); continue; }
      const used = f.reason;
      const ex = await extract(f.text, { org_zh: "", domain, url: u0, source_url: u0, sourceText: f.text });
      if (!ex.data || ex.data.applicable === false) { dropped++; console.log("drop(不适用) " + domain); continue; }
      const v = verifyRecord(ex.data, { sourceText: f.text, url: u0, source_url: u0, domain });
      if (v.dropped) { dropped++; console.log("drop(" + (v.dropReason || "").slice(0, 40) + ") " + domain); continue; }
      const rec = finalizeRecord(v.record, { domain, url: u0 });
      console.log(`✓ ${rec.title_zh} | dl=${rec.deadline || "?"} | ${domain} [${used}]`);
      out.push(rec);
    } catch (e) { err++; console.log("ERR " + domain + " " + e.message); }
  }
  await closeBrowser();
  if (!out.length) { console.log("\n无新增(渲染降级仍未突破)"); return; }
  const byId = new Map((existing.opportunities || []).map(o => [o.id, o]));
  for (const r of out) byId.set(r.id, r);
  const dd = dedupe(Array.from(byId.values()));
  const finalList = dd.list;
  const tmp = DATA + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify({ _meta: existing._meta || {}, generated_at: new Date().toISOString().slice(0, 10), count: finalList.length, opportunities: finalList }, null, 2), "utf8");
  await rename(tmp, DATA);
  console.log(`\n完成: 新增 ${out.length}, 丢弃 ${dropped}, 错误 ${err}, 已入库跳过 ${already}, 总数 ${finalList.length}`);
}
main().catch(async e => { await closeBrowser().catch(() => {}); console.error("FATAL:", e.message); process.exit(1); });