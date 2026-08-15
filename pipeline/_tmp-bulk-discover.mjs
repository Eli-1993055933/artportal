// _tmp-bulk-discover.mjs —— 搜索引擎批量发现收割(一次性冲刺 200+ 条用)
// 思路:复用 server.mjs 里 searchAndHarvest 的核心闭环(搜索→过滤→抓原文→GLM 提取→
// evidence 逐字校验→要求有 deadline 才入库),但改成「先集中把词跑完、再并发抓取候选」的批量模式。
// 来源:regions.json 里 16 位区域经理的 205 条成品查询词 + 补充一批国际通用词。
// 预算:Brave 50/天 + Serper 12/天(先 Brave 后 Serper 后 DDG 免费降级),本脚本默认跑 55 词。
// 用法:node --env-file=.env _tmp-bulk-discover.mjs [--queries N] [--cap C] [--who label]
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { searchWeb, BLOCK, unsafeHost } from "./lib/websearch.mjs";
import { isThirdParty, isTrustedPlatform, hostOf } from "./lib/aggregators.mjs";
import { fetchSource } from "./lib/fetch.mjs";
import { extract } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import { fillGeoFallback } from "./lib/geolocation-fallback.mjs";
import { normUrl } from "./lib/dedupe.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const P = s => join(__dir, s);

const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const QUERY_N = Math.max(1, parseInt(getOpt("--queries") || "55", 10) || 55);
const POOL_CAP = Math.max(50, parseInt(getOpt("--cap") || "350", 10) || 350);   // 候选抓取上限
const WHO = getOpt("--who") || "bulk-discover";
const CONCURRENT = 8;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
}
function computeStatus(deadline) {
  if (!deadline) return "open";
  const t = String(deadline).slice(0, 10);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  return t < today ? "closed" : "open";
}
function officialHint(u) {
  const h = hostOf(u);
  return /\.(org|edu|gov|museum|ac\.uk|org\.uk|cn)$/.test(h) ? 1 : 0;
}

// 全球通用补充词(不绑区域,gl=us/hl=en),补区域词池没覆盖的媒介/形式广度
const GENERIC = [
  { q: "artist residency open call 2026 apply deadline", gl: "us", hl: "en" },
  { q: "call for artists international exhibition 2026 submissions", gl: "us", hl: "en" },
  { q: "art prize award open call for submissions 2026", gl: "us", hl: "en" },
  { q: "photography open call exhibition apply 2026", gl: "us", hl: "en" },
  { q: "printmaking open call 2026 apply", gl: "us", hl: "en" },
  { q: "sculpture competition open call entries 2026", gl: "us", hl: "en" },
  { q: "new media art festival open call 2026", gl: "us", hl: "en" },
  { q: "performance art open call festival 2026", gl: "us", hl: "en" },
  { q: "painting award international open call 2026", gl: "us", hl: "en" },
  { q: "artist residency stipend fellowship 2026 apply", gl: "us", hl: "en" },
  { q: "visual arts grant for artists 2026 deadline apply", gl: "us", hl: "en" },
  { q: "biennale open call artists 2026", gl: "us", hl: "en" },
  { q: "open call Europe artist residency 2026", gl: "gb", hl: "en" },
  { q: "open call Germany artist residency 2026", gl: "de", hl: "en" },
  { q: "open call France residency art 2026 appel à candidatures", gl: "fr", hl: "en" },
  { q: "open call Japan art residency 2026", gl: "jp", hl: "en" },
  { q: "open call Korea art award 2026", gl: "kr", hl: "en" },
  { q: "open call Latin America art residency 2026", gl: "us", hl: "en" },
  { q: "open call Australia art prize 2026", gl: "au", hl: "en" },
  { q: "ceramics open call exhibition 2026 apply", gl: "us", hl: "en" },
];

async function main() {
  // 1) 组装词池:区域经理词(带 gl/hl) + 通用词
  const cfg = JSON.parse(await readFile(P("regions.json"), "utf8"));
  const pool = [];
  for (const m of (cfg.managers || [])) {
    for (const q of (m.queries || [])) {
      if (!q || !String(q).trim()) continue;
      pool.push({ q: String(q).trim(), gl: String(m.gl || "cn").toLowerCase(), hl: String(m.hl || "zh-cn") });
    }
  }
  pool.push(...GENERIC);
  // 打散顺序:让中国/国际交错,避免同语言同域候选扎堆
  const shuffled = [...new Map(pool.map(x => [x.q + "|" + x.gl, x])).values()];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const queries = shuffled.slice(0, QUERY_N);
  console.log("词池总数:", pool.length, "| 本轮执行:", queries.length, "词");

  // 2) 现有库(去重基底:URL 归一化 + id)
  const doc = JSON.parse(await readFile(DATA, "utf8"));
  const existUrls = new Set(doc.opportunities.map(o => normUrl(o.url)));
  const existIds = new Set(doc.opportunities.map(o => o.id));

  // 3) 集中搜索,收集候选 URL(去重 + 过滤)
  const seen = new Set(), cands = [];
  let searchCalls = 0;
  for (const item of queries) {
    let urls = [];
    try { urls = await searchWeb(item.q, { gl: item.gl, hl: item.hl, who: WHO }); }
    catch (e) { process.stderr.write(`  [搜索失败] ${item.q}: ${String(e.message || e).slice(0, 80)}\n`); }
    searchCalls++;
    if (cands.length >= POOL_CAP * 2) break;
    for (const u of urls || []) {
      let host; try { host = new URL(u).host; } catch (e) { continue; }
      if (BLOCK.test(u) || unsafeHost(host)) continue;
      if (isThirdParty(u) && !isTrustedPlatform(u)) continue;      // 杂志/新闻/转载/社媒一律不采
      const key = u.split("#")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      const nu = normUrl(key);
      if (nu && existUrls.has(nu)) continue;                       // 库里有,不用抓
      cands.push(key);
    }
    await sleep(700);                                              // 对搜索端点客气一点
  }
  console.log("搜索调用:", searchCalls, "| 候选 URL(去重后):", cands.length, "| 取前", Math.min(POOL_CAP, cands.length));
  cands.sort((a, b) => officialHint(b) - officialHint(a));         // 官网优先
  const targets = cands.slice(0, POOL_CAP);

  // 4) 并发抓取 + 提取 + 验证
  const results = { added: [], log: [], dropped: 0, errors: 0 };
  const sleep2 = sleep;
  // 带退避的提取(免费 GLM 偶发 429,别急着花 DeepSeek 钱)
  async function extractRetry(text, ctx) {
    for (let a = 0; a < 3; a++) {
      try { return await extract(text, ctx); }
      catch (e) {
        if (a < 2) await sleep2(1500 * (a + 1)); else throw e;
      }
    }
  }
  let idx = 0;
  const workers = Array.from({ length: CONCURRENT }, async () => {
    while (idx < targets.length) {
      const url = targets[idx++];
      let host; try { host = new URL(url).host; } catch (e) { continue; }
      const domain = host.replace(/^www\./, "");
      try {
        const f = await fetchSource({ url, domain: host, type: "html" });
        if (f.skipped || !f.text || f.text.length < 200) { results.dropped++; continue; }
        const ctx = { org_zh: "", domain: host, url, source_url: url, sourceText: f.text };
        const ex = await extractRetry(f.text, ctx);
        if (!ex || !ex.data || ex.data.applicable === false) { results.dropped++; continue; }
        const v = verifyRecord(ex.data, { sourceText: f.text, url, source_url: url, domain: host });
        if (v.dropped) { results.dropped++; continue; }
        if (!v.flags.hasDeadline) { results.dropped++; continue; }  // 检索路径无日期闸:没 deadline 不进库
        const rec = v.record;
        const geo = fillGeoFallback(rec, { domain, source_url: url }, f.text);
        const id = "search-" + domain.split(".")[0] + "-" + slug(rec.title_zh || rec.title_en || "item");
        const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
        const out = {
          id,
          category: rec.category || "opencall",
          title_zh: rec.title_zh || null, title_en: rec.title_en || null,
          org_zh: rec.org_zh || null,
          city_zh: geo.city_zh || "未知", country_zh: geo.country_zh || "未知",
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
          verified_at: null, first_seen: today, last_seen: today, updated_at: today, _via: "search"
        };
        if (existIds.has(id) || results.added.some(a => a.id === id)) { results.dropped++; continue; }
        results.added.push(out);
      } catch (e) { results.errors++; }
    }
  });
  await Promise.all(workers);

  // 5) 原子写库(URL 归一化再兜一道,防止并发内撞车)
  const cur = JSON.parse(await readFile(DATA, "utf8"));
  const ids = new Set(cur.opportunities.map(o => o.id));
  const urls = new Set(cur.opportunities.map(o => normUrl(o.url)));
  let saved = 0;
  const tmp = DATA + ".tmp-" + process.pid;
  for (const rec of results.added) {
    if (ids.has(rec.id)) continue;
    const nu = normUrl(rec.url);
    if (nu && urls.has(nu)) continue;
    cur.opportunities.push(rec); ids.add(rec.id); urls.add(nu); saved++;
  }
  cur.count = cur.opportunities.length;
  cur.generated_at = new Date().toISOString().slice(0, 10);
  await writeFile(tmp, JSON.stringify(cur, null, 2), "utf8");
  await rename(tmp, DATA);

  console.log("\n====== 批量发现完成 ======");
  console.log("词数:", queries.length, "| 候选:", targets.length);
  console.log("本次入库:", saved, "| 丢弃:", results.dropped, "| 错误:", results.errors);
  console.log("库总量:", cur.opportunities.length);
  console.log("新条目示例:");
  for (const r of results.added.slice(0, 8)) console.log("  -", r.title_zh || r.title_en, "|", r.deadline, "|", r.domain);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
