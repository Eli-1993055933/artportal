// run.mjs —— 数据管道主流程编排(需求第四节)。
//   抓取 → (哈希未变则跳过) → AI 提取 → 程序校验 evidence → 去重 → 信任分级 → 写盘 → 报告
//
// 用法:
//   node run.mjs                      跑全部信源(需 ANTHROPIC_API_KEY)
//   node run.mjs --only a,b           只跑指定信源 id
//   node run.mjs --fetch-only         只抓取,把原文存到 state/samples/(不调用 AI)
//   node run.mjs --health-only        只跑健康检查
//   环境 ARTPORTAL_OFFLINE_EXTRACT=<json>  用文件里的提取结果代替真实 API 调用(演示/离线用)
//
// 合规:抓取合规逻辑在 fetch.mjs / robots.mjs;evidence 硬校验在 verify.mjs。

import { readFile, writeFile, mkdir, appendFile, rename } from "node:fs/promises";
import { reportAgent } from "./lib/agent-report.mjs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";
import { extractCover, extractContentImages, looksGeneric } from "./lib/cover.mjs";
import { extract, estimateCost, parseJson } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import { dedupe } from "./lib/dedupe.mjs";
import { gradeTrust } from "./lib/trust.mjs";
import { healthCheck } from "./lib/healthcheck.mjs";
import { buildReport } from "./lib/report.mjs";
import { locateOfficial } from "./lib/locate-official.mjs";
import { isThirdParty } from "./lib/aggregators.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const P = (...p) => join(__dir, ...p);

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
// 每个信源最多向下钻取的详情页数量。首跑用 --cap 8 控成本;不传则默认 20。
const CAP = Math.max(1, parseInt(getOpt("--cap") || "20", 10) || 20);
const onlyIds = (getOpt("--only") || "").split(",").map(s => s.trim()).filter(Boolean);
const DATA = getOpt("--out") || P("..", "site", "data", "opportunities.json"); // --out 可指向演示输出,避免覆盖 seed

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { return fallback; } }

// 离线提取:从文件按 key 取预先算好的提取结果(演示用)。key = source.id + "#" + itemIndex
let OFFLINE = null;
async function getExtract(text, ctx, key) {
  if (process.env.ARTPORTAL_OFFLINE_EXTRACT) {
    if (!OFFLINE) OFFLINE = await readJson(process.env.ARTPORTAL_OFFLINE_EXTRACT, {});
    if (OFFLINE[key] == null) throw new Error("离线提取文件缺 key: " + key);
    return { data: OFFLINE[key], usage: { input_tokens: 0, output_tokens: 0 }, raw: JSON.stringify(OFFLINE[key]) };
  }
  return await extract(text, ctx);
}

async function main() {
  const sourcesPath = getOpt("--sources") || P("sources.json");
  const sourcesDoc = await readJson(sourcesPath, { sources: [] });
  let sources = sourcesDoc.sources.filter(s => s.reachable !== false);
  if (onlyIds.length) sources = sources.filter(s => onlyIds.includes(s.id));

  if (hasFlag("--health-only")) return runHealth();

  const hashes = await readJson(P("state", "hashes.json"), {});
  const stats = {
    at: new Date().toISOString(), sourcesTotal: sources.length, sourcesOk: 0, sourcesFailed: [],
    unchanged: 0, extracted: 0, added: 0, updated: 0, pending: 0, dropped: 0,
    hallucinations: 0, cost: 0, tokensIn: 0, tokensOut: 0
  };
  const autoRecords = [], pendingRecords = [];
  await mkdir(P("state", "samples"), { recursive: true });

  for (const src of sources) {
    process.stderr.write(`\n[抓取] ${src.id}  ${src.url}\n`);
    const f = await fetchSource(src);
    if (f.skipped) {
      stats.sourcesFailed.push({ id: src.id, reason: f.reason + (f.error ? (":" + f.error) : "") });
      process.stderr.write(`  跳过: ${f.reason}${f.error ? " " + f.error : ""}\n`);
      continue;
    }
    stats.sourcesOk++;
    process.stderr.write(`  状态 ${f.status} · robots=${f.robots} · 正文 ${f.text.length} 字 · hash ${f.hash.slice(0, 12)}\n`);

    // --fetch-only:存样本,不提取
    if (hasFlag("--fetch-only")) {
      await writeFile(P("state", "samples", src.id + ".txt"), f.text, "utf8");
      continue;
    }

    // 哈希未变 → 跳过,不调用 AI(省钱)
    if (hashes[src.id] && hashes[src.id].hash === f.hash) {
      stats.unchanged++;
      process.stderr.write("  内容未变,跳过提取\n");
      continue;
    }
    hashes[src.id] = { hash: f.hash, at: todayISO() };

    // 候选:HTML 列表页 → 发现详情链接并逐条抓取(每条自己算哈希,变了才提取);
    //       RSS → 逐条 item;单详情页(crawl:false)→ 整页作一条。
    let candidates = [];
    if (f.isRss) {
      candidates = f.text.split(/\n\n---\n\n/).slice(0, 8).map((t, i) => ({ sourceText: t, url: src.url, key: src.id + "#" + i }));
    } else if (src.crawl !== false) {
      const links = discoverDetailLinks(f.rawHtml, src.url, src.domain, { cap: src.cap || CAP });
      process.stderr.write(`  发现 ${links.length} 条候选详情链接\n`);
      for (const ln of links) {
        const detailKey = src.id + "|" + ln.url;
        const df = await fetchSource({ url: ln.url, domain: src.domain, type: "html" });
        if (df.skipped) { process.stderr.write(`    详情跳过 ${ln.url}: ${df.reason}\n`); continue; }
        if (hashes[detailKey] && hashes[detailKey].hash === df.hash) { stats.unchanged++; continue; }
        hashes[detailKey] = { hash: df.hash, at: todayISO() };
        candidates.push({ sourceText: df.text, url: ln.url, key: detailKey, rawHtml: df.rawHtml });
      }
      if (!candidates.length) candidates = [{ sourceText: f.text, url: src.url, key: src.id + "#0", rawHtml: f.rawHtml }];
    } else {
      candidates = [{ sourceText: f.text, url: src.url, key: src.id + "#0", rawHtml: f.rawHtml }];
    }

    for (const cand of candidates) {
      const ctx = {
        org_zh: src.org_zh, domain: src.domain, url: cand.url, source_url: src.url,
        sourceText: cand.sourceText
      };
      let ex;
      try { ex = await getExtract(cand.sourceText, ctx, cand.key); }
      catch (e) { process.stderr.write("  提取失败: " + e.message + "\n"); stats.sourcesFailed.push({ id: cand.key, reason: "extract:" + e.message }); continue; }
      stats.extracted++;
      stats.tokensIn += (ex.usage.input_tokens || 0); stats.tokensOut += (ex.usage.output_tokens || 0);
      stats.cost += estimateCost(ex.usage);

      const v = verifyRecord(ex.data, ctx);
      if (v.dropped) { stats.dropped++; process.stderr.write("  丢弃: " + v.dropReason + "\n"); continue; }

      // 记幻觉日志
      if (v.nulled.length) {
        stats.hallucinations += v.nulled.length;
        for (const n of v.nulled) {
          await appendFile(P("state", "hallucination.log"),
            JSON.stringify({ at: stats.at, source: src.id, item: cand.key, url: cand.url, field: n.field, evidence: n.evidence, dropped_value: n.value, reason: n.reason || "evidence-not-substring" }) + "\n", "utf8");
        }
      }

      const g = gradeTrust(v.record, v.flags, src);
      const rec = finalizeRecord(v.record, src, g.trust);
      // 封面:优先 og:image;缺失或疑似通用图时退而取正文首图。热链,前端加载失败退回色块。
      if (cand.rawHtml) {
        let cv = extractCover(cand.rawHtml, cand.url);
        if (!cv || looksGeneric(cv, src.domain)) {
          const imgs = extractContentImages(cand.rawHtml, cand.url);
          if (imgs.length) cv = imgs[0];
        }
        if (cv) { rec.cover = cv; rec.cover_source = src.domain; }
      }
      // 「前往官网必达主办方本站」:抓到聚合/新闻来源的条目,立刻用其页面HTML + AI/搜索定位主办方真官网。
      // 源链接(rec.url)照留作"信息来源";找到官网写 official_url,前端优先用它。找不到就留空(夜间 backfill 重试)。
      if (isThirdParty(rec.url)) {
        try {
          const loc = await locateOfficial(
            { title: rec.title_zh || rec.title_en, org: rec.org_zh || rec.org_en, city: rec.city_zh, country: rec.country_zh },
            { sourceHtml: cand.rawHtml, sourceUrl: rec.url }
          );
          if (loc && loc.url && !isThirdParty(loc.url)) { rec.official_url = loc.url; rec.official_located = loc.level; process.stderr.write(`    → 官网定位: ${loc.url} (${loc.level})\n`); }
          else process.stderr.write("    → 官网暂未定位(留待夜间重试)\n");
        } catch (e) { process.stderr.write("    → 官网定位失败: " + e.message + "\n"); }
      }
      if (g.trust === "auto") { autoRecords.push(rec); }
      else { pendingRecords.push(Object.assign({ _pending_reasons: g.reasons }, rec)); stats.pending++; }
      process.stderr.write(`  → ${g.trust}${g.reasons.length ? " (" + g.reasons.join("; ") + ")" : ""}  evidence作废 ${v.nulled.length} 处\n`);
    }
  }

  if (hasFlag("--fetch-only")) {
    process.stderr.write("\n[fetch-only] 原文样本已存到 state/samples/\n");
    return;
  }

  // 合并:以既有数据为基底(保留 verified 与此前已上线的 auto),用本次新抽取的 auto 记录 upsert。
  // 关键:哈希未变而跳过的信源,其记录必须原样保留——绝不能因为本次没重抽就把整站数据抹掉。
  const existing = await readJson(DATA, { opportunities: [] });
  const existingIds = new Set(existing.opportunities.map(o => o.id));   // 本次合并基线的 id 快照(下面并发防丢用)
  const byId = new Map(existing.opportunities.map(o => [o.id, o]));
  for (const r of autoRecords) {
    const prev = byId.get(r.id);
    if (prev && prev.trust === "verified") { stats.updated++; continue; } // 人工核实的不被 auto 覆盖
    // 保留此前已找到的封面(含联网检索来的),避免每日重跑用页面 og 图覆盖更贴切的封面
    if (prev && prev.cover && !r.cover) { r.cover = prev.cover; r.cover_source = prev.cover_source; }
    carryTranslations(prev, r);   // 源文未变的英文翻译按字段继承,防每晚重抽抹掉翻译
    if (prev) stats.updated++; else stats.added++;
    byId.set(r.id, r);
  }
  const dd = dedupe(Array.from(byId.values()));

  // 并发安全(2026-07-21,为把每日抓取搬上常开服务器):run.mjs 与 server.mjs 是不同进程、不共享写锁,
  //   若抓取/合并期间 server 端有线上检索入库/投稿/admin 写了 opportunities.json,本次整文件写会覆盖丢失。
  //   对策:写前【再读一次 live】,把"不在合并基线快照里(=本次期间 server 新增)且不在本次结果里"的记录补回;
  //   再【原子写 tmp+rename】(防非原子写被并发读到半截)。只补"基线后新增"的,绝不复活本轮去重掉的记录。
  const finalById = new Map(dd.list.map(o => [o.id, o]));
  try {
    const live = await readJson(DATA, { opportunities: [] });
    for (const o of live.opportunities) if (!existingIds.has(o.id) && !finalById.has(o.id)) finalById.set(o.id, o);
  } catch (e) {}
  const finalList = Array.from(finalById.values());
  const _tmp = DATA + ".tmp-" + process.pid;
  await writeFile(_tmp, JSON.stringify({ _meta: existing._meta || {}, generated_at: todayISO(), count: finalList.length, opportunities: finalList }, null, 2), "utf8");
  await rename(_tmp, DATA);
  await writeFile(P("state", "review-queue.json"), JSON.stringify({ generated_at: todayISO(), count: pendingRecords.length, records: pendingRecords }, null, 2), "utf8");
  await writeFile(P("state", "hashes.json"), JSON.stringify(hashes, null, 2), "utf8");

  console.log("\n" + buildReport(stats));
}

// 重抽整条重建时,把上一版里【源文未变】的英文翻译字段(backfill-en.mjs 补的)按字段继承过来,
// 避免 EN 界面每晚静默退化 + 重复付费翻译;源文变了的字段不继承(过期翻译宁缺,由夜间 backfill 重译)。
function carryTranslations(prev, r) {
  if (!prev) return;
  const mt = new Set(prev.en_mt_fields || []);
  const src = prev.en_src || {};
  const kept = [], keptSrc = {};
  const same = (a, b) => (a || "") === (b || "");
  const pairs = [["title", "title_zh", "title_en"], ["summary", "summary_zh", "summary_en"],
                 ["org", "org_zh", "org_en"], ["city", "city_zh", "city_en"],
                 ["country", "country_zh", "country_en"], ["deadline_note", "deadline_note", "deadline_note_en"]];
  for (const [f, zh, en] of pairs) {
    if (!r[en] && prev[en] && same(prev[zh], r[zh])) {
      r[en] = prev[en];
      if (mt.has(f)) kept.push(f);
      if (src[f] != null) keptSrc[f] = src[f];
    }
  }
  const pe = prev.eligibility || {}, re = r.eligibility || (r.eligibility = {});
  for (const f of ["age_limit", "nationality"]) {
    if (!re[f + "_en"] && pe[f + "_en"] && same(pe[f], re[f])) {
      re[f + "_en"] = pe[f + "_en"];
      if (mt.has(f)) kept.push(f);
      if (src[f] != null) keptSrc[f] = src[f];
    }
  }
  if (!r.disciplines_en && prev.disciplines_en &&
      JSON.stringify(prev.disciplines || []) === JSON.stringify(r.disciplines || [])) {
    r.disciplines_en = prev.disciplines_en;
    if (mt.has("disciplines")) kept.push("disciplines");
    if (src.disciplines != null) keptSrc.disciplines = src.disciplines;
  }
  if (kept.length) r.en_mt_fields = kept;
  if (Object.keys(keptSrc).length) r.en_src = keptSrc;
}

// 补全前端 schema 需要但提取不产出的字段。trust 只能是 auto/pending(verified 由人工手改)。
function finalizeRecord(rec, src, trust) {
  const today = todayISO();
  const id = rec.id || (src.id + "-" + slug(rec.title_zh || rec.title_en || "item"));
  return {
    id,
    category: rec.category || null,
    title_zh: rec.title_zh || null, title_en: rec.title_en || null,
    org_zh: rec.org_zh || src.org_zh || null,
    city_zh: rec.city_zh || null, country_zh: rec.country_zh || null,
    deadline: rec.deadline || null, deadline_note: rec.deadline_note || "",
    apply_fee: rec.apply_fee || { free: null, amount: null, currency: null },
    participation_fee: rec.participation_fee || { required: null, amount: null, currency: null },
    funding: rec.funding || { stipend: null, housing: null, travel: null },
    eligibility: rec.eligibility || { students_ok: null, age_limit: null, nationality: null },
    disciplines: rec.disciplines || [],
    summary_zh: rec.summary_zh || null,
    url: rec.url, source_url: rec.source_url, domain: rec.domain,
    org_type: src.org_type || "official",
    trust,                                   // auto | pending —— 绝不自动写 verified
    status: computeStatus(rec.deadline),
    verified_at: null, last_seen: today, updated_at: today
  };
}
function computeStatus(deadline) {
  if (!deadline) return "open";
  return deadline < todayISO() ? "expired" : "open";
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^\w一-龥]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
}

async function runHealth() {
  const existing = await readJson(DATA, { opportunities: [] });
  const h = await healthCheck(existing.opportunities);
  await writeFile(DATA, JSON.stringify(existing, null, 2), "utf8");
  console.log("[健康检查] 过期隐藏 " + h.hiddenExpired + " · 失联隐藏 " + h.hiddenDead + " · 恢复 " + h.revived);
}

const _t0 = Date.now();
main().then(() => reportAgent("harvester", true, "每日机会抓取管线完成(含健康检查)", null, Date.now() - _t0))
  .catch(async e => { console.error("管道异常:", e); await reportAgent("harvester", false, String(e.message || e).slice(0, 150), null, Date.now() - _t0); process.exit(1); });
