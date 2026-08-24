// _tmp-cn-verify-insert.mjs —— 官网核准批量入库脚本
// 输入:本地 URLs 数组(来自人工/检索识别的国内官方征稿页)
// 处理:fetchSource→extract→verifyRecord→finalizeRecord→入库(复用 harvest-bulk 同款逻辑)
// 用途:检索源全挂时,把已人工核实的官方征稿 URL 走管线核验入库,保证 evidence 合规。
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource } from "./lib/fetch.mjs";
import { extract } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import { dedupe } from "./lib/dedupe.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");

function todayISO() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
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
    url, source_url: url, domain,
    org_type: "official",
    trust: "auto",
    status: computeStatus(rec.deadline),
    verified_at: null, first_seen: todayISO(), last_seen: todayISO(), updated_at: todayISO(), _via: "search"
  };
}

// —— 人工/检索核实的国内官方征稿页(org.cn 官方域名,evidence 在原文) ——
import { readFileSync } from "node:fs";
const URL_FILE = new URL("./_tmp-cn-urls.txt", import.meta.url);
const URLS = readFileSync(URL_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));

async function main() {
  if (!URLS.length) { console.error("URLS 为空,请填充 _tmp-cn-urls.txt"); process.exit(1); }
  const existing = JSON.parse(await readFile(DATA, "utf8"));
  const existUrls = new Set(existing.opportunities.map(o => (o.url || "").split("#")[0]));
  const out = [];
  let dropped = 0, err = 0;
  for (const url of URLS) {
    const u = url.split("#")[0];
    if (existUrls.has(u)) { console.log("skip(已入库) " + u); continue; }
    const host = new URL(u).host;
    const domain = host.replace(/^www\./, "");
    try {
      const f = await fetchSource({ url: u, domain: host, type: "html" }, null);
      if (f.skipped || !f.text || f.text.length < 200) { dropped++; console.log("skip(页面薄) " + domain); continue; }
      const ex = await extract(f.text, { org_zh: "", domain, url: u, source_url: u, sourceText: f.text });
      if (!ex.data || ex.data.applicable === false) { dropped++; console.log("drop(不适用) " + domain); continue; }
      const v = verifyRecord(ex.data, { sourceText: f.text, url: u, source_url: u, domain });
      if (v.dropped) { dropped++; console.log("drop(校验) " + domain + " " + (v.dropReason || "").slice(0, 40)); continue; }
      const rec = finalizeRecord(v.record, { domain, url: u });
      console.log(`✓ ${rec.title_zh} | dl=${rec.deadline || "?"} | ${domain}`);
      out.push(rec);
    } catch (e) { err++; console.log("ERR " + domain + " " + e.message); }
  }
  if (!out.length) { console.log("\n无新增"); return; }
  const byId = new Map((existing.opportunities || []).map(o => [o.id, o]));
  for (const r of out) byId.set(r.id, r);
  const dd = dedupe(Array.from(byId.values()));
  const finalList = dd.list;
  const tmp = DATA + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify({ _meta: existing._meta || {}, generated_at: new Date().toISOString().slice(0, 10), count: finalList.length, opportunities: finalList }, null, 2), "utf8");
  await rename(tmp, DATA);
  console.log(`\n完成: 新增 ${out.length}, 丢弃 ${dropped}, 错误 ${err}, 总数 ${finalList.length}`);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });