// run-channels.mjs —— 资讯(news)/招聘(jobs)频道每日抓取管道,与机会频道 run.mjs 同规格:
//   信源列表 → 抓取(robots+限速+署名UA) → 发现详情链接 → (哈希未变则跳过) → AI 提取(双语)
//   → 程序 evidence 校验 → 去重 → 写盘(串行锁)。绝不编造;evidence 不过的字段作废/整条丢弃。
//
// 用法:
//   node run-channels.mjs                        跑 news + jobs 全部信源(需 DEEPSEEK_API_KEY)
//   node run-channels.mjs --channel news         只跑资讯
//   node run-channels.mjs --only artron-news     只跑指定信源 id(逗号分隔)
//   node run-channels.mjs --cap 3                每源最多处理 N 条新链接(默认 8;控成本)
//
// 信源清单:sources-news.json / sources-jobs.json;状态:state/hashes-channels.json。

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";
import { extractAnchors } from "./lib/discover.mjs";
import { CHANNELS, processChannelPage, upsertChannelRecords, readChannelDoc, withFileLock, urlDateISO } from "./lib/channels.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const P = (...p) => join(__dir, ...p);

const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const CAP = Math.max(1, parseInt(getOpt("--cap") || "8", 10) || 8);
const onlyIds = (getOpt("--only") || "").split(",").map(s => s.trim()).filter(Boolean);
const onlyChannel = getOpt("--channel");
const HASHES_PATH = P("state", "hashes-channels.json");

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
async function readJson(path, fallback) { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { return fallback; } }

// —— RSS → 各条目文章链接 ——
function rssLinks(xml) {
  const out = [], seen = new Set();
  const blocks = String(xml).match(/<(item|entry)[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    let link = null;
    const plain = /<link[^>]*>\s*(?:<!\[CDATA\[)?\s*(https?:\/\/[^<\]\s]+)/i.exec(b);
    if (plain) link = plain[1];
    else { const attr = /<link[^>]*href="([^"]+)"/i.exec(b); if (attr) link = attr[1]; }
    if (!link) continue;
    link = link.trim().split("#")[0];
    if (seen.has(link)) continue;
    seen.add(link);
    out.push(link);
  }
  return out;
}

// —— HTML 列表页 → 详情链接(同域;按频道的 URL 形态)——
// 覆盖已实测信源的详情形态:雅昌 /20260715/n1131447.html、艺术中国 content_42862041.htm、
// 99艺术网 日期路径;greenhouse /<board>/jobs/123、惠特尼 /about/job-postings/<slug>。
const NEWS_DETAIL = /(\/\d{4}[\/-]\d{1,2}\/|content_\d+|\/n\d{6,}|\/\d{8}\/|\d{5,}\.s?html?$|\/(news|article|articles|story|post|feature|review|exhibitions?)\/[\w%-]{3,})/i;
const JOB_DETAIL = /(\/jobs?\/[\w%-]{2,}|\/job-postings\/[\w%-]{2,}|\/careers?\/[\w%-]{3,}|\/positions?\/[\w%-]{2,}|\/vacanc(?:y|ies)\/[\w%-]{2,}|\/openings?\/[\w%-]{2,})/i;

function discoverLinks(chKey, rawHtml, src) {
  const base = new URL(src.url);
  const baseDomain = String(src.domain || base.host).replace(/^www\./, "");
  const re = chKey === "jobs" ? JOB_DETAIL : NEWS_DETAIL;
  const seen = new Set(), out = [];
  for (const a of extractAnchors(rawHtml)) {
    if (!a.href || /^(javascript:|mailto:|tel:|#)/i.test(a.href)) continue;
    let u; try { u = new URL(a.href, base); } catch (e) { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const host = u.host.replace(/^www\./, "");
    if (host !== baseDomain && !host.endsWith("." + baseDomain)) continue;   // 必须同域(含子域)
    if (src.link_prefix && !u.pathname.startsWith(src.link_prefix)) continue; // greenhouse 限本板
    if (!re.test(u.pathname + u.search)) continue;
    const key = u.href.split("#")[0];
    if (key === base.href || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

async function runChannel(chKey, hashes, stats) {
  const ch = CHANNELS[chKey];
  const doc = await readChannelDoc(chKey);
  const existUrls = new Set((doc[ch.listKey] || []).map(o => ch.urlOf(o)).filter(Boolean));
  const srcDoc = await readJson(P(`sources-${chKey}.json`), { sources: [] });
  let sources = (srcDoc.sources || []).filter(s => s.reachable !== false);
  if (onlyIds.length) sources = sources.filter(s => onlyIds.includes(s.id));

  const collected = [];
  for (const src of sources) {
    process.stderr.write(`\n[${chKey}·抓取] ${src.id}  ${src.url}\n`);
    const f = await fetchSource(src);
    if (f.skipped) {
      stats.failed.push({ id: src.id, reason: f.reason + (f.error ? ":" + f.error : "") });
      process.stderr.write(`  跳过: ${f.reason}${f.error ? " " + f.error : ""}\n`);
      continue;
    }
    // 列表/feed 未变 → 整源跳过,不发现不提取(省钱)。
    // 注意 hash 的记录时机(评审修正):列表 hash 要等本源处理顺利完成才记——
    // 若因 cap 截断还有新链接没处理、或提取途中出过错,则不记,下次重跑继续补。
    if (hashes[src.id] && hashes[src.id].hash === f.hash) {
      stats.unchanged++;
      process.stderr.write("  内容未变,跳过\n");
      continue;
    }

    const links = f.isRss ? rssLinks(f.rawHtml) : discoverLinks(chKey, f.rawHtml, src);
    process.stderr.write(`  发现 ${links.length} 条候选链接\n`);

    let taken = 0, capHit = false, srcFailed = false;
    const cap = src.cap || CAP;
    for (const ln of links) {
      if (taken >= cap) { capHit = true; break; }
      if (existUrls.has(ln)) continue;                 // 已入库的不重复提取
      // 资讯:URL 自带日期且已超龄的旧文,不抓不提取(省钱;列表页常混入陈年栏目文)
      if (chKey === "news") {
        const ud = urlDateISO(ln);
        if (ud && Date.parse(ud) < Date.now() - ch.maxAgeDays * 86400000) continue;
      }
      let host; try { host = new URL(ln).host; } catch (e) { continue; }
      let df;
      try { df = await fetchSource({ url: ln, domain: host, type: "html" }); }
      catch (e) { process.stderr.write(`    抓取异常 ${ln}\n`); srcFailed = true; continue; }
      if (df.skipped || !df.text || df.text.length < 200) { process.stderr.write(`    详情跳过 ${ln}: ${df.reason || "thin"}\n`); continue; }
      const detailKey = src.id + "|" + ln;
      if (hashes[detailKey] && hashes[detailKey].hash === df.hash) { stats.unchanged++; continue; }
      taken++;
      let r;
      try { r = await processChannelPage(chKey, { url: ln, host, text: df.text, rawHtml: df.rawHtml }, "daily"); }
      catch (e) {
        // 提取失败(API 限流/欠费/超时):不记 detail hash,下次重跑必然重试(评审修正:先记会永久漏采)
        process.stderr.write("    提取失败: " + e.message + "\n");
        stats.failed.push({ id: detailKey, reason: "extract:" + e.message });
        srcFailed = true;
        continue;
      }
      hashes[detailKey] = { hash: df.hash, at: todayISO() };   // 提取成功或明确丢弃,才算"处理过"
      stats.extracted++;
      if (r.dropped) { stats.dropped++; process.stderr.write("    丢弃: " + r.reason + "\n"); continue; }
      const rec = r.record;
      // 信源配置兜底:提取没认出媒体名/机构名时,用清单里登记的
      if (chKey === "news" && src.source_name && (!rec.source || rec.source === rec.domain)) rec.source = src.source_name;
      if (chKey === "jobs" && src.org && !rec.org) rec.org = src.org;
      if (existUrls.has(ch.urlOf(rec))) continue;
      existUrls.add(ch.urlOf(rec));
      collected.push(rec);
      process.stderr.write(`    ✓ ${rec.title_zh || rec.title}  evidence作废 ${(r.nulled || []).length} 处\n`);
    }
    if (!capHit && !srcFailed) hashes[src.id] = { hash: f.hash, at: todayISO() };
  }

  const saved = collected.length ? await upsertChannelRecords(chKey, collected) : [];
  stats.added += saved.length;
  process.stderr.write(`\n[${chKey}] 本次入库 ${saved.length} 条\n`);
}

// 招聘:清出过期职位(留着只会误导求职者)。两条规则:
//   ① 有截止且已过 60 天;② 无截止(greenhouse 板常见)但入库超 120 天——多半早已招满关闭。
//   种子数据(无 added_at)不动,由人工维护。
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
async function pruneExpiredJobs() {
  const ch = CHANNELS.jobs;
  return withFileLock(ch.dataPath, async () => {
    let doc;
    try { doc = JSON.parse(await readFile(ch.dataPath, "utf8")); } catch (e) { return 0; }
    const list = doc[ch.listKey] || [];
    const cutoff60 = isoDaysAgo(60), cutoff120 = isoDaysAgo(120);
    const kept = list.filter(j => {
      if (j.deadline && /^\d{4}-\d{2}-\d{2}$/.test(j.deadline)) return j.deadline >= cutoff60;
      if (j.added_at) return j.added_at >= cutoff120;
      return true;
    });
    const removed = list.length - kept.length;
    if (removed > 0) {
      doc[ch.listKey] = kept;
      doc.count = kept.length;
      const tmp = ch.dataPath + ".tmp-" + process.pid + "-" + Date.now();
      await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
      await rename(tmp, ch.dataPath);
    }
    return removed;
  });
}

async function main() {
  const channels = onlyChannel ? [onlyChannel] : ["news", "jobs"];
  for (const c of channels) if (!CHANNELS[c]) { console.error("未知频道:", c); process.exit(1); }
  await mkdir(P("state"), { recursive: true });
  const hashes = await readJson(HASHES_PATH, {});
  const stats = { at: new Date().toISOString(), unchanged: 0, extracted: 0, added: 0, dropped: 0, failed: [] };
  for (const c of channels) await runChannel(c, hashes, stats);
  if (channels.includes("jobs")) {
    const pruned = await pruneExpiredJobs();
    if (pruned) process.stderr.write(`[jobs] 清出截止超 60 天的旧职位 ${pruned} 条\n`);
  }
  await writeFile(HASHES_PATH, JSON.stringify(hashes, null, 2), "utf8");
  console.log(`\n[频道管道] 提取 ${stats.extracted} · 入库 ${stats.added} · 丢弃 ${stats.dropped} · 未变跳过 ${stats.unchanged} · 失败 ${stats.failed.length}${stats.failed.length ? " " + JSON.stringify(stats.failed.slice(0, 5)) : ""}`);
}

main().catch(e => { console.error("频道管道异常:", e); process.exit(1); });
