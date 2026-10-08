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
import { verifyRecord, markRolling, classifyNoDeadline } from "./lib/verify.mjs";
import { normUrl } from "./lib/dedupe.mjs";
import { isTrustedPlatform } from "./lib/aggregators.mjs";

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

// 支持 --srcs <file> 指定源清单(默认主清单);--srcs 便于只跑新一批补充源
const _args = process.argv.slice(2);
const _opt = f => { const i = _args.indexOf(f); return i !== -1 ? _args[i + 1] : null; };
const SRC_FILE = join(__dir, _opt("--srcs") || "_tmp-cn-portal-srcs.txt");
const LIST_URLS = readFileSync(SRC_FILE, "utf8")
  .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"))
  .map(l => l.split("\t")[0].split("#")[0].trim());
// 白名单 = 清单文件里出现的全部主机(该清单已人工核实,放开到全量做一次彻底收割)
const allowed = new Set(LIST_URLS.map(u => { try { return new URL(u).host; } catch (e) { return null; } }).filter(Boolean));
const numOpt = (f, d) => { const v = _opt(f); const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : d; };
const DISCOVER_CAP = numOpt("--disc", 30);   // 每源最多详情链接
const DETAIL_CAP = numOpt("--detail", 12);   // 每源最多入库详情数
const EXTRACT_TIMEOUT = numOpt("--extract-timeout", 120000); // 单条 extract 硬超时(ms):LLM 调用卡死时不再拖住整轮
const CONC = numOpt("--conc", 4);            // 每源详情并发(串行 24s/条 太慢;DeepSeek 主力可承受 4 路)

let totalDropped = 0, totalErr = 0;          // 跨源累计(main 与 processDetail 共用)

// 硬超时包装:LLM/网络意外挂住时抛错,由调用方计入错误并继续,绝不让整轮无限期停摆。
function withTimeout(p, ms, label) {
  let t;
  const killer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout:" + label)), ms); });
  return Promise.race([p, killer]).finally(() => clearTimeout(t));
}

function todayISO() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function slug(s) { return String(s || "").toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item"; }
// 标题归一:去掉标点/空白/常见机构前缀,只留 CJK+字母数字,用于跨站同公告判重
function normTitle(s) {
  return String(s || "")
    .replace(/^[\s\S]{0,20}?[：:]/g, "")                 // 去掉「中国美术家协会：」这类前缀
    .replace(/[\s\u3000\p{P}\p{S}]/gu, "")
    .toLowerCase().slice(0, 34);
}
function computeStatus(deadline) {
  if (!deadline) return "open";
  return String(deadline).slice(0, 10) < todayISO() ? "expired" : "open";
}
function finalizeRecord(rec, { domain, url, srcUrl }) {
  const id = "search-" + domain.split(".")[0] + "-" + slug(rec.title_zh || rec.title_en || "item");
  // 2026-10-08 用户拍板放宽:中文聚合门户(设计竞赛网/行先生/艺赛中国/设计赛网/东方好创意/书画展赛网…)也收,
  // 但必须【如实标注】——落在可信平台上的条目一律 org_type=aggregator + source_note 说明"平台转载·非官网直采",
  // 前端按钮点名平台(见 site/index.html 的 PLATFORM_LABEL),绝不谎称官网。
  const isAgg = isTrustedPlatform(url);
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
    org_type: isAgg ? "aggregator" : "official", trust: "auto",
    ...(isAgg ? { source_note: "平台转载·非官网直采" } : {}),
    status: computeStatus(rec.deadline),
    verified_at: null, first_seen: todayISO(), last_seen: todayISO(), updated_at: todayISO(), _via: "search"
  };
}

async function processDetail(l, u0, { host, domain, listUrl }) {
  let df;
  try { df = await fetchSource({ url: u0, domain: host, type: "html" }, null, { timeoutMs: 10000 }); }
  catch (e) { totalErr++; return null; }
  if (df.skipped || !df.text || df.text.length < 200) { totalDropped++; console.log(`  skip(薄|len=${(df && df.text) || 0}) ${u0}`); return null; }
  try {
    const ex = await withTimeout(
      extract(df.text, { org_zh: "", domain, url: u0, source_url: listUrl, sourceText: df.text }),
      EXTRACT_TIMEOUT, "extract:" + u0);
    if (!ex.data || ex.data.applicable === false) { totalDropped++; console.log(`  drop(不适用) ${domain} ${(l.text || "").slice(0, 20)}`); return null; }
    const v = verifyRecord(ex.data, { sourceText: df.text, url: u0, source_url: listUrl, domain });
    if (v.dropped) { totalDropped++; console.log(`  drop(${String(v.dropReason || "").slice(0, 30)}) ${(l.text || "").slice(0, 20)}`); return null; }
    // A 类口径保险(2026-10-07 用户确认:要的是「可投稿/报名的征集征稿」):纯展览类不入库
    if (/^exhibition/i.test(v.record.category || "") && !/(征集|征稿|招募|投稿|报名|申报|驻留)/.test(v.record.title_zh || "")) {
      totalDropped++; console.log(`  drop(纯展览) ${(l.text || "").slice(0, 20)}`); return null;
    }
    // 国内来源无截止 → 过陈旧闸后按「常年征集」标注(与 server.mjs / bulk-discover 口径一致,2026-10-07 用户确认)
    if (v.record.deadline == null) {
      const isCn = /中国/.test(v.record.country_zh || "") || /\.cn$/i.test(host);
      if (isCn) {
        const kind = classifyNoDeadline(v.record);
        if (kind === "stale") { totalDropped++; console.log(`  drop(陈旧无截止) ${(l.text || "").slice(0, 20)}`); return null; }
        if (kind === "rolling") markRolling(v.record);
      }
    }
    return finalizeRecord(v.record, { domain, url: u0, srcUrl: listUrl });
  } catch (e) { totalErr++; console.log(`  ERR ${domain}: ${String(e.message || e).slice(0, 60)}`); return null; }
}

async function main() {
  const existing = JSON.parse(await readFile(DATA, "utf8"));
  const existUrls = new Set((existing.opportunities || []).map(o => (o.url || "").split("#")[0]));
  // 标题判重:同一条公告常被多站(中国美协→省美协)镜像,按归一标题拦截,避免重复入库
  const existTitles = new Set((existing.opportunities || []).map(o => normTitle(o.title_zh || o.title_en || "")).filter(Boolean));
  const seenNewTitles = new Set();
  const out = [];

  for (const listUrl of LIST_URLS) {
    let host; try { host = new URL(listUrl).host; } catch (e) { continue; }
    const domain = host.replace(/^www\./, "");
    if (!allowed.has(host) && !allowed.has(domain)) continue;   // 只跑已确认高产源
    let f;
    try { f = await fetchSource({ url: listUrl, domain: host, type: "html" }, null, { timeoutMs: 10000 }); }
    catch (e) { totalErr++; console.log(`SRC-ERR ${domain}`); continue; }
    if (f.skipped || !f.rawHtml) { console.log(`SRC-skip ${domain} (${f && f.reason})`); continue; }
    const links = discoverDetailLinks(f.rawHtml, listUrl, domain, { cap: DISCOVER_CAP });
    // 过滤:只保留文本像征稿/展览/招募/大赛/驻留的详情;并剔除「已结束/已公布/获奖名单/结果公示」等非在招条目(省提取开销)
    const opp = links.filter(l => /(征集|征稿|招募|驻留|双年展|三年展|大赛|展览|申报|推优|人才培养|作品展)/.test(l.text || "")
      && !/(已结束|已截止|已公布|获奖名单|获奖作品|结果公布|评审结果|入选名单|入围名单|结果公示|获奖公示)/.test(l.text || ""));
    console.log(`\n=== ${domain}: 详情 ${links.length}, 征稿类 ${opp.length} ===`);
    const cands = [];
    for (const l of opp) {
      if (cands.length >= DETAIL_CAP) break;
      const u0 = (l.url || "").split("#")[0];
      if (existUrls.has(u0)) { console.log(`  skip(已入库) ${u0}`); continue; }
      existUrls.add(u0);   // 同一详情页可能被多个列表页(首页+频道页)同时列出,标记后本批不再重复抓取/提取
      cands.push({ l, u0 });
    }
    // 并发处理详情(每条 = 抓原文 + LLM 提取 + 校验,串行太慢),CONC 默认 4
    const results = [];
    let ci = 0;
    async function worker() {
      while (ci < cands.length) {
        const { l, u0 } = cands[ci++];
        const rec = await processDetail(l, u0, { host, domain, listUrl });
        if (rec) results.push(rec);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, cands.length || 1) }, worker));
    // 归一标题判重后再并入(同一公告被多站镜像时只留一条)
    for (const rec of results) {
      const nt = normTitle(rec.title_zh || rec.title_en || "");
      if (nt && (existTitles.has(nt) || seenNewTitles.has(nt))) { totalDropped++; console.log(`  drop(标题已存在) ${rec.title_zh}`); continue; }
      if (nt) { existTitles.add(nt); seenNewTitles.add(nt); }
      console.log(`  ✓ ${rec.title_zh} | dl=${rec.deadline || "?"}`);
      out.push(rec);
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