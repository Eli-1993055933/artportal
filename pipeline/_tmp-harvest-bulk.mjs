// _tmp-harvest-bulk.mjs —— 高效并发批量收割脚本
// 设计:并行 5 个不同域名的源,详情页提取并发 3,每源约 60-90s 产出 8-10 条
// 跳过:官网定位/sitemap/geo兜底/哈希缓存/sources回写(纯收割,后续每日抓取自有)
import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";
import { extract, estimateCost } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import { gradeTrust } from "./lib/trust.mjs";
import { dedupe } from "./lib/dedupe.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const P = s => join(__dir, s);

const CONCURRENT_SOURCES = 5;  // 同时跑 5 个不同域名源
const CONCURRENT_EXTRACT = 3;  // 提取并发数
const DETAIL_CAP = 10;         // 每源最多详情页
const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const onlyIds = (getOpt("--only") || "").split(",").map(s => s.trim()).filter(Boolean);   // 指定源覆盖 TARGET_IDS
const detailCap = Math.max(1, parseInt(getOpt("--cap") || String(DETAIL_CAP), 10) || DETAIL_CAP);

// 目标源:TRUSTED_PLATFORMS 目录页优先 + 高分国际驻留/奖项
const TARGET_IDS = [
  // Phase 1: 可信平台目录页(已验证高产)
  "curatorspace-opportunities",   // ~9条
  "artconnect-opportunities",     // ~10条
  "eflux-opencalls",              // ~1-5条(announcements 混合)
  "transartists-calls",           // 403,但试试
  "chinaresidencies-directory",   // 驻留目录
  // Phase 2: 高分国际驻留/奖项源
  "macdowell-known",              // MacDowell 驻留
  "iscp-known",                   // ISCP 驻留
  "civitella-ranieri-founda-known", // Civitella 驻留
  "akademie-schloss-solitud-known", // 孤独城堡学院
  "royaumont-known",              // Royaumont 驻留
  "pact-zollverein-known",        // PACT Zollverein
  "aec-opencalls",                // Ars Electronica
  "documenta-known",              // documenta
  "hkadc-cfa",                    // 香港ADC
  "transmediale-feed",            // transmediale
  "gasworks-opportunities",       // Gasworks
  "rijksakademie-apply",          // Rijksakademie
  "cite-appels",                  // Cité des Arts
  "portugal-gulbenkian",          // Gulbenkian
  "na-res-bemis",                 // Bemis
  "na-res-headlands",             // Headlands
  "na-res-vermont-studio-center", // Vermont Studio Center
  "kala-auto",                    // Kala
  "hammer-auto",                  // Hammer
  "lacma-auto",                   // LACMA
  "mam-auto",                     // MAM
  "nyuad-auto",                   // NYU Abu Dhabi
  "singaporeartmuseum-auto",      // 新加坡美术馆
  "sydney-auto",                  // 悉尼
  "melbourne-auto",               // 墨尔本
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 与 run.mjs 同款 finalize:id 方案一致、补全前端 schema 需要的字段
function todayISO() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function slug(s) {
  return String(s || "").toLowerCase().replace(/[^\w一-龥]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
}
function computeStatus(deadline) {
  if (!deadline) return "open";
  return String(deadline).slice(0, 10) < todayISO() ? "expired" : "open";
}
function finalizeRecord(rec, src) {
  const today = todayISO();
  const id = rec.id || (src.id + "-" + slug(rec.title_zh || rec.title_en || "item"));
  return {
    id,
    category: rec.category || null,
    title_zh: rec.title_zh || null, title_en: rec.title_en || null,
    org_zh: rec.org_zh || src.org_zh || null,
    city_zh: rec.city_zh || "未知", country_zh: rec.country_zh || "未知",
    deadline: rec.deadline || null, deadline_note: rec.deadline_note || "",
    apply_fee: rec.apply_fee || { free: null, amount: null, currency: null },
    participation_fee: rec.participation_fee || { required: null, amount: null, currency: null },
    funding: rec.funding || { stipend: null, housing: null, travel: null },
    eligibility: rec.eligibility || { students_ok: null, age_limit: null, nationality: null },
    disciplines: rec.disciplines || [],
    summary_zh: rec.summary_zh || null,
    url: rec.url, source_url: rec.source_url, domain: rec.domain,
    org_type: src.org_type || "official",
    trust: "auto",
    status: computeStatus(rec.deadline),
    verified_at: null, first_seen: today, last_seen: today, updated_at: today
  };
}

// 处理一个源
async function harvestSource(src, hashes) {
  const results = { srcId: src.id, added: 0, dropped: 0, errors: 0, records: [] };
  try {
    const f = await fetchSource(src, null);
    if (f.skipped) { results.errors++; return results; }
    if (f.isRss) {
      const items = f.text.split(/\n\n---\n\n/).slice(0, detailCap);
      for (const item of items) {
        const ex = await extract(item, { org_zh: src.org_zh, domain: src.domain, url: src.url, source_url: src.url, sourceText: item });
        if (!ex.data || ex.data.applicable === false) { results.dropped++; continue; }
        const v = verifyRecord(ex.data, { org_zh: src.org_zh, domain: src.domain, url: src.url, source_url: src.url, sourceText: item });
        if (v.dropped) { results.dropped++; continue; }
        results.records.push(finalizeRecord(v.record, src));
        results.added++;
      }
      return results;
    }
    // 列表页 → 详情链接
    const links = discoverDetailLinks(f.rawHtml, src.url, src.domain, { cap: detailCap });
    if (!links.length) {
      // 无详情链接 → 整页作一条
      const ex = await extract(f.text, { org_zh: src.org_zh, domain: src.domain, url: src.url, source_url: src.url, sourceText: f.text });
      if (ex.data && ex.data.applicable !== false) {
        const v = verifyRecord(ex.data, { org_zh: src.org_zh, domain: src.domain, url: src.url, source_url: src.url, sourceText: f.text });
        if (!v.dropped) { results.records.push(finalizeRecord(v.record, src)); results.added++; }
        else results.dropped++;
      } else results.dropped++;
      return results;
    }
    // 抓取详情页(串行,同域限速)
    const candidates = [];
    for (const ln of links) {
      const df = await fetchSource({ url: ln.url, domain: src.domain, type: "html" }, null);
      if (df.skipped || df.notModified) continue;
      if (hashes[ln.url] && hashes[ln.url] === df.hash) continue;
      hashes[ln.url] = df.hash;
      candidates.push({ sourceText: df.text, url: ln.url, rawHtml: df.rawHtml });
    }
    if (!candidates.length) { results.dropped++; return results; }
    // 并发提取(简单 worker 池)
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENT_EXTRACT, candidates.length) }, async () => {
      while (idx < candidates.length) {
        const cand = candidates[idx++];
        const ctx = { org_zh: src.org_zh, domain: src.domain, url: cand.url, source_url: src.url, sourceText: cand.sourceText };
        try {
          const ex = await extract(cand.sourceText, ctx);
          if (!ex.data || ex.data.applicable === false) { results.dropped++; continue; }
          const v = verifyRecord(ex.data, ctx);
          if (v.dropped) { results.dropped++; continue; }
          if (cand.rawHtml) {
            const m = cand.rawHtml.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']*)["']/i);
            if (m) { v.record.cover = m[1]; v.record.cover_source = src.domain; }
          }
          results.records.push(finalizeRecord(v.record, src));
          results.added++;
        } catch (e) { results.errors++; }
      }
    });
    await Promise.all(workers);
  } catch (e) { results.errors++; }
  return results;
}

async function main() {
  const sourcesDoc = JSON.parse(await readFile(P("sources.json"), "utf8"));
  const allSources = sourcesDoc.sources.filter(s => s.reachable !== false);
  // 按目标 ID 顺序排列
  let allTargets = onlyIds.length
    ? onlyIds.map(id => allSources.find(s => s.id === id)).filter(Boolean)
    : TARGET_IDS.map(id => allSources.find(s => s.id === id)).filter(Boolean);
  // 未指定 onlyIds 时,从其他高分源随机补充
  if (!onlyIds.length) {
    const otherHi = allSources.filter(s => !TARGET_IDS.includes(s.id) && 
      /opencall|residency|award|grant|competition|biennale|fellowship|artist-in-residence/i.test((s.category_hint || []).join(",")) &&
      s.domain && !/\.cn$/i.test(s.domain));
    // 从其他高分源中随机补充
    const extra = otherHi.sort(() => Math.random() - 0.5).slice(0, 10);
    allTargets = [...allTargets, ...extra];
  }
  console.log("目标源数:", allTargets.length);
  console.log("包括:", allTargets.map(s => s.id).join(", "));
  console.log("");

  const hashes = {};
  const allRecords = [];
  let totalAdded = 0, totalDropped = 0, totalErrors = 0;
  const t0 = Date.now();

  // 分批并行(每批不同域名,避免同域限速冲突)
  // 同域源必须分配到不同批次,绝不能跳过,否则会造成遗漏
  const buckets = [];
  for (const s of allTargets) {
    let placed = false;
    for (const b of buckets) {
      if (!b.some(x => x.domain === s.domain)) { b.push(s); placed = true; break; }
    }
    if (!placed) buckets.push([s]);
  }
  let batchNo = 0;
  for (const batchTargets of buckets) {
    batchNo++;
    console.log(`\n=== 批次 ${batchNo} ===`);
    const batchResults = await Promise.all(batchTargets.map(s => harvestSource(s, hashes)));
    for (const r of batchResults) {
      totalAdded += r.added;
      totalDropped += r.dropped;
      totalErrors += r.errors;
      allRecords.push(...r.records);
      console.log(`  ${r.srcId}: +${r.added} 丢弃${r.dropped} 错误${r.errors}`);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`  累计: +${totalAdded} | 已用 ${elapsed}s`);
  }

  // 去重并合并到现有数据
  const existing = JSON.parse(await readFile(DATA, "utf8"));
  const byId = new Map((existing.opportunities || []).map(o => [o.id, o]));
  for (const r of allRecords) {
    const prev = byId.get(r.id);
    if (prev && prev.trust === "verified") continue;
    if (prev && prev.first_seen) r.first_seen = prev.first_seen;
    byId.set(r.id, r);
  }
  const dd = dedupe(Array.from(byId.values()));
  const finalList = dd.list;

  // 原子写库
  const tmp = DATA + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify({ _meta: existing._meta || {}, generated_at: new Date().toISOString().slice(0, 10), count: finalList.length, opportunities: finalList }, null, 2), "utf8");
  await rename(tmp, DATA);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log("\n====== 收割完成 ======");
  console.log("新增:", totalAdded, "| 丢弃:", totalDropped, "| 错误:", totalErrors);
  console.log("去重后总数:", finalList.length, "(之前:", (existing.opportunities || []).length, ")");
  console.log("净增:", finalList.length - (existing.opportunities || []).length);
  console.log("用时:", elapsed, "秒");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });