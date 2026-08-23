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
import { discoverViaSitemap } from "./lib/sitemap.mjs";
import { extractCover, extractContentImages, looksGeneric } from "./lib/cover.mjs";
import { extract, estimateCost, parseJson } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import { dedupe } from "./lib/dedupe.mjs";
import { gradeTrust } from "./lib/trust.mjs";
import { healthCheck } from "./lib/healthcheck.mjs";
import { buildReport } from "./lib/report.mjs";
import { resolve, classifySource } from "./lib/resolve-official.mjs";
import { hostOf } from "./lib/aggregators.mjs";
import { fillGeoFallback } from "./lib/geolocation-fallback.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const P = (...p) => join(__dir, ...p);

const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
// 每个信源最多向下钻取的详情页数量。首跑用 --cap 8 控成本;不传则默认 20。
const CAP = Math.max(1, parseInt(getOpt("--cap") || "20", 10) || 20);
const onlyIds = (getOpt("--only") || "").split(",").map(s => s.trim()).filter(Boolean);
// 官网溯源本轮搜索预算(共享全站账本,超 Brave/Serper 日配额自动停);默认 80,可用 --resolve-budget 调。
const RESOLVE_BUDGET = Math.max(0, parseInt(getOpt("--resolve-budget") || "80", 10) || 80);
// 2026-08-23 提速:候选中 AI 提取(调 LLM)的有界并发数。串行曾是整轮最大瓶颈,并发可把几小时压到几十分钟。
// 2026-08-23 改:默认 4→2,把峰值 LLM 并发压在源6×提取2=12 路内(此前 6×4=24 路屡爆 GLM 免费档 429)。
// 调大需注意:①LLM 账号并发限流/速率;②官网溯源搜索预算并发下会共享,超配额自动停。可用 --extract-concurrent 覆盖。
const EXTRACT_CONCURRENT = Math.max(1, parseInt(getOpt("--extract-concurrent") || "2", 10) || 2);
// 2026-08-23 提速:信源级并发(整轮真正的吞吐瓶颈)。默认信源逐源串行:每源"抓列表页→抓详情→并发提取+溯源"
// 全完成才轮到下一个,577 源累下来就是十几小时。这里改为有界并发同时抓多个源,总耗时 ≈ 最慢源而非所有源之和。
// 并发安全:JS 单线程,hashes/stats/autoRecords/pendingRecords/resolveSearched 均为同步原子,共享搜索预算超配额自动停,
//   各源闭包(addedThisSrc/finishSource)独立,结果与串行版逐条一致。警告:并发源数 × EXTRACT_CONCURRENT = 峰值 LLM 并发,
//   调大需注意 GLM 免费档/搜索 API 限流;默认 6,可用 --source-concurrent 覆盖。
// 实测(2026-08-23,577 源并发=6):稳态日更轮多数源 304/未变,一二十分钟内跑完;内容大改的全量重扫轮受"同域 3s 合规限速
//   × 详情页数 + LLM 提取"串行拖累,约一小时余。想更快可临时 --source-concurrent 8~12,但勿超 LLM/搜索 API 限流。
const SOURCE_CONCURRENT = Math.max(1, parseInt(getOpt("--source-concurrent") || "6", 10) || 6);
const DATA = getOpt("--out") || P("..", "site", "data", "opportunities.json"); // --out 可指向演示输出,避免覆盖 seed

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { return fallback; } }

// 有界并发池:把 items 分成并发为 limit 的批次,逐个 job 执行,返回按原顺序的结果数组。
// 2026-08-23 提速用(详情页批量抓取);只并发异步阶段,不改全局计数/预算,结果与串行版一致。
async function batchPool(items, limit, job) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      try { out[i] = await job(items[i]); }
      catch (e) { out[i] = { error: e }; }
    }
  });
  await Promise.all(workers);
  return out;
}

// 区域经理 terms 查找(地理信息兜底用)
let _regionTermsCache = null;
async function loadRegionTermsMap() {
  if (_regionTermsCache) return _regionTermsCache;
  try {
    const regions = JSON.parse(await readFile(P("regions.json"), "utf8"));
    _regionTermsCache = {};
    for (const m of (regions.managers || [])) {
      if (m.id && Array.isArray(m.terms)) {
        _regionTermsCache[m.id] = m.terms;
      }
    }
  } catch (e) {
    _regionTermsCache = {};
  }
  return _regionTermsCache;
}
function getRegionTerms(regionId) {
  // 同步访问(数据已在 main 中预加载),兜底返回空数组
  if (!_regionTermsCache) return [];
  return _regionTermsCache[regionId] || [];
}

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
  // 预加载区域经理 terms(地理信息兜底用)
  await loadRegionTermsMap();
  const stats = {
    at: new Date().toISOString(), sourcesTotal: sources.length, sourcesOk: 0, sourcesFailed: [],
    unchanged: 0, extracted: 0, added: 0, updated: 0, pending: 0, dropped: 0,
    hallucinations: 0, cost: 0, tokensIn: 0, tokensOut: 0, tierSkipped: 0
  };
  const autoRecords = [], pendingRecords = [];
  await mkdir(P("state", "samples"), { recursive: true });
  const today = todayISO();
  const dom_ = new Date().getDate(); // 日期序号,给低产出源"每 3 天才查一次"降频用
  let resolveSearched = 0; // 本轮官网溯源已消耗的搜索次数(共享 RESOLVE_BUDGET)

  const processSource = async (src) => {
    // 产出分级降频(P2):yield_count/fail_count/tier 由本轮跑完后写回 sources.json(见下方 finishSource)。
    // 只有 tier==='low'(连续 14 次零产出)才降频,且 --only 单跑指定源时不受影响,方便调试验证。
    if (!onlyIds.length && src.tier === "low" && dom_ % 3 !== 0) {
      stats.tierSkipped++;
      process.stderr.write(`\n[跳过·低产出源降频] ${src.id}(tier=low,fail_count=${src.fail_count || 0},每 3 天查一次)\n`);
      return;
    }
    process.stderr.write(`\n[抓取] ${src.id}  ${src.url}\n`);
    let addedThisSrc = 0;
    const finishSource = (polled) => {
      // P2:更新信源产出字段。polled=false(robots/网络层面直接跳过)不计入 last_polled,
      // 避免污染 sitemap sinceDate 的基准(那是"上次真正检查过内容"的日期,不是"上次尝试"的日期)。
      src.yield_count = (src.yield_count || 0) + addedThisSrc;
      if (addedThisSrc > 0) src.fail_count = 0;
      else src.fail_count = (src.fail_count || 0) + 1;
      if (src.yield_count >= 5) src.tier = "high";
      else if ((src.fail_count || 0) >= 14 && !src.yield_count) src.tier = "low";
      else if (src.tier !== "low" || addedThisSrc > 0) src.tier = "normal";
      if (polled) src.last_polled = today;
    };
    const f = await fetchSource(src, hashes[src.id]);
    if (f.skipped) {
      stats.sourcesFailed.push({ id: src.id, reason: f.reason + (f.error ? (":" + f.error) : "") });
      process.stderr.write(`  跳过: ${f.reason}${f.error ? " " + f.error : ""}\n`);
      finishSource(false);
      return;
    }
    stats.sourcesOk++;

    // 条件请求(P3):服务器回 304 → 内容确定没变,不用比对哈希也不用往下走,直接当"未变"处理。
    if (f.notModified) {
      stats.unchanged++;
      process.stderr.write("  304 未修改(条件请求命中),跳过\n");
      if (f.etag || f.lastModified) hashes[src.id] = Object.assign({}, hashes[src.id], { at: today, etag: f.etag || (hashes[src.id] && hashes[src.id].etag), lastModified: f.lastModified || (hashes[src.id] && hashes[src.id].lastModified) });
      finishSource(true);
      return;
    }
    process.stderr.write(`  状态 ${f.status} · robots=${f.robots} · 正文 ${f.text.length} 字 · hash ${f.hash.slice(0, 12)}\n`);

    // --fetch-only:存样本,不提取
    if (hasFlag("--fetch-only")) {
      await writeFile(P("state", "samples", src.id + ".txt"), f.text, "utf8");
      return;
    }

    // --no-hash-save:对照计时用。不读哈希缓存(强制完整重抓重提取),也不写回(不污染下次正常跑),
    // 让"并发 vs 串行"两轮在同一批候选上干净对比,不被条件请求/内容未变跳过干扰。
    const noHashSave = hasFlag("--no-hash-save");

    // 哈希未变 → 跳过,不调用 AI(省钱)
    if (!noHashSave && hashes[src.id] && hashes[src.id].hash === f.hash) {
      stats.unchanged++;
      process.stderr.write("  内容未变,跳过提取\n");
      hashes[src.id] = Object.assign({}, hashes[src.id], { at: today, etag: f.etag || hashes[src.id].etag, lastModified: f.lastModified || hashes[src.id].lastModified });
      finishSource(true);
      return;
    }
    hashes[src.id] = { hash: f.hash, at: today, etag: f.etag || null, lastModified: f.lastModified || null };
    if (noHashSave) delete hashes[src.id]; // 对照计时:本轮不记缓存,下一源也不复用

    // 候选:HTML 列表页 → 发现详情链接并逐条抓取(每条自己算哈希,变了才提取);
    //       RSS → 逐条 item;单详情页(crawl:false)→ 整页作一条。
    let candidates = [];
    if (f.isRss) {
      candidates = f.text.split(/\n\n---\n\n/).slice(0, 8).map((t, i) => ({ sourceText: t, url: src.url, key: src.id + "#" + i }));
    } else if (src.crawl !== false) {
      const links = discoverDetailLinks(f.rawHtml, src.url, src.domain, { cap: src.cap || CAP });
      // sitemap 补充发现(P3):不取代列表页发现,只补它漏掉的(西式 slug 链接/分页外的旧详情页)。
      // sinceDate 只在 lastmod 被判定为可信时才生效(见 sitemap.mjs 的自检),否则只按数量截断。
      if (src.sitemap !== false) {
        let origin = null; try { origin = new URL(src.url).origin; } catch (e) {}
        const sm = origin ? await discoverViaSitemap(origin, src.domain, { cap: src.cap || CAP, sinceDate: src.last_polled }) : null;
        if (sm) {
          src.sitemap = true;
          if (sm.urls.length) {
            const seenUrl = new Set(links.map(l => l.url));
            let addedFromSitemap = 0;
            for (const su of sm.urls) if (!seenUrl.has(su.url)) { links.push({ url: su.url, text: "" }); seenUrl.add(su.url); addedFromSitemap++; }
            process.stderr.write(`  sitemap 补充候选 ${addedFromSitemap} 条(站内共 ${sm.totalInSitemap} 条,lastmod${sm.trustLastmod ? "可信" : "不可信/未按时间过滤"})\n`);
          }
        } else {
          src.sitemap = false; // 探测过、确认没有 sitemap.xml,以后跳过这次额外请求
        }
      }
      process.stderr.write(`  发现 ${links.length} 条候选详情链接\n`);
      // 2026-08-23 提速:详情页用有界并发批量抓取(Promise.all 平坦池)。同域请求仍受 fetch.mjs 的同域 3 秒限速
      // 串行链约束(合规红线不受破坏,不过度请求);跨域详情页可并行,连不上快速失败(5s),整体不再 15s×N 拖慢。
      // 只在异步抓取阶段并发,哈希去重/入候选在抓取完成后按原顺序处理,结果与串行版完全一致。
      const linkBatch = await batchPool(links, 6, async (ln) => {
        const detailKey = src.id + "|" + ln.url;
        const df = await fetchSource({ url: ln.url, domain: src.domain, type: "html", timeoutMs: 5000 }, hashes[detailKey]);
        return { ln, df };
      });
      for (const { ln, df } of linkBatch) {
        const detailKey = src.id + "|" + ln.url;
        if (df.skipped) { process.stderr.write(`    详情跳过 ${ln.url}: ${df.reason}\n`); continue; }
        if (df.notModified) { stats.unchanged++; hashes[detailKey] = Object.assign({}, hashes[detailKey], { at: today, etag: df.etag || (hashes[detailKey] && hashes[detailKey].etag), lastModified: df.lastModified || (hashes[detailKey] && hashes[detailKey].lastModified) }); continue; }
        if (hashes[detailKey] && hashes[detailKey].hash === df.hash) { stats.unchanged++; hashes[detailKey] = Object.assign({}, hashes[detailKey], { at: today, etag: df.etag || hashes[detailKey].etag, lastModified: df.lastModified || hashes[detailKey].lastModified }); continue; }
        hashes[detailKey] = { hash: df.hash, at: today, etag: df.etag || null, lastModified: df.lastModified || null };
        candidates.push({ sourceText: df.text, url: ln.url, key: detailKey, rawHtml: df.rawHtml });
      }
      if (!candidates.length) candidates = [{ sourceText: f.text, url: src.url, key: src.id + "#0", rawHtml: f.rawHtml }];
    } else {
      candidates = [{ sourceText: f.text, url: src.url, key: src.id + "#0", rawHtml: f.rawHtml }];
    }

    // 2026-08-23 提速:候选的 AI 提取(逐条串行调 LLM)是本轮最大瓶颈,改为有界并发(EXTRACT_CONCURRENT)。
    // 并发安全:JS 单线程,async 在 await 之间原子;getExtract/verifyRecord/gradeTrust 各候选独立。
    //   stats.* 递增、autoRecords/pendingRecords.push、resolveSearched 均同步,并发下无交错。反幻觉
    //   evidence 校验基于各候选原文,不受并发影响,结果与串行版逐条一致。官网溯源预算并发下微超冲可接受。
    const processCand = async (cand) => {
      const ctx = {
        org_zh: src.org_zh, domain: src.domain, url: cand.url, source_url: src.url,
        sourceText: cand.sourceText,
        region: src.region_hint ? { id: src.region_hint, terms: getRegionTerms(src.region_hint) } : null
      };
      let ex;
      try { ex = await getExtract(cand.sourceText, ctx, cand.key); }
      catch (e) { process.stderr.write("  提取失败: " + e.message + "\n"); stats.sourcesFailed.push({ id: cand.key, reason: "extract:" + e.message }); return; }
      stats.extracted++;
      stats.tokensIn += (ex.usage.input_tokens || 0); stats.tokensOut += (ex.usage.output_tokens || 0);
      stats.cost += estimateCost(ex.usage);

      const v = verifyRecord(ex.data, ctx);
      if (v.dropped) { stats.dropped++; process.stderr.write("  丢弃: " + v.dropReason + "\n"); return; }

      // 地理信息兜底(v1.8.0):对 city_zh/country_zh 为空的记录,逐级回退补全
      const geoResult = fillGeoFallback(v.record, ctx, cand.sourceText);
      if (geoResult.geo_fallback !== "ai") {
        v.record.city_zh = geoResult.city_zh;
        v.record.country_zh = geoResult.country_zh;
        process.stderr.write(`  地理兜底: city=${geoResult.city_zh} country=${geoResult.country_zh} (来源:${geoResult.geo_fallback})\n`);
      }

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
      // 「前往官网必达主办方本站」——官网溯源多关卡(用户核心诉求):
      //   关卡1来源权威分类:主办方官网不动链接;转载/可信平台入口才溯源。
      //   关卡2转载页内挖主办方官网(JSON-LD sameAs / "官网|visit site" 锚点);
      //   关卡3按【转载页标题全称 + 主办方】检索候选官网(共享全站搜索预算,超配额自动停);
      //   关卡4候选真实性校验(程序硬闸 A/B + AI 定级 specific/org/no 两道才放行);
      //   关卡5落库:official_url 只写验证过的,绝不硬造;找不到如实标注留待存量回填。
      // 源链接(rec.url)照留作"信息来源";找到官网写 official_url,前端优先用它。
      if (classifySource(src.domain && src.domain) !== "official" && resolveSearched < RESOLVE_BUDGET) {
        try {
          const res = await resolve(
            { title: rec.title_zh || rec.title_en, org: rec.org_zh || rec.org_en, sourceHtml: cand.rawHtml, sourceUrl: rec.url },
            { domain: src.domain || hostOf(rec.url), name_zh: rec.org_zh, org_zh: rec.org_zh },
            { budget: RESOLVE_BUDGET - resolveSearched, maxProbe: 6 }
          );
          resolveSearched += (res.searched || 0);
          if (res.official_url) { rec.official_url = res.official_url; rec.official_located = res.official_located; }
          if (res.via_repost) rec.via_repost = true;
          if (res.source_platform) rec.source_platform = res.source_platform;
          rec.resolve_classify = res.classify;
          rec.resolve_gates = (res.gates || []).length;
          process.stderr.write(`    → 官网溯源:${res.classify} ${res.official_located || "-"}${res.official_url ? " " + res.official_url : ""} 搜索${res.searched}\n`);
        } catch (e) { process.stderr.write("    → 官网溯源失败: " + e.message + "\n"); }
      }
      if (g.trust === "auto") { autoRecords.push(rec); }
      else { pendingRecords.push(Object.assign({ _pending_reasons: g.reasons }, rec)); stats.pending++; }
      addedThisSrc++;
      process.stderr.write(`  → ${g.trust}${g.reasons.length ? " (" + g.reasons.join("; ") + ")" : ""}  evidence作废 ${v.nulled.length} 处\n`);
    };
    await batchPool(candidates, EXTRACT_CONCURRENT, processCand);
    finishSource(true);
  }

  // 2026-08-23 提速:信源级有界并发 —— 替代原先"逐源串行"的 for 循环。多个信源同时"抓列表→抓详情→并发提取+溯源"。
  // 同一时刻在途源数 = SOURCE_CONCURRENT;每源内部详情页并发 6、提取并发 EXTRACT_CONCURRENT,
  // 峰值 LLM 并发 ≈ SOURCE_CONCURRENT × EXTRACT_CONCURRENT(默 3×4=12),总耗时 ≈ 各源实际耗时之和 / 并发卷绕,
  // 远小于原"所有源串行累加"。并发安全见 processSource 内注释(JS 单线程,计数/预算为同步原子)。
  await batchPool(sources, SOURCE_CONCURRENT, processSource);

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
    // 首次收录日只写一次:本函数整条替换旧记录,不继承的话每晚重抓都会把 first_seen 刷成今天,
    // 前端就会把全库老条目都标成"今日新增"。旧数据没有该字段 → 留空,前端按"不是新的"处理。
    if (prev && prev.first_seen) r.first_seen = prev.first_seen;
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
  if (!hasFlag("--no-hash-save")) await writeFile(P("state", "hashes.json"), JSON.stringify(hashes, null, 2), "utf8");

  // P2:回写 sources.json 里本轮更新过的 yield_count/fail_count/tier/last_polled/sitemap 字段。
  // sourcesDoc.sources 里未被本轮处理的信源(reachable:false 或 --only 未选中)引用未变,原样写回。
  const srcTmp = sourcesPath + ".tmp-" + process.pid;
  await writeFile(srcTmp, JSON.stringify(sourcesDoc, null, 2), "utf8");
  await rename(srcTmp, sourcesPath);

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
    trust,                                   // auto | pending —— 绝不自动写 verified
    status: computeStatus(rec.deadline),
    // first_seen = 首次收录日(v0.98.0),下面 upsert 时会从旧记录继承,保证它永远是"第一次见到"的日子。
    // 前端「今日新增/NEW」只认它——updated_at/last_seen 每晚重抓都会刷新,拿来判"新"会把全库标成 NEW。
    verified_at: null, first_seen: today, last_seen: today, updated_at: today
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
  .catch(async e => { console.error("管道异常:", e); await reportAgent("harvester", false, String(e.message || e).slice(0, 150), null, Date.now() - _t0); process.exit(1); })
  .finally(async () => { const { closeBrowser } = await import("./lib/render.mjs"); await closeBrowser(); });   // 用过无头浏览器才会真的启动,没用过是空操作;不关会挂住进程退出
