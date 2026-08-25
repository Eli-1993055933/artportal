// server.mjs —— 本地一体化服务:①托管静态站(site/) ②提供"按需 AI 检索"接口 /api/search
//
// 「搜索即检索」闭环(严守反幻觉红线,与每日管道同一套校验):
//   用户搜关键词 → 必应(cn.bing,免费兜底)找相关官网页 → 抓官网原文 → DeepSeek 提取+逐字 evidence
//   → verify.mjs 程序校验 evidence 是原文子串 → 只有真实、校验通过的才写入 opportunities.json
// 数量尽力(默认目标 6),真实优先:某词真实只找到 3 条就是 3 条,绝不编造凑数。
//
// 启动:  set -a && . ./.env && set +a && node server.mjs   (需 DEEPSEEK_API_KEY)
// 搜索环节用 DDG lite(免密钥);上线到大陆生产环境时可换成正规搜索 API(见 README)。

import { createServer, request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, stat, rename, mkdir, unlink, statfs, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, sep } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";
import { extract } from "./lib/extract.mjs";
import { verifyRecord, isParseableDate } from "./lib/verify.mjs";
import * as auth from "./lib/auth.mjs";
import { isThirdParty, isTrustedPlatform } from "./lib/aggregators.mjs";
import { ipRegion } from "./lib/ipregion.mjs";
import { searchWeb, BLOCK, unsafeHost, serperBudgetLeft, serperUsageToday, braveBudgetLeft, braveUsageToday } from "./lib/websearch.mjs";
import { extractGlmFree } from "./lib/extract.mjs";
import { CHANNELS, harvestChannel } from "./lib/channels.mjs";
import { leadsTick } from "./lib/leads.mjs";
import { feedbackAgentTick } from "./lib/feedback.mjs";
import { inspectChannel } from "./lib/qc.mjs";
import { moderateText } from "./lib/moderation.mjs";
import { fillGeoFallback } from "./lib/geolocation-fallback.mjs";
import * as db from "./lib/db.mjs";
import { generateWeekly, readWeekly, readWeeklyIndex, weekIdOf, renderEmailHtml, renderEmailText, generatePersonalSummary } from "./lib/weekly.mjs";
import { mailerOn, sendMail } from "./lib/mailer.mjs";
import { loadRegions, dueNow, pickQueries, dayIndex, rosterView, recordShift, reportView, setShortagePool, getShortagePool } from "./lib/regions.mjs";
import { computeShortageTerms } from "./balance.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dir, "..", "site");
const DATA = join(SITE, "data", "opportunities.json");
const PORT = process.env.PORT || 8080;
await auth.initAuth();   // 先加载用户/会话,再开始接请求

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function slug(s) { return String(s).toLowerCase().replace(/[^\w一-龥]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item"; }
function computeStatus(deadline) { return deadline && deadline < todayISO() ? "expired" : "open"; }
function hostOf(u) { try { return new URL(u).host; } catch (e) { return ""; } }
// 机构官网/官方来源的强信号:美院(edu.cn)、政府美术馆(gov)、机构基金(org.cn)、博物馆(museum)、科研(ac.cn)。
// 命中 = 大概率第一手官网;不命中 = 无法确认是官网(可能是二手转载),标注上要如实说明。
function officialHint(host) {
  // 机构官网/官方源强信号:中国(edu.cn/gov.cn/org.cn/ac.cn)+ 国际(museum/edu/ac.uk/org.uk/org/gov)。
  // 国际官方站不再被排到末尾(此前只认 .cn,LA/NYC 的 .org/.edu 机构总凑不够 6 条轮不到)。
  return /(\.edu\.cn|\.gov\.cn|\.org\.cn|\.ac\.cn|\.museum|\.ac\.uk|\.org\.uk|\.edu|\.gov|\.org)$/i.test(String(host)) ? 1 : 0;
}

// —— 收藏解析(v0.73.0 四频道收藏):把命名空间键(机会=裸 id;news:/job:/work: 前缀)
//    还原成可渲染/可撰稿的对象。opp/news/jobs 读静态 JSON(30s 轻缓存),works 读 SQLite。
const FAV_FILES = { opportunities: ["opportunities.json", "opportunities"], news: ["news.json", "items"], jobs: ["jobs.json", "jobs"] };
let _favMaps = { at: 0, m: {} };
async function favChannelMap(ch) {
  if (Date.now() - _favMaps.at > 30000) _favMaps = { at: Date.now(), m: {} };
  if (_favMaps.m[ch]) return _favMaps.m[ch];
  const map = new Map();
  try {
    const [file, key] = FAV_FILES[ch];
    const doc = JSON.parse(await readFile(join(SITE, "data", file), "utf8"));
    for (const o of (doc[key] || [])) map.set(String(o.id), o);
  } catch (e) {}
  _favMaps.m[ch] = map;
  return map;
}
function parseFavKey(k) {
  k = String(k);
  if (k.startsWith("news:")) return { key: k, ch: "news", id: k.slice(5) };
  if (k.startsWith("job:")) return { key: k, ch: "jobs", id: k.slice(4) };
  if (k.startsWith("work:")) return { key: k, ch: "works", id: k.slice(5) };
  return { key: k, ch: "opportunities", id: k };
}
// 返回 [{ key, channel, item }]（保持输入顺序,解析不到的跳过）
async function resolveFavorites(keys) {
  const parsed = (keys || []).slice(0, 2000).map(parseFavKey);
  const worksById = new Map();
  const workIds = parsed.filter(x => x.ch === "works").map(x => x.id);
  if (workIds.length) {
    try {
      const rows = await db.worksByIds(workIds);
      const mini = auth.usersMini([...new Set(rows.map(w => w.uid))]);
      const byU = new Map(mini.map(x => [x.id, x]));
      for (const w of rows) worksById.set(String(w.id), {
        id: w.id, uid: w.uid, title: w.title, description: w.description || "",
        n: w.images.length, tags: w.tags || [], images: w.images.map(n => "assets/works/" + n),
        author: byU.get(w.uid) || null
      });
    } catch (e) {}
  }
  const out = [];
  for (const x of parsed) {
    if (x.ch === "works") { const o = worksById.get(x.id); if (o) out.push({ key: x.key, channel: "works", item: o }); continue; }
    const map = await favChannelMap(x.ch);
    const o = map.get(String(x.id));
    if (o) out.push({ key: x.key, channel: x.ch, item: o });
  }
  return out;
}

// —— 个人专属总结存储(v0.73.0):私密,存服务器 state 目录,绝不进公开 site/data。
//    走登录鉴权 API 读写(GET /api/summary 只回本人的);后台可查全部。
const SUMMARY_DIR = join(__dir, "state", "summaries");
const SUMMARY_COOLDOWN_MS = 20 * 60 * 1000;    // 再生成冷却 20 分钟(防刷 AI 成本)
function validUid(uid) { return /^u[0-9a-f]{8,20}$/.test(String(uid || "")); }
async function readSummary(uid) {
  if (!validUid(uid)) return null;
  try { return JSON.parse(await readFile(join(SUMMARY_DIR, uid + ".json"), "utf8")); } catch (e) { return null; }
}
async function writeSummary(uid, data) {
  if (!validUid(uid)) return;
  await mkdir(SUMMARY_DIR, { recursive: true });
  const f = join(SUMMARY_DIR, uid + ".json");
  const tmp = f + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, f);
}
// 新周刊出刊 → 给所有用户各发一条站内通知(铃铛提示),点开进 #/w/<期号>。
// 站内通知面向全体用户(低打扰);邮件才受"订阅"开关约束。
async function notifyWeeklyPublished(report) {
  if (!report || !report.id) return;
  try {
    const uids = auth.allUserIds();
    if (uids.length) await db.notifyBroadcast(uids, { type: "weekly", refkey: "weekly:" + report.id, ref: { id: report.id, title: report.title } });
  } catch (e) {}
}
async function listSummaries() {
  try {
    const files = await readdir(SUMMARY_DIR);
    const out = [];
    for (const fn of files) {
      if (!fn.endsWith(".json")) continue;
      try {
        const s = JSON.parse(await readFile(join(SUMMARY_DIR, fn), "utf8"));
        out.push({ uid: s.uid || fn.replace(/\.json$/, ""), nickname: s.nickname || "", title: s.title || "",
          generated_at: s.generated_at || "", fav_count: s.fav_count || 0, refs: (s.references || []).length });
      } catch (e) {}
    }
    out.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
    return out;
  } catch (e) { return []; }
}

// —— 环节①:搜索,拿到候选官网 URL ——
// searchWeb / 噪声域名 BLOCK 已抽到 lib/websearch.mjs(三频道共用,serper 优先、DDG 兜底)。

// —— 主流程:检索并入库 ——
// —— 并发控制基础设施(拆掉原来的全局独占锁,支持多人同时各跑各的)——
// 1) 写库串行锁:抓取/校验全程并发,只有"读文件→再去重→追加→写文件"这一小步串行,避免并发写互相覆盖丢数据。
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const p = writeChain.then(fn, fn);
  writeChain = p.then(() => {}, () => {});
  return p;
}
// 区域经理「立即上班」句柄(在下方调度块里赋值;/admin 手动排班用)
let regionRunNow = null;
// 2) 并发信号量:同时进行的检索上限;超出的"排队等待"(不是拒绝)。检索大多在等网络IO,故上限可较高。
const MAX_CONCURRENT = Math.max(4, Number(process.env.MAX_CONCURRENT || 24));
let running = 0;
const waiters = [];
function acquireSlot() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise(res => waiters.push(res));
}
function releaseSlot() {
  if (waiters.length) waiters.shift()();     // 名额直接交给下一个排队者(running 不变)
  else running--;
}
// 3) 相同关键词短时去重:同词 8 分钟内不重复全网检索(结果已在库),省 API 费、防重复;进行中的也挡住。
const recentQ = new Map();                   // q(小写) -> 完成时间戳
const inFlight = new Set();                  // 正在检索中的词(小写)
const QUERY_TTL = 8 * 60 * 1000;
function recentlyDone(q) { const t = recentQ.get(q); return t && (Date.now() - t < QUERY_TTL); }
// 4) 简易 IP 限频:同一来源每分钟检索上限,防单人狂刷烧钱。
// ★ v0.97.0 现场化:展会/学校/公司都是一个出口 IP 后面几十上百人(NAT),原来的 4 次/分
//   等于"整个会场每分钟只能检索 4 次"。放宽到 12;**真正的成本闸是 SERPER_DAILY_BUDGET
//   日预算(超了自动降级 DDG,不烧钱)**,IP 限频只用来挡住单机脚本狂刷。
const ipHits = new Map();                    // ip -> [时间戳...]
const IP_WINDOW = 60 * 1000, IP_MAX = Math.max(2, Number(process.env.RL_SEARCH_PER_MIN || 12));
function rateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < IP_WINDOW);
  if (arr.length >= IP_MAX) { ipHits.set(ip, arr); return true; }
  arr.push(now); ipHits.set(ip, arr);
  return false;
}

// hint(v0.98.0 区域经理):地区本就已知时直接把 gl/hl/地点别名给死,【跳过 AI 意图理解】。
//   两个好处:①省一次 AI 调用(每班一次,天天在跑)②不会猜错——日志实证 AI 把"北欧"
//   猜成 gl=dk(丹麦),整轮检索就偏到丹麦去了。用户手动检索(地区未知)仍走 AI 理解,不变。
async function searchAndHarvest(query, target = 6, hint = null, who = null) {
  who = who || (hint ? "region" : "user");   // serper 分桶审计(v1.5.0):区域班默认 region,其余默认 user,调用方可显式覆盖
  const intent = hint ? null : await understandQuery(query);
  const loc = hint ? (hint.location || null) : (intent && intent.location ? String(intent.location).trim() : null);
  // 地点的中英文/别名数组(供相关性匹配,防"洛杉矶"匹配不到"Los Angeles");无则回退单地点
  const locTerms = hint
    ? (Array.isArray(hint.terms) ? hint.terms.filter(Boolean).map(String) : [])
    : ((intent && Array.isArray(intent.location_terms) && intent.location_terms.length)
        ? intent.location_terms.map(s => String(s).trim()).filter(Boolean) : (loc ? [loc] : []));
  // 检索地域/语言(2026-07-20):国际地点用 gl=us/hl=en,否则默认中国区中文——否则国际站被 Google 严重降权
  const gl = hint ? String(hint.gl || "cn").toLowerCase() : ((intent && intent.gl) ? String(intent.gl).toLowerCase() : "cn");
  const hl = hint ? String(hint.hl || "zh-cn") : ((intent && intent.hl) ? String(intent.hl) : "zh-cn");
  const cnRegion = /^(cn|hk|tw|mo)$/.test(gl);
  process.stderr.write(hint
    ? "  [区域] " + (hint.label || loc || "—") + " 区域=" + gl + "(已知地区,跳过意图理解)\n"
    : "  [意图] 地点=" + (loc || "—") + " 领域=" + ((intent && intent.subject) || "—") + " 区域=" + gl + "\n");
  // 官网限定查询按区域自适应:中国/港澳台用 .cn/.hk/.tw 官方后缀;国际用 .org/.edu/.gov/.museum/.ac.uk
  const OFFICIAL_SITES = cnRegion
    ? "(site:edu.cn OR site:org.cn OR site:gov.cn OR site:ac.cn OR site:museum OR site:org.hk OR site:gov.tw OR site:org.tw)"
    : "(site:.org OR site:.edu OR site:.gov OR site:.museum OR site:.ac.uk OR site:.org.uk)";
  // 区域经理的词池本就是人工调好的成品(已含 open call / 征集 等意图词),不再派生三条变体:
  // 每班从 4 次 serper 降到 2 次(官网限定 + 原词),同样的预算能多排一倍班次。
  const baseQ = hint
    ? [query]
    : ((intent && Array.isArray(intent.search_queries) && intent.search_queries.length)
        ? intent.search_queries.slice(0, 3).map(String)
        : [query + " 艺术 驻留 征集 报名", query + " 展览 征集 大赛 奖 官网", query + " art residency open call apply"]);
  const queries = [(baseQ[0] || query) + " " + OFFICIAL_SITES].concat(baseQ);   // ① 官网限定 + ②③④ 意图查询
  const rawUrls = [];
  for (const q of queries) {
    rawUrls.push(...await searchWeb(q, { gl, hl, who }));
    await new Promise(r => setTimeout(r, 800)); // 对搜索端点客气一点
  }
  // 候选去重 + 过滤噪声
  const seen = new Set(), cands = [];
  for (const u of rawUrls) {
    let host; try { host = new URL(u).host; } catch (e) { continue; }
    // 垃圾第三方(新闻转载/杂志/设计赛事门户/文档托管/社媒)不采;裸IP/内网 host 不抓(SSRF闸)。
    // L1(v0.76.0):可信机会平台(CaFÉ/artcall/curatorspace/resartis 等)【放行】——国际机会常只在这上面,
    // 入库如实标"平台登记·非官网直采",反幻觉 evidence 校验照旧。
    if (BLOCK.test(u) || (isThirdParty(u) && !isTrustedPlatform(u)) || unsafeHost(host)) continue;
    const key = u.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push(key);
  }
  // 官网优先:机构官网特征的候选排到最前,先抓第一手;二手转载排后(常常凑够 6 条就轮不到它)
  cands.sort((a, b) => officialHint(hostOf(b)) - officialHint(hostOf(a)));

  // 现有库(去重基底)
  const doc = JSON.parse(await readFile(DATA, "utf8"));
  const existIds = new Set(doc.opportunities.map(o => o.id));
  const existUrls = new Set(doc.opportunities.map(o => normUrl(o.url)));   // v1.14.0 归一化 URL 去重

  const added = [], log = [];
  let probed = 0;
  const MAX_PROBE = 16;                          // 最多探测这么多候选,控制耗时
  const t0 = Date.now();
  const BUDGET = 110000;                         // 总检索时间预算:超 110 秒就返回已收集的,别让请求无限跑
  for (const url of cands) {
    if (added.length >= target || probed >= MAX_PROBE) break;
    if (Date.now() - t0 > BUDGET) { log.push("time-budget-reached"); break; }
    if (existUrls.has(normUrl(url))) continue;
    probed++;
    let host; try { host = new URL(url).host; } catch (e) { continue; }
    const domain = host.replace(/^www\./, "");
    let f;
    try { f = await fetchSource({ url, domain: host, type: "html" }); }
    catch (e) { log.push("fetch-error " + host); continue; }
    if (f.skipped || !f.text || f.text.length < 200) { log.push("skip " + host + " " + (f.reason || "thin")); continue; }
    let ex;
    try { ex = await extract(f.text, { org_zh: "", domain: host, url, source_url: url, sourceText: f.text }); }
    catch (e) { log.push("extract-fail " + host); continue; }
    const v = verifyRecord(ex.data, { sourceText: f.text, url, source_url: url, domain: host });
    if (v.dropped) { log.push("dropped " + host + " " + v.dropReason.slice(0, 40)); continue; }
    // v1.14.0 检索路径无日期闸:无 deadline 且非常年标注 → 不进库。
    // 检索路径与每日管道同源(gradeTrust 判 pending),但检索无 review-queue 机制,直接 drop 更安全——
    // 否则 AI 漏提截止的机会经此路径 trust:"auto" 硬上线,前端"隐藏已截止"对它无效,污染全库。
    if (!v.flags.hasDeadline) { log.push("dropped no-deadline " + host); continue; }
    const rec = finalize(v.record, url, host);
    if (locTerms.length && !matchLocation(rec, locTerms)) { log.push("跑题(不含 " + loc + ") " + host); continue; }   // 地点相关性过滤(中英别名任一命中即可)
    if (existIds.has(rec.id) || added.find(a => a.id === rec.id)) continue;
    added.push(rec);
    log.push("✓ " + rec.title_zh);
  }

  // 写入库(串行临界区:读最新→再去重→追加→写)。抓取/校验已在锁外并发完成,故不阻塞别人。
  let saved = added;
  if (added.length) {
    saved = await withWriteLock(async () => {
      const cur = JSON.parse(await readFile(DATA, "utf8"));
      const ids = new Set(cur.opportunities.map(o => o.id));
      const urls = new Set(cur.opportunities.map(o => normUrl(o.url)));   // v1.14.0 归一化 URL 并发下去重
      const fresh = added.filter(o => {
        if (ids.has(o.id)) return false;
        const nu = normUrl(o.url);
        return !nu || !urls.has(nu);              // 归一化失败(空)时不参与 URL 去重,仍有 id 兜底
      });
      if (fresh.length) {
        cur.opportunities.push(...fresh);
        cur.count = cur.opportunities.length;
        await writeFile(DATA, JSON.stringify(cur, null, 2), "utf8");
      }
      return fresh;
    });
  }
  // P5(补源信号):这次检索一条都没收进来,记下词+区域+探测规模,供人工看板判断该往哪补源。
  if (!saved.length) db.logZeroQuery({ q: query, who, gl, hl, probed, candidates: cands.length }).catch(() => {});
  return { added: saved, probed, candidates: cands.length, log };
}

function finalize(rec, url, host) {
  const dom = host.replace(/^www\./, "");
  const id = "search-" + dom.split(".")[0] + "-" + slug(rec.title_zh || rec.title_en || "item");
  const today = todayISO();
  // 地理信息兜底:如果 AI 没有提取到城市/国家,尝试从原文和域名推断
  const geoCtx = { domain: dom, source_url: url };
  const geoFilled = fillGeoFallback(rec, geoCtx, rec._sourceText || "");
  return {
    id,
    category: rec.category || "opencall",
    title_zh: rec.title_zh || null, title_en: rec.title_en || null,
    org_zh: rec.org_zh || null,
    city_zh: geoFilled.city_zh || "未知", country_zh: geoFilled.country_zh || "未知",
    deadline: rec.deadline || null, deadline_note: rec.deadline_note || "",
    apply_fee: rec.apply_fee || { free: null, amount: null, currency: null },
    participation_fee: rec.participation_fee || { required: null, amount: null, currency: null },
    funding: rec.funding || { stipend: null, housing: null, travel: null },
    eligibility: rec.eligibility || { students_ok: null, age_limit: null, nationality: null },
    disciplines: rec.disciplines || [],
    summary_zh: rec.summary_zh || null,
    url, source_url: url, domain: dom,
    org_type: "official",
    trust: "auto",                    // evidence 已过;前端标"AI 检索·请核对官网"(见 provenance)
    status: computeStatus(rec.deadline),
    // first_seen = 【首次收录日】,写死不再改(v0.98.0)。前端「今日新增/NEW」只认它:
    // added_at 只存在于 83/392 条老数据且早已停更,updated_at 会被每日管道/质检/翻译回填触碰
    // —— 拿这两个判"新",管道跑一晚就会把几百条老条目全标成 NEW。
    verified_at: null, first_seen: today, last_seen: today, updated_at: today, _via: "search"
  };
}

// AI 查询理解:把用户的自由需求拆成结构化检索意图(地点/领域 + 精准查询词)。用 DeepSeek。
async function understandQuery(userQuery) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const sys =
    "你是艺术机会检索的意图理解器。用户在找可申请的艺术展览/驻留/奖项/工作坊/征集等机会。" +
    "把用户这句需求拆成结构化检索意图,只输出一个 JSON,不要任何解释。\n" +
    "字段:\n" +
    "  location: 用户明确提到的地点/城市/地区(如 大理、上海、香港、洛杉矶、纽约、伦敦),没提就 null。\n" +
    "  location_terms: 该地点的中英文/别名数组(便于匹配),如 [\"洛杉矶\",\"Los Angeles\",\"LA\"];没地点就 []。\n" +
    "  subject: 核心领域或形式(如 摄影、版画、驻留、雕塑),没提就 null。\n" +
    "  gl: 该地点所在国家的 Google 国家码(中国大陆=cn,香港=hk,台湾=tw,美国=us,英国=gb,法国=fr,日本=jp,德国=de…);地点为中国或没提地点则 cn。\n" +
    "  hl: 检索界面语言(中国/港澳台=zh-cn,其余非中文地区=en)。\n" +
    "  search_queries: 2-3 条适合直接丢给搜索引擎的精准查询,每条把地点/领域和机会类型词组合好。**关键:地点在非中文国家时,查询主要用当地语言/英文**(open call / call for artists / submissions / residency / grant / apply),配 1 条中文;地点在中国则以中文为主配 1 条英文。\n" +
    "  · **中国的中小城市/地级市(如 呼伦贝尔、德阳、大连、宜昌)专项**:机会多挂在【本地官方机构】页,别只用泛泛的'城市+艺术+征集'(会被全国结果和媒体/百科淹没)。查询要点名本地机构类型:美术馆/文化馆/群众艺术馆/画院/文联/文旅局(文旅广电局)/艺术学院,配 展览/征集/招募/驻留/大赛,并带上所在省份(如'内蒙古 呼伦贝尔''四川 德阳')。\n" +
    '例 "大理" -> {"location":"大理","location_terms":["大理","Dali"],"subject":null,"gl":"cn","hl":"zh-cn","search_queries":["大理 艺术 驻留 征集 报名","大理 展览 征集 美术馆 艺术中心 官网","Dali Yunnan art residency open call"]}\n' +
    '例 "洛杉矶" -> {"location":"洛杉矶","location_terms":["洛杉矶","Los Angeles","LA"],"subject":null,"gl":"us","hl":"en","search_queries":["Los Angeles art exhibition open call for artists submissions","Los Angeles artist residency grant apply 2026","洛杉矶 艺术 展览 征集"]}\n' +
    '例 "呼伦贝尔"(中国中小城市)-> {"location":"呼伦贝尔","location_terms":["呼伦贝尔","Hulunbuir"],"subject":null,"gl":"cn","hl":"zh-cn","search_queries":["呼伦贝尔 美术馆 文化馆 群众艺术馆 展览 征集 招募","内蒙古 呼伦贝尔 文旅局 画院 艺术项目 征集 大赛","呼伦贝尔 艺术空间 驻留 招募 官网"]}\n' +
    '例 "面向青年的免费版画奖" -> {"location":null,"location_terms":[],"subject":"版画","gl":"cn","hl":"zh-cn","search_queries":["版画 奖 青年 征集 报名","青年 版画 大赛 征稿 申请","printmaking award young artists open call"]}';
  // 重试(2026-07-20):意图解析是检索的舵。此前无重试,批量/突发时 DeepSeek 被 extract 打满 → 偶发限流/超时
  //   → 返 null → 退回默认 cn 区 → 国际地点(纽约/伦敦)搜成无关中国结果。限流/5xx/超时/解析失败都退避重试。
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.EXTRACT_MODEL || "deepseek-chat",
          temperature: 0.2, max_tokens: 400, response_format: { type: "json_object" },
          messages: [{ role: "system", content: sys }, { role: "user", content: "用户需求:" + userQuery }]
        }),
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) { if (res.status === 429 || res.status >= 500) { await sleep(600 * (attempt + 1)); continue; } break; }   // 4xx(欠费等)不重试,转免费兜底
      const j = await res.json();
      const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      const m = /\{[\s\S]*\}/.exec(raw);
      if (m) { try { return JSON.parse(m[0]); } catch (e) { /* 解析失败→重试 */ } }
      await sleep(400);
    } catch (e) { await sleep(600 * (attempt + 1)); }   // 超时/网络错→退避重试
  }
  // DeepSeek 不可用(欠费/连败)→ 免费 GLM 兜底一把:意图解析是检索的舵,能扶就扶
  try { const g = await extractGlmFree(sys, "用户需求:" + userQuery, 400); if (g && g.data) return g.data; } catch (e) {}
  return null;
}
// 相关性把关:机会文本是否包含用户指定地点的任一别名(中英,硬约束);全不含则判跑题、丢弃。
// haystack 兼含中英字段,防"洛杉矶"匹配不到 city_en="Los Angeles"。
function matchLocation(rec, locTerms) {
  const terms = Array.isArray(locTerms) ? locTerms : (locTerms ? [locTerms] : []);
  if (!terms.length) return true;
  const hay = ((rec.title_zh || "") + (rec.title_en || "") + (rec.city_zh || "") + (rec.city_en || "") +
    (rec.country_zh || "") + (rec.country_en || "") + (rec.org_zh || "") + (rec.org_en || "") +
    (rec.summary_zh || "") + (rec.summary_en || "")).toLowerCase();
  return terms.some(t => t && hay.indexOf(String(t).toLowerCase()) !== -1);
}

// —— 静态文件服务 ——
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff" };
async function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); }
  catch (e) { res.writeHead(400); return res.end("bad request"); }   // 畸形百分号(如 /%)会抛 URIError,兜住防崩
  if (p === "/") p = "/index.html";
  const full = normalize(join(SITE, p));
  // 结尾补分隔符防"同前缀兄弟目录"越界(SITE 与 SITE + "extra" 的前缀陷阱)
  if (full !== SITE && !full.startsWith(SITE + sep)) { res.writeHead(403); return res.end("forbidden"); }
  try {
    const s = await stat(full);
    if (s.isDirectory()) { res.writeHead(403); return res.end(); }
    const ext = extname(full);
    // HTML 绝不缓存(每次拿最新 ?v= 引用);带 ?v= 的资源与不可变数据(vendor/geo/封面/作品图)
    // 长缓存 immutable;其余数据(opportunities/news/jobs 等,每日更新)5 分钟 + Last-Modified 304 协商。
    // 头像路径固定、内容会换,不进长缓存。
    const isHtml = ext === ".html" || p === "/index.html";
    const hasV = /[?&]v=/.test(req.url);
    const longCache = hasV || p.startsWith("/assets/vendor/") || p.startsWith("/data/geo/") ||
      p.startsWith("/assets/covers/") || p.startsWith("/assets/works/");
    const cc = isHtml ? "no-store, no-cache, must-revalidate"
      : longCache ? "public, max-age=604800, immutable" : "public, max-age=300";
    const lm = new Date(s.mtimeMs).toUTCString();
    if (!isHtml && req.headers["if-modified-since"] === lm) {
      res.writeHead(304, { "Cache-Control": cc, "Last-Modified": lm, "Vary": "Accept-Encoding" });
      return res.end();
    }
    let body = await readFile(full);
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cc,
      "Last-Modified": lm, "Vary": "Accept-Encoding" };
    // gzip:文本类且客户端支持;按 mtime 缓存压缩结果(上限防内存膨胀)
    if (GZ_TYPES.has(ext) && body.length > 1024 && String(req.headers["accept-encoding"] || "").includes("gzip")) {
      let e = gzCache.get(full);
      if (!e || e.mtimeMs !== s.mtimeMs) {
        e = { mtimeMs: s.mtimeMs, buf: gzipSync(body, { level: 6 }) };
        gzCache.set(full, e);
        if (gzCache.size > 150) gzCache.delete(gzCache.keys().next().value);
      }
      body = e.buf; headers["Content-Encoding"] = "gzip";
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (e) { res.writeHead(404); res.end("not found"); }
}
const GZ_TYPES = new Set([".html", ".css", ".js", ".json", ".svg"]);
const gzCache = new Map();   // full path -> {mtimeMs, buf}

// 请求体读取(JSON,默认限 256KB;投稿带压缩封面 base64 时调用方放宽到 ~900KB)
function readBody(req, max = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > max) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
// 客户端 IP:默认只信 socket 真实地址(裸奔直连时 X-Forwarded-For 可被任意伪造,
// 若信它则所有限频形同虚设)。套 nginx 反代后设 TRUST_PROXY=1。
// ★ 取值顺序修正(v0.97.0):优先 X-Real-IP —— nginx 配的是 `X-Real-IP $remote_addr`,
//   恒等于真实 peer,客户端伪造不了;而 XFF 用的是 `$proxy_add_x_forwarded_for`
//   =「客户端自带的 XFF, 真实IP」,**首值恰恰是客户端可自填的**,拿首值做限频等于留了个绕过口。
//   故 XFF 兜底时取【最后一跳】(nginx 追加的那个才是真的)。
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ipOf = req => {
  if (TRUST_PROXY) {
    const real = req.headers["x-real-ip"];
    if (real) return String(real).trim();
    const xff = req.headers["x-forwarded-for"];
    if (xff) { const a = String(xff).split(","); return a[a.length - 1].trim(); }
  }
  return String(req.socket.remoteAddress || "?");
};

// —— 用户投稿(路线图第3项;v0.72.0 扩展为统一发布:机会/招聘/资讯,作品走 /api/works):
//    登录用户投稿 → 敏感词+机审 → SQLite 待审/AI 干净即发 → 发布到对应频道数据 ——
const CATS = ["opencall", "residency", "award", "workshop"];
const EMP_TYPES = ["全职", "兼职", "实习", "合约", "志愿者", "其他"];
// URL 规范化比对:防加 query/fragment/尾斜杠变体绕过"同链接已收录"查重。
// 只做安全规范化(去 #、去尾斜杠、域名小写、剔跟踪参数并排序)——不同 query 可能是不同职位页,不整段丢弃。
function normUrl(u) {
  try {
    const x = new URL(String(u || "").trim());
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^(utm_\w+|fbclid|gclid|spm|ref)$/i.test(k)) x.searchParams.delete(k);
    x.searchParams.sort();
    const q = x.searchParams.toString();
    return x.protocol.toLowerCase() + "//" + x.host.toLowerCase() + x.pathname.replace(/\/+$/, "") + (q ? "?" + q : "");
  } catch (e) { return String(u || "").trim(); }
}
function checkUrl(url, label) {
  if (!/^https?:\/\/.{4,300}$/i.test(url)) return label + "需以 http(s):// 开头";
  let host; try { host = new URL(url).host; } catch (e) { return label + "格式不正确"; }
  if (unsafeHost(host) || BLOCK.test(url)) return "该链接不可用(请填原始/官方网址)";
  return null;
}
function validateSubmission(b) {
  const s = v => String(v == null ? "" : v).trim();
  const kind = ["job", "news"].includes(b.kind) ? b.kind : "opp";
  const title = s(b.title), url = s(b.url);
  const summary = s(b.summary).slice(0, 500);
  const deadline = s(b.deadline);
  if (deadline) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return { error: "日期格式应为 YYYY-MM-DD" };
    const dt = new Date(deadline + "T00:00:00Z");   // 真实日历校验:挡 2026-99-99 这类合法格式的假日期
    if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== deadline) return { error: "日期无效,请检查年月日" };
  }
  // —— 招聘投稿:职位/机构/申请链接必填 ——
  if (kind === "job") {
    const org = s(b.org), city = s(b.city).slice(0, 40), country = s(b.country).slice(0, 40);
    const salary = s(b.salary).slice(0, 40);
    const employment_type = EMP_TYPES.includes(s(b.employment_type)) ? s(b.employment_type) : null;
    if (title.length < 2 || title.length > 80) return { error: "职位名称需 2–80 字" };
    if (org.length < 2 || org.length > 80) return { error: "机构名称需 2–80 字" };
    if (!url) return { error: "请填写申请链接(官网招聘页/招聘启事原文)" };
    const ue = checkUrl(url, "申请链接"); if (ue) return { error: ue };
    return { data: { kind, title, org, city: city || null, country: country || null, employment_type, salary: salary || null, deadline: deadline || null, summary: summary || null, url } };
  }
  // —— 资讯投稿:标题/来源/原文链接必填 ——
  if (kind === "news") {
    const source = s(b.source).slice(0, 40);
    if (title.length < 4 || title.length > 120) return { error: "资讯标题需 4–120 字" };
    if (source.length < 2) return { error: "请填写来源名称(媒体/机构)" };
    if (!url) return { error: "请填写原文链接" };
    const ue = checkUrl(url, "原文链接"); if (ue) return { error: ue };
    // 发布日期钳制到今天:防伪造未来日期在资讯频道(按日期倒序)永久置顶
    const today = todayISO();
    return { data: { kind, title, source, published_at: deadline ? (deadline > today ? today : deadline) : null, summary: summary || null, url } };
  }
  // —— 机会投稿(原有逻辑) ——
  const org = s(b.org), category = s(b.category);
  const source_note = s(b.source_note).slice(0, 150);
  const city = s(b.city).slice(0, 40), country = s(b.country).slice(0, 40);
  const cover = typeof b.cover === "string" ? b.cover : "";
  if (title.length < 2 || title.length > 120) return { error: "标题需 2–120 字" };
  if (org.length < 2 || org.length > 80) return { error: "主办方需 2–80 字" };
  if (!CATS.includes(category)) return { error: "请选择类别" };
  if (source_note.length < 2) return { error: "请注明信息来源(如:机构公众号/官网/海报等)" };
  if (url) { const ue = checkUrl(url, "官网链接"); if (ue) return { error: ue }; }
  if (cover) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(cover) || cover.length > 850000) return { error: "封面图无效或过大" };
    try { if (Buffer.from(cover.slice(23), "base64").length > 600000) return { error: "封面图过大" }; }
    catch (e) { return { error: "封面图无效" }; }
  }
  return { data: { kind: "opp", title, org, category, url: url || null, source_note, city: city || null, country: country || null, deadline: deadline || null, summary: summary || null, cover: cover || null } };
}
// 通过的投稿 → 机会记录(trust:"user" 打"用户投稿·未经核实"标;绝不冒充官网直采)
// 官网链接选填:无链接时"前往官网"呈禁用态,来源说明(source_note)在详情页如实展示。
function submissionToOpportunity(p, subId) {
  const today = todayISO();
  let dom = ""; try { if (p.url) dom = new URL(p.url).host.replace(/^www\./, ""); } catch (e) {}
  return {
    id: "submit-" + subId,
    category: p.category, title_zh: p.title, title_en: null,
    org_zh: p.org || null, city_zh: p.city || "未知", country_zh: p.country || "未知",
    deadline: p.deadline, deadline_note: "",
    apply_fee: { free: null, amount: null, currency: null },
    participation_fee: { required: null, amount: null, currency: null },
    funding: { stipend: null, housing: null, travel: null },
    eligibility: { students_ok: null, age_limit: null, nationality: null },
    disciplines: [], summary_zh: p.summary,
    url: p.url || null, source_url: p.url || null, domain: dom,
    source_note: p.source_note || null,
    org_type: null, trust: "user",
    status: computeStatus(p.deadline), verified_at: null,
    last_seen: today, updated_at: today, _via: "submit", ip_region: p.ip_region
  };
}

// 通过的投稿发布(AI 自动通过与 admin 人工通过共用):按 kind 发到对应频道数据文件。
// 招聘/资讯与机会同一条红线:标 _via:"submit",前端显示"用户投稿·未经核实",绝不冒充官方直采。
async function publishSubmission(row) {
  const p = row.payload;
  const today = todayISO();
  if (p.kind === "job" || p.kind === "news") {
    const file = join(SITE, "data", p.kind === "job" ? "jobs.json" : "news.json");
    const key = p.kind === "job" ? "jobs" : "items";
    let dom = ""; try { dom = new URL(p.url).host.replace(/^www\./, ""); } catch (e) {}
    const rec = p.kind === "job"
      ? { id: "submit-j" + row.id, title: p.title, title_zh: p.title, org: p.org, org_zh: p.org,
          city: p.city, country: p.country, employment_type: p.employment_type, salary: p.salary,
          deadline: p.deadline, summary: p.summary, summary_zh: p.summary,
          apply_url: p.url, url: p.url, domain: dom, posted_at: today, _via: "submit", ip_region: p.ip_region }
      : { id: "submit-n" + row.id, title: p.title, title_zh: p.title, source: p.source,
          url: p.url, domain: dom, published_at: p.published_at || today,
          summary: p.summary, summary_zh: p.summary, added_at: today, _via: "submit", ip_region: p.ip_region };
    let dup = false;
    await withWriteLock(async () => {
      const cur = JSON.parse(await readFile(file, "utf8"));
      const list = cur[key] || [];
      const urlKey = p.kind === "job" ? "apply_url" : "url";
      if (list.find(x => normUrl(x[urlKey] || x.url) === normUrl(p.url))) { dup = true; return; }   // 同链接已收录(规范化比对)
      if (list.find(x => x.id === rec.id)) rec.id += "-" + Math.random().toString(36).slice(2, 7);
      list.push(rec);
      cur[key] = list;
      if (cur.count != null) cur.count = list.length;
      await writeFile(file, JSON.stringify(cur, null, 2), "utf8");
    });
    return dup ? "duplicate" : "published";
  }
  const rec = submissionToOpportunity(row.payload, row.id);
  // 投稿封面:通过时才落地成文件(待审期间只存 DB,拒绝的不产生文件)
  if (row.payload.cover) {
    try {
      const buf = Buffer.from(String(row.payload.cover).slice(23), "base64");
      if (buf.length > 100 && buf.length <= 600000) {
        await mkdir(join(SITE, "assets", "covers"), { recursive: true });
        const file = "submit-" + row.id + ".jpg";
        await writeFile(join(SITE, "assets", "covers", file), buf);
        rec.cover = "assets/covers/" + file;
        rec.cover_source = "user";
      }
    } catch (e) {}
  }
  let dup = false;
  await withWriteLock(async () => {
    const cur = JSON.parse(await readFile(DATA, "utf8"));
    if (rec.url && cur.opportunities.find(o => normUrl(o.url) === normUrl(rec.url))) { dup = true; return; }   // 同 URL 已收录(规范化比对)
    // id 撞车(如 DB 重建后自增号从头来,撞上历史 submit-N):换随机后缀继续发布,绝不静默丢投稿
    if (cur.opportunities.find(o => o.id === rec.id)) rec.id += "-" + Math.random().toString(36).slice(2, 7);
    cur.opportunities.push(rec);
    cur.count = cur.opportunities.length;
    await writeFile(DATA, JSON.stringify(cur, null, 2), "utf8");
  });
  return dup ? "duplicate" : "published";
}

// —— 作品集(路线图 8.3)——
// 合规关键:待审图片存【非公开目录】pipeline/state/works_pending(直链访问不到),
// 人工审核通过才搬进 site/assets/works/ 公开。文字部分照常机审。
// v0.100.0:拒绝/下架不再立刻删图——图片退回非公开目录留 WORK_RESTORE_DAYS 天反悔窗口,
// 到期由清理任务删。非公开目录始终直链访问不到,留着不影响合规。
const WORKS_PENDING = join(__dir, "state", "works_pending");
const WORKS_PUB = join(SITE, "assets", "works");
const WORK_RESTORE_DAYS = Math.max(1, Number(process.env.WORK_RESTORE_DAYS || 30));
// 距恢复期结束还剩几天(向上取整,>0 才可恢复);没有裁决时间的老数据按可恢复处理,不误伤
function workRestoreDaysLeft(w) {
  if (!w || !w.decided_at) return WORK_RESTORE_DAYS;
  const passed = (Date.now() - Date.parse(w.decided_at)) / 86400e3;
  if (!isFinite(passed)) return WORK_RESTORE_DAYS;
  return Math.max(0, Math.ceil(WORK_RESTORE_DAYS - passed));
}
// 艺术门类 slug 白名单(与前端 site/js/tags.js 的 23 门类一一对应;作品上传自选 ≤3)
const ART_TAGS = new Set([
  "painting", "ink", "printmaking", "illustration", "photography", "sculpture", "installation",
  "video", "animation", "newmedia", "sound", "performance", "theater", "literature", "design",
  "fashion", "architecture", "ceramics", "glass", "textile", "craft", "curation", "mixed"
]);
const WORK_IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const workFileRe = /^w\d+-\d+\.jpg$/;          // 文件名只认我们自己生成的格式(防路径注入)
function validateWork(b) {
  const s = v => String(v == null ? "" : v).trim();
  const title = s(b.title), description = s(b.description).slice(0, 500);
  if (title.length < 2 || title.length > 60) return { error: "作品标题需 2–60 字" };
  // 门类标签:选填,只认白名单 slug,最多 3 个
  const tags = (Array.isArray(b.tags) ? b.tags : []).filter(t => typeof t === "string" && ART_TAGS.has(t)).slice(0, 3);
  const imgs = Array.isArray(b.images) ? b.images : [];
  if (!imgs.length || imgs.length > 9) return { error: "请上传 1–9 张图片" };
  const bufs = [];
  for (const im of imgs) {
    if (typeof im !== "string" || !WORK_IMG_RE.test(im) || im.length > 1000000) return { error: "图片无效或过大(单张压缩后需 ≤700KB)" };
    let buf;
    try { buf = Buffer.from(im.slice(23), "base64"); } catch (e) { return { error: "图片无效" }; }
    if (buf.length < 100 || buf.length > 700000) return { error: "图片无效或过大(单张压缩后需 ≤700KB)" };
    bufs.push(buf);
  }
  return { data: { title, description, tags, bufs } };
}
// 评论可挂的四类内容(机会/资讯/招聘/作品)
const CMT_KINDS = new Set(["opportunity", "news", "job", "work"]);
// 评论可见时给相关人发通知:有 parent → 通知被回复者;顶层挂在作品上 → 通知作品作者
async function notifyForComment(c) {
  const preview = String(c.content).slice(0, 60);
  if (c.parent) {
    const pc = await db.getComment(c.parent);
    if (pc) await db.notify({ uid: pc.uid, type: "reply", actor: c.uid, ref: { kind: c.kind, target: c.target, cid: c.id, preview } });
  } else if (c.kind === "work") {
    const w = await db.getWork(Number(c.target));
    if (w) await db.notify({ uid: w.uid, type: "comment", actor: c.uid, ref: { kind: "work", target: c.target, cid: c.id, preview, title: w.title } });
  }
}
// 作品举报限频(防刷):单 IP 每天 60 次(v0.97.0 由 20 放宽,同一 WiFi 出口可能几十人)
const reportHits = new Map();
function reportLimited(ip) {
  const now = Date.now();
  const arr = (reportHits.get(ip) || []).filter(t => now - t < 24 * 3600e3);
  if (arr.length >= Math.max(5, Number(process.env.RL_REPORT_PER_DAY || 60))) { reportHits.set(ip, arr); return true; }
  arr.push(now); reportHits.set(ip, arr);
  return false;
}
// 反馈限频(v0.83.0,免登录可提所以按 IP):单 IP 每天 40 条(v0.97.0 由 10 放宽,同上)
const FB_TYPES = new Set(["bug", "suggest", "help", "correction", "coop"]);
const fbHits = new Map();
function fbLimited(ip) {
  const now = Date.now();
  const arr = (fbHits.get(ip) || []).filter(t => now - t < 24 * 3600e3);
  if (arr.length >= Math.max(5, Number(process.env.RL_FEEDBACK_PER_DAY || 40))) { fbHits.set(ip, arr); return true; }
  arr.push(now); fbHits.set(ip, arr);
  return false;
}

// —— 墓碑(tombstones):后台删除的记录 id 落此文件,夜间 sync 据此在两侧同删,
//    防止"服务器删了、本机还有 → 合并又复活"。恢复时从墓碑移除。 ——
const TOMB_PATH = join(__dir, "state", "tombstones.json");
// 三频道数据文件映射(admin 内容管理/回收站/下架通用;键名与 sync 墓碑频道名一致)
const CH_FILES = {
  opportunities: [DATA, "opportunities"],
  jobs: [join(SITE, "data", "jobs.json"), "jobs"],
  news: [join(SITE, "data", "news.json"), "items"]
};
async function readTombs() {
  try { return JSON.parse(await readFile(TOMB_PATH, "utf8")); } catch (e) { return {}; }
}
function writeTombs(t) {
  return withWriteLock(async () => {
    const tmp = TOMB_PATH + ".tmp-" + process.pid;
    await writeFile(tmp, JSON.stringify(t, null, 2), "utf8");
    await rename(tmp, TOMB_PATH);
  });
}
async function tombAdd(channel, id) {
  const t = await readTombs();
  (t[channel] || (t[channel] = {}))[id] = new Date().toISOString();
  await writeTombs(t);
}
async function tombRemove(channel, id) {
  const t = await readTombs();
  if (t[channel] && t[channel][id]) { delete t[channel][id]; await writeTombs(t); }
}

// —— 账号 / 统计 / 管理后台 API(实现见 lib/auth.mjs)——
async function handleAuthApi(req, res, u) {
  const json = r => { res.writeHead(r.code, { "Content-Type": "application/json; charset=utf-8", ...(r.headers || {}) }); res.end(JSON.stringify(r.body)); };
  const ip = ipOf(req);
  const p = u.pathname, m = req.method;
  try {
    if (p === "/api/auth/me" && m === "GET") {
      const r = auth.me(req);
      if (r.body && r.body.user) {   // 画室工具入口可见性:严格按该账号在名册里的勾选状态(默认关)
        // 注:isAdmin 是浏览器级管理会话,若用 OR 叠加会把"任意在带管理 cookie 的浏览器里查看的账号"全部误开放,
        //     表现为"后台名册没画勾也照样打开"。故这里只认账号自己的 studio 标志。
        r.body.user.studio = auth.studioEnabled(r.body.user.id);
        // IP 属地合规:每次心跳按当前 IP 刷新用户属地(境内省级/境外国家),主页与列表展示用
        r.body.user.ip_region = auth.touchIpRegion(r.body.user.id, ipRegion(ip));
      }
      return json(r);
    }
    if (p === "/api/auth/register" && m === "POST") { const b = await readBody(req); return json(await auth.register(b, ip)); }
    if (p === "/api/auth/sendcode" && m === "POST") { const b = await readBody(req); return json(await auth.sendEmailCode(b, ip)); }
    if (p === "/api/auth/sendcode-bind" && m === "POST") { const b = await readBody(req); return json(await auth.sendEmailCodeForBind(req, b, ip)); }
    if (p === "/api/auth/sms-code" && m === "POST") { const b = await readBody(req); return json(await auth.sendPhoneCode(b, ip)); }
    if (p === "/api/auth/bind-phone" && m === "POST") { const b = await readBody(req); return json(await auth.bindPhone(req, b, ip)); }
    if (p === "/api/auth/bind-email" && m === "POST") { const b = await readBody(req); return json(await auth.bindEmail(req, b, ip)); }
    if (p === "/api/auth/login" && m === "POST") { const b = await readBody(req); return json(auth.login(b.identifier || b.email, b.password, ip)); }
    if (p === "/api/auth/logout" && m === "POST") return json(auth.logout(req));
    if (p === "/api/auth/profile" && m === "POST") { const b = await readBody(req, 400 * 1024); return json(await auth.setProfile(req, b, ip)); }
    if (p === "/api/favorites" && m === "POST") { const b = await readBody(req); return json(auth.setFavorites(req, b.ids)); }
    // 收藏解析:把收藏键还原成可渲染对象(四频道混合;收藏 tab 展示用)。内容本身公开,无隐私泄露。
    if (p === "/api/favorites/resolve" && m === "POST") {
      const b = await readBody(req);
      const items = await resolveFavorites(Array.isArray(b.keys) ? b.keys : []);
      return json({ code: 200, body: { items } });
    }
    // —— 个人专属总结(v0.73.0):基于本人收藏,复用周刊撰稿管线成文,署名 ArtPortal ——
    if (p === "/api/summary" && m === "GET") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "未登录" } });
      const s = await readSummary(me.id);
      const favN = (me.favorites || []).length;
      return json({ code: 200, body: { summary: s, fav_count: favN, min_favs: 3 } });
    }
    if (p === "/api/summary/generate" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "登录后可生成专属总结" } });
      const prev = await readSummary(me.id);
      if (prev && prev.generated_at && (Date.now() - Date.parse(prev.generated_at)) < SUMMARY_COOLDOWN_MS) {
        const mins = Math.ceil((SUMMARY_COOLDOWN_MS - (Date.now() - Date.parse(prev.generated_at))) / 60000);
        return json({ code: 429, body: { error: "刚生成过,请约 " + mins + " 分钟后再重新生成", summary: prev } });
      }
      const items = await resolveFavorites(me.favorites || []);
      const cand = items.filter(x => x.channel !== "works");   // 文字综述取 机会/资讯/招聘(作品是图片)
      if (cand.length < 3) return json({ code: 400, body: { error: "收藏满 3 条(机会/资讯/招聘)才能生成专属总结,当前 " + cand.length + " 条" } });
      let summary;
      try { summary = await generatePersonalSummary(cand, { nickname: me.nickname || "" }); }
      catch (e) { summary = null; }
      if (!summary || summary.error) return json({ code: 502, body: { error: "生成失败,请稍后再试(需后端配置 DEEPSEEK_API_KEY)" } });
      summary.uid = me.id; summary.nickname = me.nickname || ""; summary.fav_count = cand.length;
      await writeSummary(me.id, summary);
      try { db.agentLog({ agent: "artportal-summary", ok: true, summary: "为用户生成专属总结", metrics: { uid: me.id, refs: (summary.references || []).length } }); } catch (e) {}
      return json({ code: 200, body: { summary } });
    }
    // —— 站内通知(8.4 一期):列表(附未读数与发起人公开摘要)/ 全部已读 ——
    if (p === "/api/notifications" && m === "GET") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "未登录" } });
      try {
        if (u.searchParams.get("count") === "1") {
          return json({ code: 200, body: { unread: await db.notifUnread(me.id) } });   // 轻量轮询只要数字
        }
        const rows = await db.notifList(me.id);
        const mini = auth.usersMini([...new Set(rows.map(n => n.actor).filter(Boolean))]);
        const byId = new Map(mini.map(x => [x.id, x]));
        return json({ code: 200, body: {
          unread: await db.notifUnread(me.id),
          list: rows.map(n => ({ id: n.id, type: n.type, read: !!n.read, created_at: n.created_at, ref: n.ref, actor: n.actor ? (byId.get(n.actor) || null) : null }))
        } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/notifications/read" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "未登录" } });
      try { await db.notifMarkAllRead(me.id); return json({ code: 200, body: { ok: true } }); }
      catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // —— 评论(路线图第 2 项):四类内容通用;AI 先审(pass 即显示,可疑进人工) ——
    if (p === "/api/comments" && m === "GET") {
      const kind = String(u.searchParams.get("kind") || "");
      const target = String(u.searchParams.get("id") || "").slice(0, 200);
      if (!CMT_KINDS.has(kind) || !target) return json({ code: 400, body: { error: "参数不正确" } });
      const viewer = auth.userOf(req);
      try {
        let rows = await db.commentsFor(kind, target, viewer ? viewer.id : null);
        if (viewer) {   // 我拉黑的人,评论对我不可见
          const blocked = await db.blockedSetOf(viewer.id);
          if (blocked.size) rows = rows.filter(c => !blocked.has(c.uid));
        }
        const liked = viewer ? await db.likedSet(viewer.id, kind, target) : new Set();
        const mini = auth.usersMini([...new Set(rows.map(c => c.uid))]);
        const byId = new Map(mini.map(x => [x.id, x]));
        return json({ code: 200, body: { comments: rows.map(c => ({
          id: c.id, parent: c.parent || null, content: c.content, created_at: c.created_at,
          likes: c.likes, liked: liked.has(c.id),
          status: viewer && c.uid === viewer.id ? c.status : "approved",
          ip_region: c.ip_region || null,
          uid: c.uid, author: byId.get(c.uid) || null
        })) } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/comments" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "请先登录再评论" } });
      if (auth.needsPhone(me)) return json({ code: 403, body: { error: "请先绑定手机号完成实名后再发布" } });
      const b = await readBody(req);
      const kind = String(b.kind || ""), target = String(b.target || "").slice(0, 200);
      const content = String(b.content || "").trim().slice(0, 500);
      if (!CMT_KINDS.has(kind) || !target) return json({ code: 400, body: { error: "参数不正确" } });
      if (content.length < 1) return json({ code: 400, body: { error: "评论不能为空" } });
      try {
        if (!(await db.commentRateOk(me.id))) return json({ code: 429, body: { error: "今天评论太多了,明天再来" } });
        let parent = Number(b.parent) || null;
        if (parent) {
          const pc = await db.getComment(parent);
          if (!pc || pc.kind !== kind || pc.target !== target) return json({ code: 400, body: { error: "回复的评论不存在" } });
          if (await db.isBlocked(pc.uid, me.id)) return json({ code: 403, body: { error: "无法回复该用户" } });   // 对方拉黑了我
          if (pc.parent) parent = pc.parent;               // 回复的回复 → 扁平挂到主评论下(小红书式一层)
        }
        if (kind === "work") {   // 作品作者拉黑了我 → 不能在其作品下评论
          const wk = await db.getWork(Number(target));
          if (wk && await db.isBlocked(wk.uid, me.id)) return json({ code: 403, body: { error: "无法评论该作品" } });
        }
        const mod = await moderateText(content, "comment");
        const status = mod.verdict === "pass" ? "approved" : "pending";   // AI 干净即显示,可疑压下待人工
        const id = await db.insertComment({ kind, target, uid: me.id, email: me.email, parent, content, mod, status, ip_region: ipRegion(ip) });
        await db.logModeration("comment", id, (status === "approved" ? "auto-approved:" : "created:") + mod.verdict, { kind, target, uid: me.id });
        auth.logEvent("comment", { uid: me.id, email: me.email, ip, id: String(id) });
        if (status === "approved") await notifyForComment({ id, kind, target, uid: me.id, parent, content }).catch(() => {});
        return json({ code: 200, body: { ok: true, id, status } });
      } catch (e) { return json({ code: 503, body: { error: "评论服务暂不可用" } }); }
    }
    if (p === "/api/comments/like" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "请先登录" } });
      const b = await readBody(req);
      try {
        const c = await db.getComment(Number(b.id));
        if (!c || c.status !== "approved") return json({ code: 404, body: { error: "评论不存在" } });
        if (await db.isBlocked(c.uid, me.id)) return json({ code: 403, body: { error: "无法操作" } });   // 对方拉黑了我
        const lr = await db.commentLikeToggle(me.id, c.id);
        if (lr.liked) await db.notify({ uid: c.uid, type: "like", actor: me.id, refkey: "like:" + c.id, ref: { kind: c.kind, target: c.target, cid: c.id, preview: String(c.content).slice(0, 60) } }).catch(() => {});
        return json({ code: 200, body: lr });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/comments/delete" && m === "POST") {
      const me = auth.userOf(req);
      const b = await readBody(req);
      try {
        const c = await db.getComment(Number(b.id));
        if (!c) return json({ code: 404, body: { error: "评论不存在" } });
        const isAdminReq = auth.isAdmin(req, ip);
        if (!isAdminReq && (!me || c.uid !== me.id)) return json({ code: 403, body: { error: "只能删除自己的评论" } });
        await db.deleteComment(c.id);
        await db.logModeration("comment", c.id, isAdminReq ? "deleted-by-admin" : "deleted-by-owner", null);
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/comments/report" && m === "POST") {
      if (reportLimited(ip)) return json({ code: 429, body: { error: "举报太频繁" } });
      const b = await readBody(req);
      try {
        const c = await db.getComment(Number(b.id));
        if (!c) return json({ code: 404, body: { error: "评论不存在" } });
        await db.commentReport(c.id);
        const viewer = auth.userOf(req);
        await db.logModeration("comment", c.id, "reported", { by: viewer ? viewer.id : "anon", ip });
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // —— 评论审核(admin):列表 / 裁决(pending→通过|拒绝;approved→下架) ——
    if (p === "/api/admin/comments" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try { return json({ code: 200, body: { list: await db.commentsAdminList() } }); }
      catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    if (p === "/api/admin/comments/decide" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const action = b.action === "approve" ? "approved" : "rejected";
      try {
        const c = await db.getComment(Number(b.id));
        if (!c) return json({ code: 404, body: { error: "not found" } });
        if (!(c.status === "pending" || (c.status === "approved" && action === "rejected"))) {
          return json({ code: 400, body: { error: "该评论已裁决过" } });
        }
        await db.decideComment(c.id, action, b.note);
        await db.logModeration("comment", c.id, "decided:" + action, null);
        if (action === "approved") await notifyForComment(c).catch(() => {});   // 人工放行的评论此刻才可见 → 通知被回复者/作品作者
        await db.notify({ uid: c.uid, type: "decide", ref: { what: "comment", preview: String(c.content).slice(0, 60), result: action } }).catch(() => {});
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    // —— 作品集(8.3):上传(登录,进人工审核) / 查看 / 删除 / 举报 ——
    if (p === "/api/works" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "请先登录再上传作品" } });
      if (auth.needsPhone(me)) return json({ code: 403, body: { error: "请先绑定手机号完成实名后再发布" } });
      const b = await readBody(req, 9 * 1024 * 1024);   // ≤9 张压缩图
      const v = validateWork(b);
      if (v.error) return json({ code: 400, body: { error: v.error } });
      try {
        if (!(await db.workRateOk(me.id))) return json({ code: 429, body: { error: "今天上传已达上限(10 组),明天再来" } });
        // 审核策略(2026-07-17 起):文字机审 pass → 自动通过、图片直接进公开目录即时发布;
        // review/reject → 图片留在非公开待审目录,交人工。后台全量可见,已发布的可"下架"。
        // (注:DeepSeek 只能审文字;图片内容靠 后台可见+举报+下架 兜底)
        const mod = await moderateText(v.data.title + "\n" + v.data.description, "work");
        const autoPass = mod.verdict === "pass";
        const id = await db.insertWork({ uid: me.id, email: me.email, title: v.data.title, description: v.data.description, tags: v.data.tags, mod, ip_region: ipRegion(ip) });
        const dir = autoPass ? WORKS_PUB : WORKS_PENDING;
        await mkdir(dir, { recursive: true });
        const names = [];
        for (let i = 0; i < v.data.bufs.length; i++) {
          const name = "w" + id + "-" + i + ".jpg";
          await writeFile(join(dir, name), v.data.bufs[i]);
          names.push(name);
        }
        await db.setWorkImages(id, names);
        if (autoPass) await db.decideWork(id, "approved", "AI 机审通过,自动发布");
        await db.logModeration("work", id, (autoPass ? "auto-approved:" : "created:") + mod.verdict, { uid: me.id, n: names.length });
        auth.logEvent("work", { uid: me.id, email: me.email, ip, id: String(id) });
        return json({ code: 200, body: { ok: true, id, status: autoPass ? "approved" : "pending" } });
      } catch (e) {
        process.stderr.write("[works] " + (e.message || e) + "\n");
        return json({ code: 503, body: { error: "作品服务暂不可用,请稍后再试" } });
      }
    }
    // 作品广场(第四频道"作品"):全站已过审作品的最新流,附作者公开摘要;?following=1 只看关注的人
    if (p === "/api/works/feed" && m === "GET") {
      try {
        let rows;
        if (u.searchParams.get("following") === "1") {
          const viewer = auth.userOf(req);
          if (!viewer) return json({ code: 401, body: { error: "登录后可看关注的人的作品" } });
          rows = await db.worksFeedFollowing(viewer.id);
        } else rows = await db.worksFeed(200);
        const mini = auth.usersMini([...new Set(rows.map(w => w.uid))]);
        const byId = new Map(mini.map(x => [x.id, x]));
        const viewer0 = auth.userOf(req);
        const wl = await db.workLikesFor(rows.map(w => w.id), viewer0 ? viewer0.id : null);
        return json({ code: 200, body: { works: rows.map(w => ({
          id: w.id, uid: w.uid, title: w.title, description: w.description || "",
          created_at: w.created_at, n: w.images.length, tags: w.tags || [],
          images: w.images.map(n => "assets/works/" + n),
          ip_region: w.ip_region || null,
          likes: wl.counts[w.id] || 0, liked: wl.liked.has(w.id),
          author: byId.get(w.uid) || null
        })) } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/works" && m === "GET") {
      const uid = String(u.searchParams.get("uid") || "");
      const viewer = auth.userOf(req);
      const own = !!(viewer && viewer.id === uid);
      try {
        const rows = await db.worksByUser(uid, own);
        const wl = await db.workLikesFor(rows.map(w => w.id), viewer ? viewer.id : null);
        return json({ code: 200, body: { works: rows.map(w => ({
          id: w.id, title: w.title, description: w.description || "",
          created_at: w.created_at, n: w.images.length, tags: w.tags || [],
          status: own ? w.status : "approved", ip_region: w.ip_region || null,
          likes: wl.counts[w.id] || 0, liked: wl.liked.has(w.id),
          images: w.status === "approved" ? w.images.map(n => "assets/works/" + n) : []
        })) } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // 画室工具授权开关(v0.92.0):仅管理员;按 uid 勾选/取消,持久到用户记录
    if (p === "/api/admin/user/studio" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      if (!b.uid) return json({ code: 400, body: { error: "参数不正确" } });
      return json(auth.adminSetStudio(String(b.uid), b.on === true));
    }
    // 访客属地(v0.91.0):供地球"你在这里"立体光标定位;粗到省/国,与全站 IP 属地同口径,不含具体 IP
    if (p === "/api/geo" && m === "GET") {
      return json({ code: 200, body: { ip_region: ipRegion(ip) } });
    }
    // —— 反馈/求助(v0.83.0):免登录可提(登录不上的用户也要能求助);IP 限频;进 admin「反馈信箱」 ——
    if (p === "/api/feedback" && m === "POST") {
      if (fbLimited(ip)) return json({ code: 429, body: { error: "今天反馈太多了,明天再来" } });
      const b = await readBody(req);
      const type = FB_TYPES.has(String(b.type)) ? String(b.type) : "suggest";
      const content = String(b.content || "").trim().slice(0, 1000);
      const contact = String(b.contact || "").trim().slice(0, 120);
      const page = String(b.page || "").slice(0, 120);
      if (content.length < 5) return json({ code: 400, body: { error: "请把内容写清楚一点(至少 5 个字)" } });
      const meF = auth.userOf(req);
      try {
        const id = await db.insertFeedback({ uid: meF ? meF.id : null, contact, type, content, page, ip_region: ipRegion(ip) });
        auth.logEvent("feedback", { ...(meF ? { uid: meF.id, email: meF.email } : {}), ip, id: String(id), fb_type: type });   // 别用 type 键:会覆盖事件类型
        return json({ code: 200, body: { ok: true, id } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/admin/feedback" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try {
        const list = await db.feedbackList(300);
        const reported = await db.reportedContent();
        const mini = auth.usersMini([...new Set([
          ...reported.comments.map(c => c.uid), ...reported.works.map(w => w.uid),
          ...list.map(f => f.uid).filter(Boolean)])]);
        const byId = new Map(mini.map(x => [x.id, x]));
        let report = null;
        try { report = JSON.parse(await readFile(join(__dir, "state", "feedback-report.json"), "utf8")); } catch (e) {}
        return json({ code: 200, body: {
          list: list.map(f => ({ ...f, user: f.uid ? (byId.get(f.uid) || null) : null })),
          reported: {
            comments: reported.comments.map(c => ({ id: c.id, kind: c.kind, target: c.target, content: c.content,
              reports: c.reports, author: byId.get(c.uid) || null, created_at: c.created_at })),
            works: reported.works.map(w => ({ id: w.id, title: w.title, reports: w.reports,
              author: byId.get(w.uid) || null, cover: w.images[0] ? ("assets/works/" + w.images[0]) : "" }))
          },
          report } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/admin/feedback/decide" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const status = ["new", "resolved", "dismissed"].includes(String(b.status)) ? String(b.status) : null;
      if (!status || !Number(b.id)) return json({ code: 400, body: { error: "参数不正确" } });
      try {
        await db.decideFeedback(Number(b.id), status, String(b.note || "").slice(0, 200));
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // —— 自托管数据面板(v0.85.0):解析 events.jsonl(+轮转档)聚合近 14 天;无任何第三方统计 ——
    if (p === "/api/admin/stats" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try {
        const bjDayOf = t => new Date(Date.parse(t) + 8 * 3600e3).toISOString().slice(0, 10);
        const since = Date.now() - 14 * 86400e3, since7 = Date.now() - 7 * 86400e3;
        let lines = [];
        for (const f of [join(__dir, "state", "events.jsonl.1"), join(__dir, "state", "events.jsonl")]) {
          try { lines.push(...(await readFile(f, "utf8")).trim().split("\n")); } catch (e) {}
        }
        const days = new Map();          // day -> { visitors:Set, ...计数 }
        const itemHits = new Map();      // id -> {views, outs}
        const qHits = new Map();         // 检索词 -> n
        const EVT = ["visit", "view", "outbound", "fav", "wkread", "search", "comment", "work", "submit", "register", "login", "follow", "feedback"];
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch (x) { continue; }
          const ts = Date.parse(e.t); if (!ts || ts < since) continue;
          const day = bjDayOf(e.t);
          let d = days.get(day);
          if (!d) { d = { visitors: new Set() }; EVT.forEach(k => d[k] = 0); days.set(day, d); }
          if (d[e.type] != null) d[e.type]++;
          // 去重口径(v0.99.2):登录用 uid,匿名用 ip——不用 anon(小程序/微信内置浏览器等场景
          // localStorage 常被清,同一人反复打开会换新 anon,导致同人同天被记成多个访客)。
          d.visitors.add(e.uid || e.ip || "?");
          if (ts >= since7) {
            if ((e.type === "view" || e.type === "outbound") && e.id) {
              const h = itemHits.get(e.id) || { views: 0, outs: 0 };
              if (e.type === "view") h.views++; else h.outs++;
              itemHits.set(e.id, h);
            }
            if (e.type === "search" && e.q) qHits.set(e.q, (qHits.get(e.q) || 0) + 1);
          }
        }
        // 近 14 天补全空日,老→新排序
        const out = [];
        for (let i = 13; i >= 0; i--) {
          const day = bjDayOf(new Date(Date.now() - i * 86400e3).toISOString());
          const d = days.get(day) || { visitors: new Set() };
          const row = { day, visitors: d.visitors.size };
          EVT.forEach(k => row[k] = d[k] || 0);
          out.push(row);
        }
        // 热门条目标题解析(只解析 top 12,三频道映射逐个试)
        const top = [...itemHits.entries()].sort((a, b) => (b[1].views + b[1].outs) - (a[1].views + a[1].outs)).slice(0, 12);
        const topItems = [];
        for (const [id, h] of top) {
          let title = null, ch = null;
          if (/^work-/.test(id)) { title = "作品 #" + id.slice(5); ch = "works"; }
          else for (const c of ["opportunities", "news", "jobs"]) {
            const mp = await favChannelMap(c);
            const it = mp.get(String(id));
            if (it) { title = it.title_zh || it.title || id; ch = c; break; }
          }
          topItems.push({ id, title: title || id, ch, views: h.views, outs: h.outs });
        }
        const topSearches = [...qHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([q, n]) => ({ q, n }));
        const favTotal = auth.favTotal ? auth.favTotal() : null;
        const topZero = await db.topZeroQueries(30, 15); // P5 补源看板:近30天反复零结果的检索词
        let composition = null;
        try { composition = auth.adminUserComposition ? auth.adminUserComposition() : null; } catch (e) {}
        return json({ code: 200, body: { days: out, topItems, topSearches, topZero, fav_total: favTotal, composition } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // 访客明细(v0.99.2):某天具体是谁——登录用户给邮箱/昵称/头像 + 访问的机会明细,匿名按 IP 属地归堆(不出具体 IP)。
    if (p === "/api/admin/stats/day" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const day = String(u.searchParams.get("day") || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ code: 400, body: { error: "参数不正确" } });
      try {
        const bjDayOf = t => new Date(Date.parse(t) + 8 * 3600e3).toISOString().slice(0, 10);
        let lines = [];
        for (const f of [join(__dir, "state", "events.jsonl.1"), join(__dir, "state", "events.jsonl")]) {
          try { lines.push(...(await readFile(f, "utf8")).trim().split("\n")); } catch (e) {}
        }
        const uidHits = new Map(), ipHits = new Map();
        const uidItems = new Map();          // uid -> Map(itemId -> {id, views, outs})
        const itemIds = new Set();           // 需要解析标题的 item id
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch (x) { continue; }
          if (!e.t || bjDayOf(e.t) !== day) continue;
          if (e.uid) {
            uidHits.set(e.uid, (uidHits.get(e.uid) || 0) + 1);
            if ((e.type === "view" || e.type === "outbound") && e.id) {
              let m = uidItems.get(e.uid); if (!m) uidItems.set(e.uid, m = new Map());
              const k = String(e.id);
              let it = m.get(k); if (!it) { it = { id: k, views: 0, outs: 0 }; m.set(k, it); itemIds.add(k); }
              if (e.type === "view") it.views++; else it.outs++;
            }
          } else if (e.ip) ipHits.set(e.ip, (ipHits.get(e.ip) || 0) + 1);
        }
        // 解析访问过的机会/新闻/岗位/作品标题(三频道逐个试,与"热门条目"同一套解析;解析不到的显示 id,不凑数)
        const titleBy = new Map();
        const workIds = [...itemIds].filter(x => /^work-/.test(x)).map(x => x.slice(5));
        if (workIds.length) { try { const rows = await db.worksByIds(workIds); for (const w of rows) if (w.title) titleBy.set("work-" + w.id, w.title); } catch (e) {} }
        for (const id of itemIds) {
          if (titleBy.has(id)) continue;
          for (const c of ["opportunities", "news", "jobs"]) {
            const mp = await favChannelMap(c);
            const it = mp.get(id);
            if (it) { titleBy.set(id, it.title_zh || it.title || id); break; }
          }
        }
        for (const [, m] of uidItems) for (const [, it] of m) it.title = titleBy.get(it.id) || it.id;
        const mini = auth.usersForAdminLookup([...uidHits.keys()]);
        const byId = new Map(mini.map(x => [x.id, x]));
        const users = [...uidHits.entries()]
          .map(([id, events]) => {
            const gu = byId.get(id) || {};
            const items = uidItems.get(id) ? [...uidItems.get(id).values()]
              .sort((a, b) => (b.views + b.outs) - (a.views + a.outs)).slice(0, 30)
              .map(x => ({ id: x.id, title: x.title, views: x.views, outs: x.outs })) : [];
            return { id, email: gu.email || null, nickname: gu.nickname || null, avatar: gu.avatar || null, region: gu.region || null, events, items };
          })
          .sort((a, b) => b.events - a.events);
        const regionAgg = new Map();
        for (const [ipAddr, events] of ipHits) {
          const region = ipRegion(ipAddr) || "未知地区";
          const r = regionAgg.get(region) || { region, visitors: 0, events: 0 };
          r.visitors++; r.events += events;
          regionAgg.set(region, r);
        }
        const anon = [...regionAgg.values()].sort((a, b) => b.visitors - a.visitors);
        return json({ code: 200, body: { day, users, anon } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // 被举报内容裁决「保留」:内容没问题,举报计数清零(下架走既有 comments/works decide)
    if (p === "/api/admin/reported/clear" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const kind = b.kind === "work" ? "work" : "comment";
      if (!Number(b.id)) return json({ code: 400, body: { error: "参数不正确" } });
      try {
        await db.clearReports(kind, Number(b.id));
        await db.logModeration(kind, Number(b.id), "reports-cleared", null);
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // 作品点赞(v0.82.1):一人一赞可取消;赞了通知作者(去重键防反复赞刷通知)
    if (p === "/api/works/like" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "请先登录" } });
      const b = await readBody(req);
      try {
        const w = await db.getWork(Number(b.id));
        if (!w || w.status !== "approved") return json({ code: 404, body: { error: "作品不存在" } });
        if (await db.isBlocked(w.uid, me.id)) return json({ code: 403, body: { error: "无法操作" } });
        const lr = await db.workLikeToggle(me.id, w.id);
        if (lr.liked && w.uid !== me.id)
          await db.notify({ uid: w.uid, type: "like", actor: me.id, refkey: "wlike:" + w.id,
            ref: { kind: "work", target: String(w.id), title: w.title } }).catch(() => {});
        return json({ code: 200, body: lr });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/works/delete" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "未登录" } });
      const b = await readBody(req);
      try {
        const w = await db.getWork(Number(b.id));
        if (!w) return json({ code: 404, body: { error: "作品不存在" } });
        if (w.uid !== me.id) return json({ code: 403, body: { error: "只能删除自己的作品" } });
        await db.deleteWork(w.id);
        for (const n of w.images) {
          if (!workFileRe.test(n)) continue;
          await unlink(join(w.status === "approved" ? WORKS_PUB : WORKS_PENDING, n)).catch(() => {});
        }
        await db.logModeration("work", w.id, "deleted-by-owner", { uid: me.id });
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/works/report" && m === "POST") {
      if (reportLimited(ip)) return json({ code: 429, body: { error: "举报太频繁" } });
      const b = await readBody(req);
      try {
        const w = await db.getWork(Number(b.id));
        if (!w) return json({ code: 404, body: { error: "作品不存在" } });
        await db.workReport(w.id);
        const viewer = auth.userOf(req);
        await db.logModeration("work", w.id, "reported", { by: viewer ? viewer.id : "anon", ip, reason: String(b.reason || "").slice(0, 200) });
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // —— 作品审核(admin):列表 / 待审图预览(图在非公开目录,只有管理员能看) / 裁决 ——
    if (p === "/api/admin/works" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try {
        // 带上恢复期剩余天数,前端据此显示「恢复」按钮(v0.100.0)
        const list = (await db.worksAdminList()).map(w => ({
          ...w,
          restore_days_left: w.status === "rejected" ? workRestoreDaysLeft(w) : null,
          restore_days_total: WORK_RESTORE_DAYS
        }));
        return json({ code: 200, body: { list } });
      }
      catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    if (p === "/api/admin/works/img" && m === "GET") {
      if (!auth.isAdmin(req, ip)) { res.writeHead(401); return res.end(); }
      try {
        const w = await db.getWork(Number(u.searchParams.get("id")));
        const name = w && w.images[Number(u.searchParams.get("i") || 0)];
        if (!w || !name || !workFileRe.test(name)) { res.writeHead(404); return res.end(); }
        const body = await readFile(join(w.status === "approved" ? WORKS_PUB : WORKS_PENDING, name));
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
        return res.end(body);
      } catch (e) { res.writeHead(404); return res.end(); }
    }
    if (p === "/api/admin/works/decide" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const action = b.action === "approve" ? "approved" : "rejected";
      try {
        const w = await db.getWork(Number(b.id));
        if (!w) return json({ code: 404, body: { error: "not found" } });
        // 下架:已发布(含 AI 自动通过)的作品,人工复核发现问题 → 图片撤回非公开目录留证,状态改拒绝
        if (w.status === "approved" && action === "rejected") {
          await mkdir(WORKS_PENDING, { recursive: true });
          for (const n of w.images) {
            if (!workFileRe.test(n)) continue;
            await rename(join(WORKS_PUB, n), join(WORKS_PENDING, n)).catch(() => {});
          }
          await db.decideWork(w.id, "rejected", b.note || "人工复核下架");
          await db.logModeration("work", w.id, "takedown", null);
          return json({ code: 200, body: { ok: true } });
        }
        // 恢复(v0.100.0):下架/拒绝后 WORK_RESTORE_DAYS(默认 30)天内可反悔——图片一直留在非公开
        // 目录没删,把它移回公开目录、状态改回已通过即可。超期的图片已被清理任务删掉,恢复不了才拒绝。
        if (w.status === "rejected" && action === "approved") {
          const left = workRestoreDaysLeft(w);
          if (left <= 0) return json({ code: 400, body: { error: `已超过 ${WORK_RESTORE_DAYS} 天恢复期,图片已清理,无法恢复` } });
          await mkdir(WORKS_PUB, { recursive: true });
          const missing = [];
          for (const n of w.images) {
            if (!workFileRe.test(n)) continue;
            try { await rename(join(WORKS_PENDING, n), join(WORKS_PUB, n)); }
            catch (e) { missing.push(n); }
          }
          if (missing.length === w.images.length && w.images.length) {
            return json({ code: 400, body: { error: "图片文件已不在,无法恢复" } });
          }
          await db.decideWork(w.id, "approved", "管理员恢复上架");
          await db.logModeration("work", w.id, "restored", null);
          await db.notify({ uid: w.uid, type: "decide", ref: { what: "work", title: w.title, result: "approved" } }).catch(() => {});
          return json({ code: 200, body: { ok: true, restored: true } });
        }
        if (w.status !== "pending") return json({ code: 400, body: { error: "该作品已裁决过" } });
        if (action === "approved") {
          await mkdir(WORKS_PUB, { recursive: true });
          for (const n of w.images) {
            if (!workFileRe.test(n)) continue;
            await rename(join(WORKS_PENDING, n), join(WORKS_PUB, n));   // 过审才进公开目录
          }
        }
        // 注:拒绝不再立刻删图(v0.100.0)——图片留在非公开目录,给 WORK_RESTORE_DAYS 天反悔窗口,
        // 到期由清理任务统一删。误判拒绝的作品以前一删就永久没了,现在能救回来。
        await db.decideWork(w.id, action, b.note);
        await db.logModeration("work", w.id, "decided:" + action, null);
        await db.notify({ uid: w.uid, type: "decide", ref: { what: "work", title: w.title, result: action } }).catch(() => {});
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    // —— 用户搜索(8.2;注意要先于下面的 /api/users/<uid> 通配) ——
    if (p === "/api/users/search" && m === "GET") {
      return json(auth.searchUsers(u.searchParams.get("q") || "", ip));
    }
    // —— 粉丝/关注列表(8.2):GET /api/users/<uid>/follows?kind=followers|following ——
    if (p.startsWith("/api/users/") && p.endsWith("/follows") && m === "GET") {
      let uid; try { uid = decodeURIComponent(p.slice("/api/users/".length, -"/follows".length)); } catch (e) { uid = ""; }
      const kind = u.searchParams.get("kind") === "followers" ? "followers" : "following";
      try {
        const rows = await db.followList(uid, kind);
        return json({ code: 200, body: { kind, users: auth.usersMini(rows.map(r => r.uid)) } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // —— 拉黑/解除(8.4 二期):拉黑后对方无法关注/评论你,双向关注解除 ——
    if (p === "/api/block" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "请先登录" } });
      const b = await readBody(req);
      const target = String(b.uid || ""), on = !!b.on;
      if (target === me.id) return json({ code: 400, body: { error: "不能拉黑自己" } });
      if (!auth.userExists(target)) return json({ code: 404, body: { error: "用户不存在" } });
      try {
        await db.blockSet(me.id, target, on);
        await db.logModeration("block", target, on ? "blocked" : "unblocked", { by: me.id });
        return json({ code: 200, body: { ok: true, blocked: on } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // —— 关注/取关(8.2):登录用户;不能关注自己;新增关注限 100 次/天;拉黑关系下禁止 ——
    if (p === "/api/follow" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "请先登录" } });
      const b = await readBody(req);
      const target = String(b.uid || ""), on = !!b.on;
      if (target === me.id) return json({ code: 400, body: { error: "不能关注自己" } });
      if (!auth.userExists(target)) return json({ code: 404, body: { error: "用户不存在" } });
      try {
        if (on && await db.isBlocked(target, me.id)) return json({ code: 403, body: { error: "无法关注该用户" } });
        if (on && await db.isBlocked(me.id, target)) return json({ code: 403, body: { error: "你已拉黑对方,先解除拉黑" } });
        if (on && !(await db.followRateOk(me.id))) return json({ code: 429, body: { error: "今日关注操作太多,明天再来" } });
        await db.followSet(me.id, target, on);
        const info = await db.followInfo(target, me.id);
        if (on) await db.notify({ uid: target, type: "follow", actor: me.id, refkey: "follow" }).catch(() => {});
        auth.logEvent("follow", { uid: me.id, target, on: on ? 1 : 0, ip });
        return json({ code: 200, body: { ok: true, followers: info.followers, is_following: info.is_following } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    // —— 用户公开主页(路线图 8.1):只出公开字段,绝不暴露邮箱;附已通过投稿 + 关注数据(8.2) ——
    if (p.startsWith("/api/users/") && m === "GET") {
      let uid; try { uid = decodeURIComponent(p.slice("/api/users/".length)); } catch (e) { uid = p.slice("/api/users/".length); }
      const r = auth.publicProfile(uid, ip);
      if (r.code !== 200) return json(r);
      try { r.body.submissions = await db.userApprovedSubmissions(uid); } catch (e) { r.body.submissions = []; }
      const viewer = auth.userOf(req);
      try { Object.assign(r.body.user, await db.followInfo(uid, viewer ? viewer.id : null)); }
      catch (e) { Object.assign(r.body.user, { followers: 0, following: 0, is_following: false }); }
      try { r.body.user.works = await db.worksCountApproved(uid); } catch (e) { r.body.user.works = 0; }
      try { r.body.user.is_blocked = viewer ? await db.isBlocked(viewer.id, uid) : false; } catch (e) { r.body.user.is_blocked = false; }
      return json(r);
    }
    if (p === "/api/track" && m === "POST") { const b = await readBody(req); return json(auth.track(req, b, ip)); }
    if (p === "/api/admin/login" && m === "POST") { const b = await readBody(req); return json(auth.adminLogin(b.password, ip)); }
    if (p === "/api/admin/overview" && m === "GET") return json(auth.isAdmin(req, ip) ? await auth.adminOverview() : { code: 401, body: { error: "unauthorized" } });
    if (p === "/api/admin/users" && m === "GET") return json(auth.isAdmin(req, ip) ? auth.adminUsers() : { code: 401, body: { error: "unauthorized" } });
    // 后台查用户专属总结:无 uid=列表;带 uid=返回该用户完整总结文章
    if (p === "/api/admin/summaries" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const uid = u.searchParams.get("uid");
      if (uid) return json({ code: 200, body: { summary: await readSummary(uid) } });
      return json({ code: 200, body: { summaries: await listSummaries() } });
    }
    if (p === "/api/admin/users/ban" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const key = b.uid || b.email;   // 优先 uid(手机注册用户 email 可为 null)
      const r = auth.adminSetBan(key, !!b.on);
      if (r.code === 200) await db.logModeration("user", String(key), b.on ? "banned" : "unbanned", null).catch(() => {});
      return json(r);
    }
    // —— 用户档案 v0.53(v0.101.0 后台增强):点名字/头像看完整档案 + 收藏 + 作品/评论 + 行为时间线 ——
    if (p === "/api/admin/user" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const uid = String(u.searchParams.get("id") || "").slice(0, 40);
      if (!uid) return json({ code: 400, body: { error: "缺少用户 id" } });
      try {
        const user = auth.adminUserDetail(uid);
        if (!user) return json({ code: 404, body: { error: "用户不存在" } });
        const works = await db.worksByUser(uid, true);
        const comments = await db.commentsByUser(uid);
        const follow = await db.followInfo(uid);
        const favs = await resolveFavorites(user.favorites);
        // 行为时间线:按 uid 过滤埋点日志(最新在最前)
        const timeline = [];
        try {
          let lines = [];
          for (const f of [join(__dir, "state", "events.jsonl.1"), join(__dir, "state", "events.jsonl")]) {
            try { lines.push(...(await readFile(f, "utf8")).trim().split("\n")); } catch (e) {}
          }
          for (let i = lines.length - 1; i >= 0 && timeline.length < 500; i--) {
            let e; try { e = JSON.parse(lines[i]); } catch (x) { continue; }
            if (e.uid !== uid) continue;
            timeline.push({ t: e.t, type: e.type, detail: e.id || e.q || e.title || e.nickname || null });
          }
        } catch (e) {}
        return json({ code: 200, body: { user, works, comments, follow, favorites: favs, timeline } });
      } catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    // —— 区域经理入库机会(后台增强):某经理在档期内实际入库了哪些机会 ——
    if (p === "/api/admin/regions/opps" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const id = String(u.searchParams.get("id") || "").slice(0, 40);
      try {
        const rows = id ? await db.ingestByEmail("region:" + id) : [];
        const seen = new Set(), ids = [];
        for (const r of rows) if (!seen.has(r.record_id)) { seen.add(r.record_id); ids.push({ id: r.record_id, q: r.q, at: r.at }); }
        const doc = JSON.parse(await readFile(DATA, "utf8"));
        const byId = new Map((doc.opportunities || []).map(o => [o.id, o]));
        const list = [];
        for (const it of ids) {
          const o = byId.get(it.id);
          if (!o) continue;
          list.push({ id: o.id, title: o.title_zh || o.title_en || o.title, org: o.org_zh || o.org || "", city: o.city_zh, deadline: o.deadline, status: o.status, apply_fee: o.apply_fee, funding: o.funding, url: o.url, q: it.q, at: it.at });
        }
        return json({ code: 200, body: { id, list } });
      } catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    // —— 投稿:提交 / 后台队列 / 人工裁决 ——
    if (p === "/api/submit" && m === "POST") {
      const user = auth.userOf(req);
      if (!user) return json({ code: 401, body: { error: "请先登录后再投稿" } });
      if (auth.needsPhone(user)) return json({ code: 403, body: { error: "请先绑定手机号完成实名后再发布" } });
      const b = await readBody(req, 900 * 1024);   // 放宽:压缩封面 base64
      const v = validateSubmission(b);
      if (v.error) return json({ code: 400, body: { error: v.error } });
      try {
        if (!(await db.submissionRateOk(user.id))) return json({ code: 429, body: { error: "今天投稿已达上限(5 条),明天再来" } });
        const modText = [v.data.title, v.data.org, v.data.source, v.data.city, v.data.country, v.data.salary, v.data.summary, v.data.url, v.data.source_note].filter(Boolean).join("\n");
        const mod = await moderateText(modText);
        v.data.ip_region = ipRegion(ip) || undefined;   // 用户投稿带发布时属地,发布记录透传展示
        const id = await db.insertSubmission({ uid: user.id, email: user.email, payload: v.data, mod, ip });
        await db.logModeration("submission", id, "created:" + mod.verdict, { hits: mod.hits, ai: mod.ai });
        auth.logEvent("submit", { uid: user.id, email: user.email, ip, id: String(id) });
        // 审核策略(2026-07-17 起):AI 机审干净(pass)→ 自动通过并发布;
        // 可疑/违规(review/reject)→ 不通过,留在待审队列交人工。后台全量可见、可撤。
        if (mod.verdict === "pass") {
          const row = await db.decideSubmission(id, "approved", "AI 机审通过,自动发布");
          const pub = await publishSubmission(row);
          await db.logModeration("submission", id, pub === "duplicate" ? "auto-approved-duplicate" : "auto-approved", null);
          return json({ code: 200, body: { ok: true, status: pub === "duplicate" ? "duplicate" : "approved" } });
        }
        return json({ code: 200, body: { ok: true, status: "pending" } });
      } catch (e) {
        process.stderr.write("[submit] " + (e.message || e) + "\n");
        return json({ code: 503, body: { error: "投稿服务暂不可用,请稍后再试" } });
      }
    }
    // —— Agent 巡视台(v0.72.0):各 agent 最近打卡 + 今日简报;?agent=xx 附该员最近记录 ——
    if (p === "/api/admin/agents" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try {
        const body = { last: await db.agentLastAll(), moderation: await db.moderationToday() };
        const who = u.searchParams.get("agent");
        if (who) body.recent = await db.agentRecent(String(who).slice(0, 40), 30);
        // 今日简报:搜索余量 / 磁盘 / 三频道今日更新 / 待人工事项
        const brief = { serper_left: serperBudgetLeft(), serper_usage: serperUsageToday(), brave_left: braveBudgetLeft(), brave_usage: braveUsageToday(), disk_free_gb: null, today: {}, pending: 0 };
        try { const fsx = await statfs(SITE); brief.disk_free_gb = Math.round(fsx.bsize * fsx.bavail / 1e9 * 10) / 10; } catch (e) {}
        try {
          const today = todayISO();
          for (const [name, file, key] of [["opp", "opportunities.json", "opportunities"], ["news", "news.json", "items"], ["jobs", "jobs.json", "jobs"]]) {
            const doc = JSON.parse(await readFile(join(SITE, "data", file), "utf8"));
            brief.today[name] = (doc[key] || []).filter(o => o.updated_at === today || o.added_at === today).length;
          }
        } catch (e) {}
        try { brief.pending = (await db.countPending()) + (await db.countPendingWorks()) + (await db.countPendingComments()); } catch (e) {}
        body.brief = brief;
        return json({ code: 200, body });
      } catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    // —— 区域经理编队(v0.98.0):工牌墙数据 = 档案 + 当值状态 + 成绩单 + 辖区信源数 ——
    if (p === "/api/admin/regions" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try {
        const cfg = await loadRegions();
        const now = new Date();
        const roster = rosterView(cfg.managers, now);
        const score = await reportView();
        // 辖区信源数:sources.json 里 region_hint 指向该经理的条数(未来信源扩量后按区分片抓取的依据)
        const byRegion = {};
        try {
          const sj = JSON.parse(await readFile(join(__dir, "sources.json"), "utf8"));
          for (const s of (Array.isArray(sj) ? sj : (sj.sources || []))) {
            const r = s && s.region_hint; if (r) byRegion[r] = (byRegion[r] || 0) + 1;
          }
        } catch (e) {}
        return json({ code: 200, body: {
          enabled: process.env.REGION_HARVEST === "1",
          per_shift: Math.max(1, Number(process.env.REGION_QUERIES_PER_SHIFT || 3)),
          serper_left: serperBudgetLeft(),
          brave_left: braveBudgetLeft(),
          utc_hour: now.getUTCHours(),
          day_index: dayIndex(now),
          desk: cfg.desk,
          managers: roster.map(r => ({ ...r, score: score[r.id] || null, sources: byRegion[r.id] || 0 }))
        } });
      } catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    // 「立即上班」:手动排一班(开幕/演示前想当场补内容用)。异步跑,不阻塞后台页面。
    if (p === "/api/admin/regions/run" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      if (!regionRunNow) return json({ code: 503, body: { error: "调度未就绪" } });
      const b = await readBody(req).catch(() => ({}));
      const who = b && b.id ? String(b.id).slice(0, 40) : null;
      regionRunNow(who).catch(e => process.stderr.write("[区域经理] 手动排班失败:" + String(e.message || e).slice(0, 120) + "\n"));
      return json({ code: 200, body: { ok: true, started: who || "auto" } });
    }
    // —— 数据质检「校勘」(v0.74.0):报告 / 立即巡检 / 一键归档建议条目 ——
    if (p === "/api/admin/qc" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      return json({ code: 200, body: {
        enabled: process.env.QUALITY_CHECK === "1",
        auto_archive: process.env.QC_ARCHIVE === "1",
        hour: Number(process.env.QUALITY_HOUR || 4),
        running: qcState.running, started_at: qcState.startedAt,
        report: await readQcReport()
      } });
    }
    if (p === "/api/admin/qc/run" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      if (qcState.running) return json({ code: 200, body: { ok: true, started: false, running: true } });
      const b = await readBody(req);
      runQualityCheck({ archive: !!b.archive, trigger: "manual" }).catch(() => {});   // 后台跑(约 1-2 分钟),前端轮询 GET
      return json({ code: 200, body: { ok: true, started: true } });
    }
    if (p === "/api/admin/qc/archive" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      if (qcState.running) return json({ code: 409, body: { error: "质检进行中,请稍候" } });
      const r = await runQualityCheck({ archive: true, probe: false, trigger: "manual-archive" });   // 免网络:按日期/查重规则归档建议条目
      if (!r.ok) return json({ code: 500, body: { error: r.error || "归档失败" } });
      return json({ code: 200, body: { ok: true, archived: r.report.totals.archived } });
    }
    // —— AI 周报(第 5 项):状态 / 生成 / 试发 / 群发(群发有备案闸,见 NEWSLETTER_BULK) ——
    if (p === "/api/admin/weekly/status" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const wid = weekIdOf();
      const cur = await readWeekly(wid);
      const idx = await readWeeklyIndex();
      let recent = []; try { recent = await db.nlRecent(60); } catch (e) {}
      return json({ code: 200, body: {
        week: wid,
        generated: !!cur,
        report: cur ? { id: cur.id, title: cur.title, date: cur.date, ai_composed: cur.ai_composed, counts: cur.sections.map(s => ({ key: s.key, n: s.items.length })) } : null,
        history: (idx.list || []).slice(0, 12),
        subscribers: auth.newsletterCount(),
        mailer_on: mailerOn(),
        bulk_enabled: process.env.NEWSLETTER_BULK === "1",
        sending: nlState.running ? nlState : null,
        sent_stats: cur ? await db.nlStats(wid).catch(() => null) : null,
        recent_sends: recent
      } });
    }
    if (p === "/api/admin/weekly/generate" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      try {
        const r = await generateWeekly({ force: !!b.force });
        if (r.empty) return json({ code: 200, body: { ok: false, empty: true, error: "近一周没有可入刊的内容" } });
        if (!r.existed) { db.agentLog({ agent: "eli", ok: true, summary: `出刊 ${r.report.id}「${r.report.title}」(admin 手动触发)`, metrics: { id: r.report.id, format: r.report.format || 1, en: !!r.report.en } }).catch(() => {}); notifyWeeklyPublished(r.report); }
        return json({ code: 200, body: { ok: true, existed: !!r.existed, report: { id: r.report.id, title: r.report.title, ai_composed: r.report.ai_composed, counts: r.report.counts || [] } } });
      } catch (e) { return json({ code: 500, body: { error: String(e.message || e).slice(0, 200) } }); }
    }
    if (p === "/api/admin/weekly/send" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      if (!mailerOn()) return json({ code: 400, body: { error: "发信未配置(服务器 .env 需 SMTP_HOST/USER/PASS)" } });
      const b = await readBody(req);
      const report = await readWeekly(String(b.wid || weekIdOf()));
      if (!report) return json({ code: 404, body: { error: "该期周报还没生成" } });
      if (b.test) {   // 试发一封到指定邮箱(不进订阅名单逻辑,不受群发闸限制)
        const to = String(b.test).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ code: 400, body: { error: "试发邮箱格式不正确" } });
        try {
          await sendWeeklyTo(report, to);
          await db.nlLogSend(report.id, to + " (试发)", true, null);
          return json({ code: 200, body: { ok: true, test: to } });
        } catch (e) {
          await db.nlLogSend(report.id, to + " (试发)", false, e.message);
          return json({ code: 500, body: { error: "发送失败:" + String(e.message || e).slice(0, 160) } });
        }
      }
      // 群发:备案前默认关闭(NEWSLETTER_BULK=1 才开),防误发;开启后也是断点续发、逐封限速
      if (process.env.NEWSLETTER_BULK !== "1") return json({ code: 403, body: { error: "群发未开启。备案通过后在服务器 .env 设 NEWSLETTER_BULK=1 再群发。" } });
      if (nlState.running) return json({ code: 409, body: { error: "本期群发正在进行中", state: nlState } });
      sendWeeklyBulk(report);   // 后台异步跑,进度看 status
      return json({ code: 200, body: { ok: true, started: true } });
    }
    if (p === "/api/admin/submissions" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try { return json({ code: 200, body: { list: await db.listSubmissions(200) } }); }
      catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    // —— 内容管理(v0.72.1 起三频道通用):列表/删除进回收站/回收站列表/恢复/彻底删除 ——
    if (p === "/api/admin/content" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const channel = CH_FILES[u.searchParams.get("channel")] ? u.searchParams.get("channel") : "opportunities";
      const [file, key] = CH_FILES[channel];
      const cur = JSON.parse(await readFile(file, "utf8"));
      const who = await db.ingestMap();
      const list = (cur[key] || []).map(o => ({
        id: o.id, title: o.title_zh || o.title || o.title_en, category: o.category || channel,
        org: o.org_zh || o.org || o.source || "",
        via: o._via || "daily", trust: o.trust,
        updated_at: o.updated_at || o.posted_at || o.published_at || o.added_at,
        searched_by: o._via === "search" ? (who[o.id] || null) : null
      }));
      return json({ code: 200, body: { list, channel } });
    }
    if (p === "/api/admin/content/delete" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const id = String(b.id || "");
      const channel = CH_FILES[b.channel] ? b.channel : "opportunities";
      const [file, key] = CH_FILES[channel];
      let removed = null;
      await withWriteLock(async () => {
        const cur = JSON.parse(await readFile(file, "utf8"));
        const i = (cur[key] || []).findIndex(o => o.id === id);
        if (i === -1) return;
        removed = cur[key].splice(i, 1)[0];
        if (cur.count != null) cur.count = cur[key].length;
        await writeFile(file, JSON.stringify(cur, null, 2), "utf8");
      });
      if (!removed) return json({ code: 404, body: { error: "not found" } });
      try { await db.recycleInsert(channel, removed); } catch (e) {}
      await tombAdd(channel, id);
      await db.logModeration("content", id, "deleted", { title: removed.title_zh || removed.title, channel });
      return json({ code: 200, body: { ok: true } });
    }
    if (p === "/api/admin/recycle" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try { return json({ code: 200, body: { list: await db.recycleList() } }); }
      catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    if (p === "/api/admin/recycle/restore" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const row = await db.recycleTake(Number(b.id));
      if (!row) return json({ code: 404, body: { error: "not found" } });
      const [rFile, rKey] = CH_FILES[row.channel] || CH_FILES.opportunities;   // 按频道恢复,别把招聘/资讯灌进机会库
      await withWriteLock(async () => {
        const cur = JSON.parse(await readFile(rFile, "utf8"));
        if (!(cur[rKey] || []).find(o => o.id === row.record_id)) {
          cur[rKey].push(row.payload);
          if (cur.count != null) cur.count = cur[rKey].length;
          await writeFile(rFile, JSON.stringify(cur, null, 2), "utf8");
        }
      });
      await tombRemove(row.channel, row.record_id);
      await db.logModeration("content", row.record_id, "restored", null);
      return json({ code: 200, body: { ok: true } });
    }
    if (p === "/api/admin/recycle/purge" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const row = await db.recycleTake(Number(b.id));   // 取出即删;墓碑保留,两侧不再复活
      if (!row) return json({ code: 404, body: { error: "not found" } });
      await db.logModeration("content", row.record_id, "purged", null);
      return json({ code: 200, body: { ok: true } });
    }
    if (p === "/api/admin/ingests" && m === "GET") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      try { return json({ code: 200, body: { list: await db.ingestList() } }); }
      catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
    if (p === "/api/admin/submissions/decide" && m === "POST") {
      if (!auth.isAdmin(req, ip)) return json({ code: 401, body: { error: "unauthorized" } });
      const b = await readBody(req);
      const action = b.action === "approve" ? "approved" : "rejected";
      try {
        const row = await db.decideSubmission(Number(b.id), action, b.note);
        if (!row) return json({ code: 404, body: { error: "not found" } });
        if (action === "approved") await publishSubmission(row);
        // 改判撤下:已发布(含 AI 自动发布)的投稿被人工改判拒绝 → 从对应频道移除并立墓碑(防夜间同步复活)
        if (action === "rejected" && row.status === "approved") {
          const kd = row.payload.kind;
          const channel = kd === "job" ? "jobs" : kd === "news" ? "news" : "opportunities";
          const prefix = (kd === "job" ? "submit-j" : kd === "news" ? "submit-n" : "submit-") + row.id;
          const [file, key] = CH_FILES[channel];
          const removedIds = [];
          await withWriteLock(async () => {
            const cur = JSON.parse(await readFile(file, "utf8"));
            const keep = [];
            for (const o of (cur[key] || [])) {
              if (String(o.id) === prefix || String(o.id).startsWith(prefix + "-")) removedIds.push(o.id);
              else keep.push(o);
            }
            if (removedIds.length) {
              cur[key] = keep;
              if (cur.count != null) cur.count = keep.length;
              await writeFile(file, JSON.stringify(cur, null, 2), "utf8");
            }
          });
          for (const rid of removedIds) await tombAdd(channel, rid);
          if (removedIds.length) await db.logModeration("submission", b.id, "takedown", { ids: removedIds, channel });
        }
        await db.logModeration("submission", b.id, "decided:" + action, null);
        await db.notify({ uid: row.uid, type: "decide", ref: { what: "submission", title: row.payload.title, result: action } }).catch(() => {});
        return json({ code: 200, body: { ok: true } });
      } catch (e) { return json({ code: 503, body: { error: String(e.message || e) } }); }
    }
  } catch (e) {
    return json({ code: 400, body: { error: "请求格式不正确" } });
  }
  return json({ code: 404, body: { error: "not found" } });
}

// —— AI 周报发送引擎(第 5 项)——
// 站点地址(邮件里的深链/退订链接用):备案绑域名后在 .env 设 SITE_URL=https://artportal123.com
const SITE_URL = (process.env.SITE_URL || "http://60.205.212.195").replace(/\/+$/, "");
function unsubUrlOf(email) {
  return SITE_URL + "/api/newsletter/unsub?e=" + Buffer.from(String(email).toLowerCase()).toString("base64url") + "&t=" + auth.unsubToken(email);
}
function sendWeeklyTo(report, email) {
  const ctx = { siteUrl: SITE_URL, unsubUrl: unsubUrlOf(email) };
  return sendMail({
    to: email,
    subject: report.title,
    html: renderEmailHtml(report, ctx),
    text: renderEmailText(report, ctx),
    headers: { "List-Unsubscribe": "<" + ctx.unsubUrl + ">" }   // 合规:一键退订头(Gmail/QQ 都认)
  });
}
// 群发状态(单例:同一时间只跑一场;断点续发靠 newsletter_sends 里的成功记录)
//
// —— 分批发送(2026-08 起):个人 QQ SMTP 连续发会被「535 login frequency」临时风控。
//   所以群发改成【分批 + 分时段 + 自动续发】的常驻引擎,完全自动、无需人工盯:
//     · 每批最多 NEWSLETTER_BATCH 封(默认 15),批内逐封限速 NEWSLETTER_SEND_DELAY_MS;
//     · 每发完一批歇 NEWSLETTER_BATCH_GAP_MS(默认 30 分),把发送摊到周一不同时段,降低被风控概率;
//     · 一旦某封命中风控(535)就把这封放回去(不算成功也不算失败),冷却
//       NEWSLETTER_COOLDOWN_MS(默认 30 分)后自动重试,直到 QQ 解除限制再继续后面剩下的;
//     · 中途服务重启也不怕:成功记录已落库,每周一的 hourly tick 会断点续发剩下没发的。
const nlState = { running: false, wid: null, done: 0, ok: 0, total: 0, pending: 0, phase: "idle", coolUntil: 0 };
const NL_BATCH = Math.max(1, Number(process.env.NEWSLETTER_BATCH || 15));
const NL_EMAIL_GAP = Math.max(2000, Number(process.env.NEWSLETTER_SEND_DELAY_MS || 6000));
const NL_BATCH_GAP = Math.max(0, Number(process.env.NEWSLETTER_BATCH_GAP_MS || 30 * 60 * 1000));
const NL_COOL_MS = Math.max(30 * 1000, Number(process.env.NEWSLETTER_COOLDOWN_MS || 30 * 60 * 1000));
function nlRateLimited(err) {
  const s = String(err && (err.message || err) || "");
  return /535|login|frequency|限流|风控|abnormal/i.test(s);
}
async function sendWeeklyBulk(report) {
  const audience = auth.newsletterAudience();
  const sent = await db.nlSentSet(report.id);
  const targets = audience.filter(a => !sent.has(a.email));
  if (!targets.length) { process.stderr.write(`[周报] ${report.id} 已全部发完,无需再发\n`); return; }
  nlState.running = true; nlState.wid = report.id; nlState.done = 0; nlState.ok = 0;
  nlState.total = targets.length; nlState.pending = targets.length; nlState.phase = "sending"; nlState.coolUntil = 0;
  process.stderr.write(`[周报] 分批群发开始 ${report.id}:待发 ${targets.length}(每批≤${NL_BATCH} 封, 批间隔 ${Math.round(NL_BATCH_GAP / 60000)} 分, 风控冷却 ${Math.round(NL_COOL_MS / 60000)} 分) 逐封 ${NL_EMAIL_GAP}ms\n`);
  let batchOk = 0;
  for (let i = 0; i < targets.length; i++) {
    // 批间暂停:本批已发满且还有剩下,先把发送摊到下一个时段,降低连续发送被风控的概率
    if (batchOk >= NL_BATCH) {
      batchOk = 0;
      nlState.phase = "wait-batch";
      await new Promise(r => setTimeout(r, NL_BATCH_GAP));
      nlState.phase = "sending";
    }
    const t = targets[i];
    try {
      await sendWeeklyTo(report, t.email);
      await db.nlLogSend(report.id, t.email, true, null);
      batchOk++; nlState.ok++;
    } catch (e) {
      if (nlRateLimited(e)) {
        // 风控命中:这封不记成功也不记失败,放进冷却,解除后再补发(批计数清空、放慢节奏)
        nlState.phase = "cooling";
        process.stderr.write(`[周报] 命中风控(${t.email}):${String(e.message || e).slice(0, 80)}… 冷却 ${Math.round(NL_COOL_MS / 60000)} 分后自动补发(累计已发 ${nlState.ok}/${targets.length})\n`);
        await new Promise(r => setTimeout(r, NL_COOL_MS));
        nlState.coolUntil = Date.now() + NL_COOL_MS;
        nlState.phase = "sending";
        batchOk = 0;
        i--;          // 回到这封,解除后再发
        continue;
      }
      await db.nlLogSend(report.id, t.email, false, e.message);
      process.stderr.write(`[周报] 发送失败 ${t.email}: ${String(e.message || e).slice(0, 100)}\n`);
    }
    nlState.done++;
    await new Promise(r => setTimeout(r, NL_EMAIL_GAP));
  }
  nlState.pending = targets.length - nlState.ok;
  process.stderr.write(`[周报] 分批群发结束 ${report.id}:成功 ${nlState.ok}/${targets.length},待发 ${nlState.pending}${nlState.pending ? "(下轮流派续发)" : "(全部完成)"}\n`);
  db.agentLog({ agent: "postman", ok: nlState.pending === 0, summary: `分批群发 ${report.id}:成功 ${nlState.ok}/${targets.length}${nlState.pending ? ",待续 " + nlState.pending : ""}`, metrics: { wid: report.id, ok: nlState.ok, total: targets.length, pending: nlState.pending } }).catch(() => {});
  nlState.running = false;
  nlState.phase = nlState.pending === 0 ? "done" : "idle";
}
// 每周自动出刊:.env 设 WEEKLY_REPORT=1 开启 —— 每小时看一眼,北京时间周一 9 点后本周还没出就生成;
// 生成后若 NEWSLETTER_AUTO=1 且群发闸(NEWSLETTER_BULK=1)已开、发信已配置,则自动群发(备案后的全自动形态)。
if (process.env.WEEKLY_REPORT === "1") {
  async function weeklyTick() {
    try {
      const bj = new Date(Date.now() + 8 * 3600e3);
      if (bj.getUTCDay() !== 1 || bj.getUTCHours() < 9) return;    // 北京时间周一 9 点后
      const weekId = weekIdOf();
      let report = await readWeekly(weekId);               // readWeekly 直接返回该期对象;未出刊返回 null
      if (!report) {
        // 本周未出刊 → 先生成
        const r = await generateWeekly({});
        if (!r.report) return;                             // 空刊保护:数据长期没更新就不出刊
        report = r.report;
        process.stderr.write(`[周报] 已生成 ${report.id}「${report.title}」(AI=${report.ai_composed})\n`);
        db.agentLog({ agent: "eli", ok: true, summary: `出刊 ${report.id}「${report.title}」`, metrics: { id: report.id, format: report.format || 1, refs: (report.references || []).length, en: !!report.en } }).catch(() => {});
        if (!r.existed) notifyWeeklyPublished(report);     // 站内通知全体用户:新周刊出刊
      }
      // 全自动群发 + 断点续发:只要闸开了、没在跑,就让引擎把「已出刊但还没发完」的补发完。
      // 引擎内部按 nlSentSet 过滤已成功的那批,只补发剩下的;批间照常歇档、命中风控自动冷却重发。
      if (process.env.NEWSLETTER_AUTO === "1" && process.env.NEWSLETTER_BULK === "1" && mailerOn() && !nlState.running) {
        sendWeeklyBulk(report);
      }
    } catch (e) { process.stderr.write("[周报] 定时生成失败: " + String(e.message || e).slice(0, 160) + "\n"); }
  }
  setTimeout(weeklyTick, 90 * 1000);
  setInterval(weeklyTick, 3600 * 1000);
  process.stderr.write("[周报] 每周自动出刊已开启(北京时间周一 9 点后生成" + (process.env.NEWSLETTER_AUTO === "1" ? ",并自动群发" : "") + ")\n");
}

// —— 每小时自动检索(用户 2026-07-17 要求:近期让站内 AI 定时全网检索,充实资讯/招聘)——
// 开关在服务器 .env:AUTO_HARVEST=1 开启;AUTO_HARVEST_MINUTES 间隔(默认 60);AUTO_HARVEST_BOOT 首轮延迟秒(默认 180)。
// 词池按小时轮换(约两天不重词);结果走与用户检索完全同一条反幻觉管线(harvestChannel:
// 搜索→抓原文→evidence 逐字校验→真实才入库),入库标"AI 检索收录",溯源记 auto-hourly。
const AUTO_QUERIES = {
  // 机会(用户 2026-07-18 要求:尤其多注意中国各省市的项目展览):省市 × 征集/驻留/展览 定向词池,
  // 走 searchAndHarvest(自带意图理解+地点硬过滤,搜"北京"不含北京的丢弃);官网直采,入库即可见。
  opportunities: [
    "北京 展览 征集 报名", "北京 艺术驻留 申请", "上海 展览 征集 投稿", "上海 艺术家 驻留 项目",
    "广州 艺术 征集 展览", "深圳 公共艺术 征集", "深圳 设计 双年展 征集", "杭州 艺术项目 征集",
    "成都 艺术展 征集 驻留", "重庆 展览 征集 投稿", "云南 大理 昆明 艺术驻留", "山东 济南 青岛 艺术 征集",
    "内蒙古 呼和浩特 艺术项目 展览", "新疆 乌鲁木齐 艺术展 征集", "西安 陕西 美术 征集",
    "武汉 湖北 艺术展 征集", "南京 江苏 艺术项目 征集", "苏州 美术馆 展览 征集",
    "长沙 湖南 青年艺术家 征集", "天津 艺术 展览 征集", "厦门 福建 艺术驻留 征集",
    "贵州 艺术乡建 驻留 项目", "兰州 甘肃 青海 艺术 征集", "哈尔滨 沈阳 大连 展览 征集",
    "郑州 河南 艺术 征集", "南昌 江西 景德镇 陶瓷 驻留", "桂林 广西 艺术驻留",
    "海南 三亚 艺术项目 征集", "山西 太原 艺术展 征集", "河北 石家庄 艺术 征集",
    "香港 艺术资助 计划 申请", "澳门 艺术节 征集", "青年艺术家 扶持 计划 征集", "全国 美术作品 展览 征稿",
    // —— 按艺术门类定向补词(v0.66.0 标签体系配套):让陶瓷/玻璃/纤维/声音/舞蹈/文学等
    //    小众门类也持续有新机会进来,尽量拉平各门类内容量(轮转机制自动均匀取词)——
    "陶瓷 陶艺 驻留 征集", "玻璃 琉璃 艺术 驻留 征集", "纤维艺术 染织 展览 征集",
    "漆艺 金工 首饰 手工艺 征集", "版画 工作坊 征集 招募", "插画 绘本 大赛 征稿",
    "动画 短片 征集", "声音艺术 音乐 委约 征集", "舞蹈 编舞 驻留 招募",
    "戏剧 剧本 孵化 征集", "诗歌 文学 写作 驻留 征稿", "建筑 空间设计 竞赛 征集",
    "服装 时尚 设计 大赛 征集", "书法 篆刻 展览 征稿", "行为艺术 现场 表演 征集",
    "新媒体 数字艺术 征集 驻留", "摄影 大赛 征稿", "雕塑 公共艺术 征集", "艺术评论 策展 工作坊 招募",
    // —— 数据全球化 L2(v0.76.1):世界艺术城市定向(靠 L0 地域自适应 + L1 平台放行,收国际一手/平台机会)——
    "纽约 艺术 驻留 征集 申请", "洛杉矶 艺术 展览 征集", "旧金山 艺术家 驻留 申请", "芝加哥 艺术 征集 展览",
    "伦敦 艺术 驻留 open call", "巴黎 艺术家 驻留 征集", "柏林 艺术 驻留 申请", "阿姆斯特丹 艺术驻留 征集",
    "东京 艺术 驻留 征集", "首尔 艺术 驻留 征集", "威尼斯 米兰 艺术 征集", "巴塞罗那 马德里 艺术驻留",
    "新加坡 艺术 征集 驻留", "悉尼 墨尔本 艺术驻留 征集", "多伦多 温哥华 艺术 征集", "迪拜 中东 艺术驻留",
    "international artist residency open call apply", "international art prize grant open call for artists",
    "museum open call for artists submissions", "art foundation fellowship grant application artists",
    // —— 中国下沉:中小城市 × 机会类型(尤其体制内/学术/商业各类项目展览)——
    "宁波 温州 艺术 征集 驻留", "无锡 常州 苏州 艺术展 征集", "佛山 东莞 艺术 征集 驻留",
    "泉州 福州 厦门 艺术驻留 征集", "南宁 柳州 桂林 艺术 征集", "洛阳 开封 郑州 艺术展 征集",
    "大连 沈阳 长春 艺术 征集 驻留", "烟台 潍坊 临沂 艺术展 征集", "徐州 扬州 南通 艺术 征集",
    "绍兴 嘉兴 金华 台州 艺术驻留", "惠州 中山 江门 珠海 艺术征集", "遵义 贵阳 艺术 驻留 项目",
    "丽江 大理 昆明 艺术驻留 征集", "宜兴 龙泉 德化 陶瓷 驻留 征集", "银川 西宁 拉萨 艺术项目 征集",
    "包头 大同 太原 艺术展 征集", "湛江 汕头 潮州 艺术 征集", "常德 岳阳 湖南 艺术项目 征集",
    // —— 机构类型定向(体制内 / 学术 / 商业)——
    "省文化和旅游厅 美术 作品 征集 官网", "市画院 美协 文联 展览 征集", "地方美术馆 年度 展览 征集 报名",
    "美术学院 学术展 征集 官网", "艺术研究院 大学 美术馆 项目 征集", "文创园区 艺术空间 驻留 招募",
    "商业画廊 青年艺术家 计划 征集", "艺术基金会 资助 扶持 计划 申请", "高校 研究生 毕业 创作 征集展",
    // —— 类型均衡(2026-08-22):实测缺口=商业3/grant11/workshop13,补以下短板定向词——
    //   商业/市场类(商业galery/艺博会/拍卖/品牌赞助)
    "commercial gallery open call emerging artists", "art fair open call artists application",
    "auction house art prize open call", "当代艺术品 拍卖 征集 委托", "品牌 艺术 赞助 项目 征集 | 商业艺术 大赛 报名",
    "commercial art award cash prize open call", "luxury brand art collaboration open call",
    //   grant/基金/资助类(免费资金来源,独立学术/非营利主流)
    "art grant for independent artists apply", "artist emergency grant application",
    "open call art fund stipend 2026", "艺术家 创作 基金 申请 开放", "艺术非营利 机构 资助 项目 申请",
    "art foundation fellowship grant open", "independent artist project support grant",
    //   workshop/工作坊/大师班类
    "art workshop open call participants", "艺术家 工作坊 招募 报名 免费", "masterclass art open call apply",
    "artist residency workshop program application", "版画 工作坊 招募 艺术家",
    //   drop-in/独立学术/策展实验室
    "independent curator open call exhibition", "艺术策展 实验室 招募 申报", "独立艺术空间 open call 征集",
    "artist collective open call join", "free art residency no fee apply", "零费用 艺术驻留 申请 免费"
  ],
  news: [
    "美术馆 新展 开幕", "双年展 艺术 新闻", "当代艺术 展览 报道", "艺术家 获奖 消息",
    "画廊 个展 开幕", "艺术市场 拍卖 新闻", "公共艺术 项目 落成", "艺术节 开幕 现场",
    "摄影 展览 资讯", "设计 展览 开幕", "雕塑 装置 展览 新闻", "水墨 书法 展览 消息",
    "contemporary art exhibition news", "museum new exhibition opening", "art biennale news",
    "artist award announcement", "gallery show opening review", "art fair news",
    "青年艺术家 展览 报道", "艺术院校 毕业展 新闻", "驻留项目 成果 展览", "行为艺术 现场 报道",
    "新媒体艺术 展览 消息", "艺术书 出版 消息",
    // —— 按门类定向补词(小众门类的资讯也要有)——
    "陶瓷 陶艺 展览 资讯", "玻璃艺术 展览 消息", "纤维 织物 艺术 展览 报道",
    "声音艺术 演出 报道", "舞蹈 剧场 演出 资讯", "文学 诗歌 出版 消息",
    "建筑 设计 展览 报道", "插画 绘本 出版 资讯", "动画 电影节 消息", "时装 时尚 设计 新闻"
  ],
  jobs: [
    "美术馆 招聘 策展", "画廊 招聘 助理", "艺术机构 招聘", "博物馆 招聘 公共教育",
    "艺术中心 招聘 运营", "拍卖行 招聘", "艺术媒体 招聘 编辑", "艺术教育 机构 招聘",
    "museum curator job opening", "gallery assistant job", "art institution hiring",
    "artist studio assistant job", "art fair jobs", "auction house job opening",
    "文化机构 招聘 展览", "美术学院 招聘 教师", "艺术基金会 招聘", "设计工作室 招聘",
    "art residency coordinator job", "museum registrar job",
    // —— 按门类定向补词(各门类艺术家都有对口岗位可看)——
    "服装 时尚 设计师 招聘", "建筑 事务所 招聘 设计师", "出版社 艺术 编辑 招聘",
    "剧院 舞团 招聘", "陶瓷 工作室 招聘", "动画 插画 招聘", "音乐 机构 招聘", "摄影 机构 招聘"
  ]
};
// 省额策略(2026-07-18,余额撑半年):每轮只跑【一个】频道,按 机会→资讯→机会→招聘 轮转
// (机会双倍权重);当天 serper 预算余量不足时整轮让路,把余量留给用户手动检索。
const AUTO_ROTATION = ["opportunities", "news", "opportunities", "jobs"];
let autoTickN = 0;

// —— 机会类型均衡短板感知(2026-08-23 线上化)——
// 服务器自给自足:每小时用【服务器本地】机会数据 realtime 算短板词(官方/商业/独立学术 × 免费/收费 × 类别),
// 结果注入区域经理选词与自动检索机会渠道。全程无本机依赖:电脑关机,服务器照样每天补短板类型。
async function balanceTick() {
  try {
    const raw = JSON.parse(await readFile(DATA, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.opportunities || raw.items || []);
    const res = computeShortageTerms(arr);
    const shortPool = Object.values(res.recommended_terms || {}).flat();
    setShortagePool(shortPool);                                  // 供区域经理 pickQueries + 自动检索前置短板词
    if (res.shortages.length) {
      const buckets = res.shortages.map(s => s.bucket).join(",");
      process.stderr.write(`[均衡感知] 短板 ${buckets} → 已注入 ${shortPool.length} 个短板补抓词入区域经理/自动检索选词池\n`);
      db.agentLog({ agent: "balance", ok: true, summary: `短板感知:${buckets}`, metrics: { shortages: res.shortages.length, terms: shortPool.length, total: res.total } }).catch(() => {});
    }
  } catch (e) {
    process.stderr.write(`[均衡感知] 计算失败(静默,不影响其余线程):${String(e.message || e).slice(0, 120)}\n`);
  }
}
// 每小时算一次短板;首轮 3 分钟后跑,让启动期先有一次覆盖
setTimeout(balanceTick, 180 * 1000);
setInterval(balanceTick, 3600 * 1000);

async function autoHarvestTick() {
  if (process.env.SERPER_API_KEY && serperBudgetLeft() < 6) {
    process.stderr.write("[自动检索] 今日搜索预算余量不足,本轮让路(优先保用户手动检索)\n");
    db.agentLog({ agent: "scout", ok: true, summary: "预算余量不足,本轮让路(保用户手动检索)", metrics: { skipped: true } }).catch(() => {});
    return;
  }
  const ch = AUTO_ROTATION[autoTickN++ % AUTO_ROTATION.length];
  let pool = AUTO_QUERIES[ch];
  // 类型均衡短板感知(2026-08-23 线上化):机会渠道随机取词时,若存在短板词,从短板词池里随机挑,让
  // 商业/grant/workshop/免费等短板类型不再纯靠运气。短线词池由 balanceTick 每小时在【服务器本地】实时算并更新。
  if (ch === "opportunities" && getShortagePool().length) {
    const sp = getShortagePool();
    if (Math.random() < 0.6) pool = [sp[Math.floor(Math.random() * sp.length)]].concat(Object.keys(AUTO_QUERIES).length ? AUTO_QUERIES.opportunities : []);
  }
  const q = pool[Math.floor(Math.random() * pool.length)];   // 随机取词:长期均匀覆盖词池,无需持久化游标
  try {
    await acquireSlot();                       // 和用户检索共用并发闸,互不挤占
    try {
      const t0 = Date.now();
      const r = ch === "opportunities" ? await searchAndHarvest(q, 6, null, "auto") : await harvestChannel(ch, q, 6, "auto");
      for (const rec of r.added) {
        db.ingestInsert({ channel: ch, record_id: rec.id, title: rec.title_zh || rec.title, q, uid: null, email: "auto-hourly", ip: "server" });
      }
      process.stderr.write(`[自动检索·${ch}] "${q}" → 探测${r.probed} 入库${r.added.length} (${Math.round((Date.now() - t0) / 1000)}s,今日搜索余量${serperBudgetLeft()})\n`);
      db.agentLog({ agent: "scout", ok: true, summary: `${ch}「${q}」探测${r.probed} 入库${r.added.length}`, metrics: { channel: ch, q, probed: r.probed, added: r.added.length }, took_ms: Date.now() - t0 }).catch(() => {});
    } finally { releaseSlot(); }
  } catch (e) {
    process.stderr.write(`[自动检索·${ch}] "${q}" 失败: ${String(e.message || e).slice(0, 120)}\n`);
    db.agentLog({ agent: "scout", ok: false, summary: `${ch}「${q}」失败:` + String(e.message || e).slice(0, 120) }).catch(() => {});
  }
}
// REGION_HARVEST=1 时由区域经理编队接管机会频道(见下),这里的旧轮转必须让位,否则双份花 serper。
if (process.env.AUTO_HARVEST === "1" && process.env.REGION_HARVEST !== "1") {
  const mins = Math.max(10, Number(process.env.AUTO_HARVEST_MINUTES || 480));   // 默认 8 小时一轮(省额);下限 10 分钟防手滑
  const boot = Math.max(5, Number(process.env.AUTO_HARVEST_BOOT || 180));
  setTimeout(autoHarvestTick, boot * 1000);
  setInterval(autoHarvestTick, mins * 60 * 1000);
  process.stderr.write(`[自动检索] 已开启:每 ${mins} 分钟检索一个频道(机会→资讯→机会→招聘 轮转;首轮 ${boot} 秒后)\n`);
}

// —— 区域经理编队(v0.98.0,路线图第 18 项 L3)——
// 用户诉求:在全球艺术兴盛的地方各设"区域经理",轮流每天抓取,既摊平能耗又让站点天天有新内容。
// 调度规则见 lib/regions.mjs 与 regions.json:中国基本盘常驻天天上班 + 中国/国际两组各轮值一位,
// 每位在【当地】上午上班 —— 负载天然摊到 24 小时,用户任何时候刷新都能看到刚入库的新条目。
// 抓取本身完全复用 searchAndHarvest(反幻觉 evidence 逐字校验一条不改),只是把地区给死、跳过 AI 猜地点。
// 开关 REGION_HARVEST=1;每班词数 REGION_QUERIES_PER_SHIFT(默认 3)。
// 预算账(每词 2 次 serper:官网限定 + 原词):每天 3 位经理 × 3 词 × 2 = 18,加编辑部 2 班约 8,
// 合计约 26 次/天 —— 日预算 70 下仍给用户手动检索和「探长」留足余量。
// 调度体在模块级(不裹在开关里):/admin 的「立即上班」要能手动调,便于开幕前当场补一班内容。
{
  const doneShifts = new Set();                        // "日序号:经理id" —— 每人每天只上一次班(幂等,防重启重跑)
  let regionRunning = false;

  async function runShift(m, q) {
    const t0 = Date.now();
    await acquireSlot();                               // 与用户检索共用并发闸,互不挤占
    try {
      const r = await searchAndHarvest(q, 6, { gl: m.gl, hl: m.hl, terms: m.terms, label: m.zh });
      for (const rec of r.added) {
        db.ingestInsert({ channel: "opportunities", record_id: rec.id, title: rec.title_zh || rec.title, q, uid: null, email: "region:" + m.id, ip: "server" });
      }
      process.stderr.write(`[区域经理·${m.zh}] "${q}" → 探测${r.probed} 入库${r.added.length} (${Math.round((Date.now() - t0) / 1000)}s,今日搜索余量${serperBudgetLeft()})\n`);
      await recordShift(m.id, { q, probed: r.probed, added: r.added.length, ok: true, took_ms: Date.now() - t0 });
      return r.added.length;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 120);
      process.stderr.write(`[区域经理·${m.zh}] "${q}" 失败: ${msg}\n`);
      await recordShift(m.id, { q, probed: 0, added: 0, ok: false, error: msg, took_ms: Date.now() - t0 });
      return 0;
    } finally { releaseSlot(); }
  }

  // forceId:/admin「立即上班」传经理 id —— 跳过"当值日 + 上班点 + 今日已跑"三道判定,直接排一班。
  async function regionTick(forceId = null) {
    if (regionRunning) {
      // ★ 2026-07-30 修复:手动触发撞上服务器自己每 10 分钟一次的自动排班,原实现直接放弃并
      //   静默返回 skipped——而 /api/admin/regions/run 端点又是 fire-and-forget(不等这个 Promise
      //   就先回 200),两者叠加=页面显示"已开工"但实际啥也没干,批量补种时曾丢过 7/15 个班次。
      //   现在改成:手动触发时【等锁释放】(最多等 8 分钟,与单班上限接近),而不是立刻放弃;
      //   自动调度(forceId=null)维持原样直接跳过——它有下一个 10 分钟窗口,没必要等。
      if (!forceId) return { skipped: "running" };
      for (let waited = 0; regionRunning && waited < 480; waited += 3) await new Promise(r => setTimeout(r, 3000));
      if (regionRunning) return { skipped: "running-timeout" };
    }
    let cfg;
    try { cfg = await loadRegions(); }
    catch (e) { process.stderr.write("[区域经理] regions.json 读取失败,本轮跳过:" + String(e.message || e).slice(0, 100) + "\n"); return { error: "config" }; }
    const now = new Date();
    const day = dayIndex(now);
    // 幂等两道:①进程内 doneShifts ②成绩单里的 last_at 落在同一个北京日 —— 第②道是给【重启】兜底的,
    // 否则 systemd 重启一次就会把当天已跑过的班再花一遍 serper。
    let score = {};
    try { score = await reportView(); } catch (e) {}
    const ranToday = (id) => {
      const la = score[id] && score[id].last_at;
      return !!la && Math.floor((new Date(la).getTime() + 8 * 3600e3) / 86400000) === day;
    };
    const forced = forceId ? cfg.managers.filter(m => m.id === forceId) : null;
    if (forceId && !forced.length) return { error: "no-such-manager" };
    const due = forced || dueNow(cfg.managers, now).filter(m => !doneShifts.has(day + ":" + m.id) && !ranToday(m.id));
    // 编辑部班次:资讯/招聘不按地区,每天固定两班,保持三频道都在长
    const deskDue = forceId ? [] : cfg.desk.filter(s => s.utc_hour === now.getUTCHours() && !doneShifts.has(day + ":desk-" + s.channel));
    if (!due.length && !deskDue.length) return { skipped: "nothing-due" };

    if (process.env.SERPER_API_KEY && serperBudgetLeft() < 6) {
      process.stderr.write("[区域经理] 今日搜索预算余量不足,本班让路(优先保用户手动检索)\n");
      db.agentLog({ agent: "scout", ok: true, summary: "预算不足,区域经理本班让路", metrics: { skipped: true } }).catch(() => {});
      return { skipped: "budget" };                      // 不标记 done:预算恢复后(或明天)还能补上
    }

    regionRunning = true;
    const done = [];
    try {
      const perShift = Math.max(1, Number(process.env.REGION_QUERIES_PER_SHIFT || 3));
      for (const m of due) {
        doneShifts.add(day + ":" + m.id);
        let added = 0;
        const qs = pickQueries(m, perShift, now);
        for (const q of qs) {
          if (process.env.SERPER_API_KEY && serperBudgetLeft() < 4) break;   // 班中余量见底就收工
          added += await runShift(m, q);
        }
        db.agentLog({ agent: "region:" + m.id, ok: true,
          summary: `${m.zh} 当班 ${qs.length} 词 → 入库 ${added}`,
          metrics: { region: m.id, queries: qs.length, added } }).catch(() => {});
        done.push({ id: m.id, zh: m.zh, queries: qs.length, added });
      }
      for (const s of deskDue) {
        doneShifts.add(day + ":desk-" + s.channel);
        const pool = AUTO_QUERIES[s.channel];
        if (!pool || !pool.length) continue;
        const q = pool[day % pool.length];               // 确定性取词,长期均匀走完词池
        const t0 = Date.now();
        await acquireSlot();
        try {
          const r = await harvestChannel(s.channel, q, 6);
          for (const rec of r.added) db.ingestInsert({ channel: s.channel, record_id: rec.id, title: rec.title_zh || rec.title, q, uid: null, email: "desk", ip: "server" });
          process.stderr.write(`[编辑部·${s.channel}] "${q}" → 探测${r.probed} 入库${r.added.length} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
          db.agentLog({ agent: "scout", ok: true, summary: `${s.channel}「${q}」探测${r.probed} 入库${r.added.length}`, metrics: { channel: s.channel, q, probed: r.probed, added: r.added.length }, took_ms: Date.now() - t0 }).catch(() => {});
        } catch (e) {
          process.stderr.write(`[编辑部·${s.channel}] "${q}" 失败: ${String(e.message || e).slice(0, 120)}\n`);
        } finally { releaseSlot(); }
      }
    } finally {
      regionRunning = false;
      if (doneShifts.size > 400) doneShifts.clear();     // 跨天累积清理(键含日序号,清了也不会重跑当天已跑的班——最坏多跑一班)
    }
    return { ok: true, shifts: done, serper_left: serperBudgetLeft() };
  }
  regionRunNow = regionTick;                             // 交给 /admin「立即上班」

  if (process.env.REGION_HARVEST === "1") {
    setTimeout(() => regionTick(), 70 * 1000);
    setInterval(() => regionTick(), 10 * 60 * 1000);      // 每 10 分钟对一次表,不会错过整点班次
    loadRegions().then(c => {
      const cn = c.managers.filter(m => m.kind !== "intl").length, intl = c.managers.filter(m => m.kind === "intl").length;
      process.stderr.write(`[区域经理] 编队已就位:${c.managers.length} 位(中国 ${cn} · 国际 ${intl}),按当地上班时间错峰轮值,每班 ${Math.max(1, Number(process.env.REGION_QUERIES_PER_SHIFT || 3))} 词\n`);
    }).catch(e => process.stderr.write("[区域经理] 档案加载失败:" + String(e.message || e).slice(0, 120) + "\n"));
  }
}

// —— 数据质检 agent「校勘」(v0.74.0)——
// 四类离线巡检(死链/过期/查重/存证抽查)→ 在写锁内落库 → 写报告 → 巡视台打卡。
// 复用现有件:探测/存证共用 fetchSource(lib/qc.mjs)、指纹用 dedupe、归档三件套(recycle+移除+墓碑,防夜间 sync 复活)。
// 开关:QUALITY_CHECK=1 每日北京时间 QUALITY_HOUR(默认 4)点跑一次;QC_ARCHIVE=1 才自动归档(默认只标记,交后台一键归档)。
const QC_REPORT_PATH = join(__dir, "state", "qc-report.json");
const qcState = { running: false, startedAt: null, lastRun: null };
async function readQcReport() { try { return JSON.parse(await readFile(QC_REPORT_PATH, "utf8")); } catch (e) { return null; } }

// 存证抽查回调:重抓原文已在手,这里重跑入库同一条 extract+verifyRecord 管线,比对漂移(唯一可靠的存证复核)。
// 只在强信号上转人工:①AI 复核判"已非可申请机会";②截止日期与原文核出的不一致;③原文已核不到原截止。绝不擅改/删。
async function qcEvidenceAudit(o, text, ctx) {
  let ex;
  try { ex = await extract(text, { org_zh: o.org_zh || "", domain: ctx.domain, url: ctx.url, source_url: o.source_url || ctx.url, sourceText: text }); }
  catch (e) { return null; }
  if (!ex || !ex.data) return null;
  const v = verifyRecord(ex.data, { sourceText: text, url: ctx.url, source_url: o.source_url || ctx.url, domain: ctx.domain });
  if (v.dropped) return /not-applicable/.test(v.dropReason || "") ? { reason: "AI 复核:原文已非可申请机会" } : null;
  const oldD = o.deadline, newD = v.record.deadline;
  if (oldD && isParseableDate(oldD) && newD && isParseableDate(newD) && newD !== oldD) return { reason: `截止日期存疑:库 ${oldD} → 原文 ${newD}` };
  if (oldD && isParseableDate(oldD) && !newD) return { reason: `原文已核不到截止日期(库 ${oldD})` };
  return null;
}

async function runQualityCheck({ archive = false, probe = true, trigger = "auto", channels } = {}) {
  if (qcState.running) return { skipped: true, reason: "already-running" };
  qcState.running = true; qcState.startedAt = new Date().toISOString();
  const t0 = Date.now();
  const gate = { acquire: acquireSlot, release: releaseSlot };
  const chList = channels || Object.keys(CH_FILES);
  const rep = { at: new Date().toISOString(), trigger, took_ms: 0, archive_enabled: !!archive, channels: {}, totals: {} };
  try {
    for (const channel of chList) {
      const [file, key] = CH_FILES[channel];
      let doc, records;
      try { doc = JSON.parse(await readFile(file, "utf8")); records = doc[key] || []; }
      catch (e) { rep.channels[channel] = { error: "read-failed:" + String(e.message || e).slice(0, 80) }; continue; }

      const insp = await inspectChannel(channel, records, {
        today: todayISO(), gate, probe,
        evidenceAudit: qcEvidenceAudit, evidenceSample: Number(process.env.QC_EVIDENCE_SAMPLE || 6)
      });

      const archivedIds = [];
      await withWriteLock(async () => {
        let cur, arr;
        try { cur = JSON.parse(await readFile(file, "utf8")); arr = cur[key] || []; } catch (e) { return; }
        const byId = new Map(arr.map(o => [o.id, o]));
        if (archive) {                                   // 先把要归档的整条存进回收站(可恢复)
          for (const a of insp.archiveCandidates) {
            const recRow = byId.get(a.id);
            if (!recRow) continue;
            try { await db.recycleInsert(channel, recRow); archivedIds.push(a.id); } catch (e) {}
          }
        }
        const drop = new Set(archivedIds);
        const next = [];
        for (const o of arr) {
          if (drop.has(o.id)) continue;                  // 已进回收站 → 从文件移除
          const patch = insp.mutations[o.id];
          if (patch) Object.assign(o, patch);            // 就地更新 status/_fail_streak/last_seen/updated_at
          next.push(o);
        }
        cur[key] = next;
        if (cur.count != null) cur.count = next.length;
        const tmp = file + ".tmp-" + process.pid;
        await writeFile(tmp, JSON.stringify(cur, null, 2), "utf8");
        await rename(tmp, file);
      });
      for (const id of archivedIds) {                    // 立墓碑(防夜间 sync 复活)+ 审计
        try { await tombAdd(channel, id); } catch (e) {}
        try { await db.logModeration("content", id, "archived", { by: "qc", channel }); } catch (e) {}
      }

      rep.channels[channel] = {
        checked: insp.checked, probed: insp.probed,
        dead: insp.deadCandidates.length, revived: insp.revived.length,
        newly_expired: insp.newlyExpired.length,
        duplicates: insp.duplicates.reduce((n, d) => n + d.drop.length, 0),
        archive_candidates: insp.archiveCandidates.length, archived: archivedIds.length,
        evidence_flags: insp.evidenceFlags.length, evidence_audited: insp.evidenceAudited,
        dead_list: insp.deadCandidates.slice(0, 100),
        evidence_list: insp.evidenceFlags.slice(0, 100),
        archive_list: insp.archiveCandidates.slice(0, 300),
        dup_list: insp.duplicates.slice(0, 100)
      };
    }
    const agg = (f) => Object.values(rep.channels).reduce((n, c) => n + (c[f] || 0), 0);
    rep.totals = { checked: agg("checked"), probed: agg("probed"), dead: agg("dead"), revived: agg("revived"),
      newly_expired: agg("newly_expired"), duplicates: agg("duplicates"),
      archive_candidates: agg("archive_candidates"), archived: agg("archived"),
      evidence_audited: agg("evidence_audited"), evidence_flags: agg("evidence_flags") };
    rep.took_ms = Date.now() - t0;
    try { const tmp = QC_REPORT_PATH + ".tmp-" + process.pid; await writeFile(tmp, JSON.stringify(rep, null, 2), "utf8"); await rename(tmp, QC_REPORT_PATH); } catch (e) {}
    qcState.lastRun = rep.at;
    const T = rep.totals;
    const summary = `巡检 ${T.checked} 条(探测 ${T.probed}):死链 ${T.dead}·新过期 ${T.newly_expired}·重复 ${T.duplicates}·存证存疑 ${T.evidence_flags}·归档 ${T.archived}/${T.archive_candidates}`;
    db.agentLog({ agent: "inspector", ok: true, summary, metrics: T, took_ms: rep.took_ms }).catch(() => {});
    process.stderr.write(`[数据质检] ${summary}\n`);
    return { ok: true, report: rep };
  } catch (e) {
    process.stderr.write("[数据质检] 失败: " + String(e.message || e).slice(0, 160) + "\n");
    db.agentLog({ agent: "inspector", ok: false, summary: "质检失败:" + String(e.message || e).slice(0, 120), took_ms: Date.now() - t0 }).catch(() => {});
    return { ok: false, error: String(e.message || e) };
  } finally { qcState.running = false; }
}

// —— 下架作品恢复期清理(v0.100.0)——
// 拒绝/下架的作品图片留在非公开目录给 WORK_RESTORE_DAYS 天反悔窗口,过期就真删,
// 免得非公开目录无限堆积。每天跑一次;数据库记录保留(留审计痕迹),只删图片文件。
async function purgeExpiredWorkImages() {
  const cutoff = new Date(Date.now() - WORK_RESTORE_DAYS * 86400e3).toISOString();
  let files = 0, works = 0;
  try {
    for (const w of await db.worksRejectedBefore(cutoff)) {
      let hit = false;
      for (const n of w.images) {
        if (!workFileRe.test(n)) continue;
        try { await unlink(join(WORKS_PENDING, n)); files++; hit = true; } catch (e) {}   // 已删过就跳过
      }
      if (hit) works++;
    }
    if (files) process.stderr.write(`[作品清理] 恢复期(${WORK_RESTORE_DAYS} 天)已过:清理 ${works} 组作品共 ${files} 张图\n`);
  } catch (e) { process.stderr.write("[作品清理] 失败:" + String(e.message || e).slice(0, 120) + "\n"); }
  return { works, files };
}
{
  let pwDay = null;
  function purgeTick() {
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    if (pwDay === day) return;                 // 每日幂等
    pwDay = day;
    purgeExpiredWorkImages().catch(() => {});
  }
  setTimeout(purgeTick, 150 * 1000);
  setInterval(purgeTick, 3600 * 1000);
}

if (process.env.QUALITY_CHECK === "1") {
  let qcDay = null;
  async function qcTick() {
    const bj = new Date(Date.now() + 8 * 3600e3);
    if (bj.getUTCHours() !== Number(process.env.QUALITY_HOUR || 4)) return;   // 北京时间某点(默认凌晨 4 点低峰)
    const day = bj.toISOString().slice(0, 10);
    if (qcDay === day) return;                                                // 每日幂等
    qcDay = day;
    runQualityCheck({ archive: process.env.QC_ARCHIVE === "1", trigger: "auto" }).catch(() => {});
  }
  setTimeout(qcTick, 120 * 1000);
  setInterval(qcTick, 3600 * 1000);
  process.stderr.write(`[数据质检] 已开启:每日北京时间 ${Number(process.env.QUALITY_HOUR || 4)} 点巡检${process.env.QC_ARCHIVE === "1" ? "(含自动归档)" : "(仅标记,归档需后台确认)"}\n`);
}

// —— 每日数据抓取搬上服务器(2026-07-21)——
// 本机 run-daily.bat 依赖夜间开机、7-16 后就没跑过,导致 sources.json 的 152 个信源基本闲置。搬到常开服务器,
// 让存量信源每天真被抓、数据稳定增长。开关 DAILY_CRAWL=1;每日北京 DAILY_CRAWL_HOUR(默认 3)点跑一次(在质检 4 点前),
// 幂等;spawn 子进程不阻塞 web 服务。run.mjs 已改并发安全(原子写+写前补回 server 期间新增),与 server.mjs 同写不丢数据。
// 只跑 run.mjs(机会频道);截图(mShots 服务器被 403)留本机;翻译/官网定位后续再评估上服务器。
if (process.env.DAILY_CRAWL === "1") {
  let dcDay = null, dcRunning = false;
  function dailyCrawlTick() {
    const bj = new Date(Date.now() + 8 * 3600e3);
    if (bj.getUTCHours() !== Number(process.env.DAILY_CRAWL_HOUR || 3)) return;
    const day = bj.toISOString().slice(0, 10);
    if (dcDay === day || dcRunning) return;
    dcDay = day; dcRunning = true;
    const t0 = Date.now();
    const cap = String(Math.max(4, Number(process.env.DAILY_CRAWL_CAP || 12)));
    process.stderr.write("[每日抓取] 启动 run.mjs --cap " + cap + "\n");
    // 攒 Buffer 收尾一次性解码,别逐块 toString()——中文字符可能被切在两个 data 块中间,
    // 逐块解码会拼出乱码(v0.99.2 修:「铁犁」打卡摘要经常出现替换符就是这个坑)。
    let tailBuf = Buffer.alloc(0);
    function pushChunk(d) { tailBuf = Buffer.concat([tailBuf, d]); if (tailBuf.length > 4000) tailBuf = tailBuf.subarray(tailBuf.length - 4000); }
    const p = spawn(process.execPath, [join(__dir, "run.mjs"), "--cap", cap], { cwd: __dir, env: process.env });
    p.stdout.on("data", pushChunk);
    p.stderr.on("data", pushChunk);
    p.on("close", (code) => {
      dcRunning = false;
      const tail = tailBuf.toString("utf8").replace(/\s+/g, " ").slice(-150);
      process.stderr.write("[每日抓取] run.mjs 结束 code=" + code + " 用时 " + Math.round((Date.now() - t0) / 1000) + "s\n");
      db.agentLog({ agent: "harvester", ok: code === 0, summary: "服务器每日抓取 run.mjs(code=" + code + "):" + tail, took_ms: Date.now() - t0 }).catch(() => {});
    });
    p.on("error", (e) => { dcRunning = false; process.stderr.write("[每日抓取] spawn 失败:" + e.message + "\n"); });
  }
  setTimeout(dailyCrawlTick, 200 * 1000);
  setInterval(dailyCrawlTick, 3600 * 1000);
  process.stderr.write("[每日抓取] 已开启:每日北京时间 " + Number(process.env.DAILY_CRAWL_HOUR || 3) + " 点抓 sources.json 全部信源(run.mjs,并发安全)\n");
}

// —— 双线/译者/寻址 也搬上服务器(2026-08-04)——
// 本机 run-daily.bat 依赖夜间开机,用户电脑晚上实际关机,这几个 agent 长期"从未打卡"。
// 只有截图(mShots 服务器访问被 403)必须留本机,其余都是纯 API 调用,没有本机依赖,可以搬。
// 服务器内存吃紧(实测 swap 已用 ~1.7G/3G),同一时刻只跑一个子进程(串行,不并发),
// 且挑开 DAILY_CRAWL(3点)/质检(4点)/AUTO_DISCOVER(5点)之外的时段。
function runChild(scriptFile, args = []) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let tailBuf = Buffer.alloc(0);
    function pushChunk(d) { tailBuf = Buffer.concat([tailBuf, d]); if (tailBuf.length > 4000) tailBuf = tailBuf.subarray(tailBuf.length - 4000); }
    const p = spawn(process.execPath, [join(__dir, scriptFile), ...args], { cwd: __dir, env: process.env });
    p.stdout.on("data", pushChunk);
    p.stderr.on("data", pushChunk);
    p.on("close", (code) => {
      process.stderr.write("[" + scriptFile + "] 结束 code=" + code + " 用时 " + Math.round((Date.now() - t0) / 1000) + "s\n");
      resolve(code);
    });
    p.on("error", (e) => { process.stderr.write("[" + scriptFile + "] spawn 失败:" + e.message + "\n"); resolve(-1); });
  });
}
if (process.env.CHANNELS_CRAWL === "1") {
  let ccDay = null, ccRunning = false;
  async function channelsCrawlTick() {
    const bj = new Date(Date.now() + 8 * 3600e3);
    if (bj.getUTCHours() !== Number(process.env.CHANNELS_CRAWL_HOUR || 2)) return;
    const day = bj.toISOString().slice(0, 10);
    if (ccDay === day || ccRunning) return;
    ccDay = day; ccRunning = true;
    process.stderr.write("[双线/译者(资讯招聘)] 启动\n");
    await runChild("run-channels.mjs");        // 资讯/招聘每日抓取(agent: channels,脚本自带 reportAgent)
    await runChild("backfill-channel-i18n.mjs"); // 资讯/招聘补双语(无独立 agent 工牌,归在此块日志里)
    ccRunning = false;
  }
  setTimeout(channelsCrawlTick, 260 * 1000);
  setInterval(channelsCrawlTick, 3600 * 1000);
  process.stderr.write("[双线] 已开启:每日北京时间 " + Number(process.env.CHANNELS_CRAWL_HOUR || 2) + " 点抓资讯/招聘 + 补双语(串行,不与截图抢本机)\n");
}
if (process.env.BACKFILL_EN === "1") {
  let beDay = null, beRunning = false;
  async function backfillEnTick() {
    const bj = new Date(Date.now() + 8 * 3600e3);
    if (bj.getUTCHours() !== Number(process.env.BACKFILL_EN_HOUR || 6)) return;
    const day = bj.toISOString().slice(0, 10);
    if (beDay === day || beRunning) return;
    beDay = day; beRunning = true;
    process.stderr.write("[译者/寻址(机会双语+官网定位)] 启动\n");
    await runChild("backfill-en.mjs");         // 机会条目双语回填(agent: translator)
    await runChild("backfill-official.mjs");   // 主办方官网定位(agent: locator)
    beRunning = false;
  }
  setTimeout(backfillEnTick, 320 * 1000);
  setInterval(backfillEnTick, 3600 * 1000);
  process.stderr.write("[译者/寻址] 已开启:每日北京时间 " + Number(process.env.BACKFILL_EN_HOUR || 6) + " 点补双语 + 定位官网(串行)\n");
}

// —— 「快门」截图封面也搬上服务器(v1.2.0)——
// 曾因 mShots 封服务器 IP 只能本机跑,但用户电脑晚上关机,新条目永远轮不到截图,无封面缺口每日扩大
// (2026-08-04 实测 685 条可见有 367 条无封面)。现改 SHOT_PROVIDER=puppeteer 本地无头浏览器截图,
// 与 mShots 彻底解耦。子进程串行跑(跑完退出释放 Chromium 内存,2核2G 扛得住),每晚上限由
// SHOT_MAX 控制,几晚清完存量,之后新条目当晚有图。
if (process.env.SCREENSHOT_BACKFILL === "1") {
  let ssDay = null, ssRunning = false;
  async function screenshotTick() {
    const bj = new Date(Date.now() + 8 * 3600e3);
    if (bj.getUTCHours() !== Number(process.env.SCREENSHOT_HOUR || 7)) return;
    const day = bj.toISOString().slice(0, 10);
    if (ssDay === day || ssRunning) return;
    ssDay = day; ssRunning = true;
    process.stderr.write("[快门(截图封面)] 启动\n");
    await runChild("backfill-screenshots.mjs");     // 机会封面(agent: photographer,脚本自带打卡)
    await runChild("backfill-channel-covers.mjs");  // 资讯/招聘封面
    ssRunning = false;
  }
  setTimeout(screenshotTick, 380 * 1000);
  setInterval(screenshotTick, 3600 * 1000);
  process.stderr.write("[快门] 已开启:每日北京时间 " + Number(process.env.SCREENSHOT_HOUR || 7) + " 点补截图封面(puppeteer,串行,上限 SHOT_MAX)\n");
}

// —— 自动化发现「探长」(v0.82.0,路线图第 6 项合规可行版)——
// 社媒(小红书/微博)只作线索:只读搜索引擎索引的标题/摘要(拿不到链接,结构上不可能抓社媒页面),
// GLM(免费档,v0.99.2 起专用——DeepSeek 断粮期间不再兜底)提炼机会名+主办方(原文子串校验)
// → 走 searchAndHarvest 官网检索管线,evidence 过关才入库。
// 开关 AUTO_DISCOVER=1;每日北京 DISCOVER_HOUR(默认 5)点一勘(质检 4 点之后);DISCOVER_CAP 每日线索上限(默认 2)。
// serper 余量 < 15 直接休勘让路(线索 1 次 + 每线索官网检索多次,勘一轮成本不小)。
if (process.env.AUTO_DISCOVER === "1") {
  let ldDay = null, ldRunning = false;
  async function leadsRun() {
    const bj = new Date(Date.now() + 8 * 3600e3);
    if (bj.getUTCHours() !== Number(process.env.DISCOVER_HOUR || 5)) return;
    const day = bj.toISOString().slice(0, 10);
    if (ldDay === day || ldRunning) return;
    ldDay = day; ldRunning = true;
    const t0 = Date.now();
    try {
      if (serperBudgetLeft() < 15) {
        db.agentLog({ agent: "detective", ok: true, summary: "serper 余量不足,今日休勘(保用户检索)", metrics: { skipped: true } }).catch(() => {});
        return;
      }
      const r = await leadsTick({ harvest: (q, t) => searchAndHarvest(q, t, null, "detective") });
      const brief = r.clueNames.length ? ":" + r.clueNames.join("、") : "";
      db.agentLog({ agent: "detective", ok: true,
        summary: `线索面 ${r.rows} 条 → 提炼 ${r.distilled} → 追查 ${r.tried} → 官网收录 ${r.added}${brief}`,
        metrics: r, took_ms: Date.now() - t0 }).catch(() => {});
      process.stderr.write(`[自动发现] ${r.query} → 提炼${r.distilled} 追查${r.tried} 收录${r.added}\n`);
    } catch (e) {
      db.agentLog({ agent: "detective", ok: false, summary: "发现失败:" + String(e.message || e).slice(0, 120), took_ms: Date.now() - t0 }).catch(() => {});
    } finally { ldRunning = false; }
  }
  setTimeout(leadsRun, 300 * 1000);
  setInterval(leadsRun, 3600 * 1000);
  process.stderr.write("[自动发现] 已开启:每日北京时间 " + Number(process.env.DISCOVER_HOUR || 5) + " 点社媒线索一勘(只取线索身份,官网管线收录)\n");
}

// —— 反馈/举报处理 agent「信箱」(v0.83.0,路线图第 15 项)——
// 每日北京 FEEDBACK_HOUR(默认 6)点:新反馈 AI 初判(免费通道优先)+ 被举报内容处置建议 →
// state/feedback-report.json 供 /admin「反馈信箱」;开关 FEEDBACK_AGENT=1。
if (process.env.FEEDBACK_AGENT === "1") {
  let fbDay = null, fbRunning = false;
  async function feedbackRun() {
    const bj = new Date(Date.now() + 8 * 3600e3);
    if (bj.getUTCHours() !== Number(process.env.FEEDBACK_HOUR || 6)) return;
    const day = bj.toISOString().slice(0, 10);
    if (fbDay === day || fbRunning) return;
    fbDay = day; fbRunning = true;
    try {
      const r = await feedbackAgentTick();
      db.agentLog({ agent: "mailbox", ok: true,
        summary: `新反馈 ${r.newCount} 待处理` + (r.aiOn ? `,初判 ${r.judged}(急 ${r.urgent})` : ",AI 不可用仅聚合") +
          `,被举报 评论${r.reported.comments}/作品${r.reported.works}`,
        metrics: r, took_ms: r.took_ms }).catch(() => {});
      process.stderr.write(`[信箱] 初判${r.judged} 急${r.urgent} 举报 c${r.reported.comments}/w${r.reported.works}\n`);
    } catch (e) {
      db.agentLog({ agent: "mailbox", ok: false, summary: "信箱巡检失败:" + String(e.message || e).slice(0, 120) }).catch(() => {});
    } finally { fbRunning = false; }
  }
  setTimeout(feedbackRun, 240 * 1000);
  setInterval(feedbackRun, 3600 * 1000);
  process.stderr.write("[信箱] 已开启:每日北京时间 " + Number(process.env.FEEDBACK_HOUR || 6) + " 点反馈初判+举报聚合\n");
}

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  // 管理后台页面(不在 site/ 公开目录里,由这里单独路由;页面数据全靠带管理 cookie 的 API)
  if (u.pathname === "/admin" && req.method === "GET") {
    try {
      const body = await readFile(join(__dir, "admin.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(body);
    } catch (e) { res.writeHead(404); return res.end("not found"); }
  }
  // —— 画室点评工具(独立 Python 服务,127.0.0.1:8791)反代到 /studio —— 私密:处理学生作品,仅授权用户可用。
  //    STUDIO_OWNERS(.env,逗号分隔 uid)设了就只放行这些人 + 管理员;没设则任何登录用户(先本人用,拿到 uid 再收紧)。
  if (u.pathname === "/studio") { res.writeHead(302, { Location: "/studio/" }); return res.end(); }
  if (u.pathname.startsWith("/studio/")) {
    const me = auth.userOf(req);
    // 访问控制(v0.92.0):默认关,只放行名册里被勾选授权的用户(前端隐藏链接不算安全,这里才是闸)。
    // 不用 isAdmin OR —— 管理会话 cookie 是浏览器级的,会误放行"名册未勾选"的账号(后台显示没开却仍能打开)。
    const ok = me && auth.studioEnabled(me.id);
    if (!ok) {
      res.writeHead(me ? 403 : 401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end('<meta charset="utf-8"><body style="font-family:sans-serif;padding:44px;text-align:center;color:#333"><h3>画室点评工具</h3><p>' + (me ? "你没有使用权限。" : "请先登录后再使用。") + '</p><a href="/">返回首页</a></body>');
    }
    const target = u.pathname.replace(/^\/studio/, "") + (u.search || "");
    // 按用户隔离(2026-07-20 修多租户 bug):把已鉴权的 ArtPortal uid 作可信头注入,画室后端据此
    // 给花名册/抬头/作业各存一份、互不可见。必须先剥离客户端自带的同名头,防伪造他人身份。
    const fwd = { ...req.headers, host: "127.0.0.1:8791" };
    delete fwd["x-studio-uid"];
    fwd["X-Studio-Uid"] = me.id;
    const pr = httpRequest({ host: "127.0.0.1", port: 8791, method: req.method, path: target,
      headers: fwd }, (resp) => {
      res.writeHead(resp.statusCode || 502, resp.headers); resp.pipe(res);
    });
    pr.on("error", () => { if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }); res.end("画室服务未启动"); });
    req.pipe(pr);
    return;
  }
  if (u.pathname.startsWith("/api/auth/") || u.pathname === "/api/track" || u.pathname.startsWith("/api/favorites") || u.pathname.startsWith("/api/summary") || u.pathname === "/api/submit" || u.pathname === "/api/follow" || u.pathname === "/api/block" || u.pathname === "/api/works" || u.pathname.startsWith("/api/works/") || u.pathname === "/api/comments" || u.pathname.startsWith("/api/comments/") || u.pathname === "/api/feedback" || u.pathname === "/api/geo" || u.pathname === "/api/notifications" || u.pathname.startsWith("/api/notifications/") || u.pathname.startsWith("/api/admin/") || u.pathname.startsWith("/api/users/")) {
    return handleAuthApi(req, res, u);
  }
  // Agent 打卡(v0.72.0 巡视台):本机管道脚本干完活上报;AGENT_KEY 鉴权(sha256 恒时比较)
  if (u.pathname === "/api/agent/report" && req.method === "POST") {
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
    try {
      const b = await readBody(req);
      const expect = process.env.AGENT_KEY;
      const ha = createHash("sha256").update(String(b.key || "")).digest();
      const hb = createHash("sha256").update(String(expect || "")).digest();
      if (!expect || !timingSafeEqual(ha, hb)) return json(401, { error: "unauthorized" });
      await db.agentLog({ agent: String(b.agent || "unknown"), ok: b.ok !== false, summary: b.summary, metrics: b.metrics, took_ms: b.took_ms });
      return json(200, { ok: true });
    } catch (e) { return json(400, { error: "bad request" }); }
  }
  // 周报退订:邮件里的链接,点开即退订(无需登录;token=HMAC 防伪造)
  if (u.pathname === "/api/newsletter/unsub" && req.method === "GET") {
    let email = "";
    try { email = Buffer.from(String(u.searchParams.get("e") || ""), "base64url").toString("utf8"); } catch (e) {}
    const ok = auth.newsletterUnsub(email, u.searchParams.get("t") || "");
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>ArtPortal</title>' +
      '<body style="font-family:-apple-system,\'PingFang SC\',sans-serif;background:#f7f6f2;color:#1b1a18;display:flex;min-height:90vh;align-items:center;justify-content:center">' +
      '<div style="text-align:center;padding:24px"><div style="letter-spacing:.14em;font-size:12px;color:#8a847c">ARTPORTAL</div>' +
      (ok ? "<h1 style='font-size:20px'>已退订艺术周报</h1><p style='color:#6b6660;font-size:14px'>不会再给这个邮箱发周报了。想恢复,登录后在「编辑资料」里重新勾选即可。</p>"
          : "<h1 style='font-size:20px'>链接无效</h1><p style='color:#6b6660;font-size:14px'>退订链接不完整或已失效。可登录 ArtPortal,在「编辑资料」里关闭订阅。</p>") +
      '<p><a href="' + SITE_URL + '" style="color:#1b1a18">返回 ArtPortal</a></p></div>'
    );
  }
  if (u.pathname === "/api/search") {
    const q = (u.searchParams.get("q") || "").trim();
    // 频道参数:opportunities(默认)| news | jobs —— 三频道完全同规格的检索闭环
    const channel = (u.searchParams.get("channel") || "opportunities").trim();
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
    if (!q) return json(400, { error: "empty query" });
    if (channel !== "opportunities" && !CHANNELS[channel]) return json(400, { error: "bad channel" });
    const ql = channel + ":" + q.toLowerCase();   // 同词去重按"频道+词",资讯和机会各查各的
    const ip = ipOf(req);
    if (rateLimited(ip)) return json(429, { error: "rate", message: "检索太频繁了,请过一会儿再试" });
    // 同词 8 分钟内已检索过、或正在检索中 → 直接返回,不重复全网跑(结果已/即将在库)
    if (recentlyDone(ql) || inFlight.has(ql)) return json(200, { query: q, channel, added: [], addedCount: 0, cached: true, message: "「" + q + "」刚刚检索过,结果已在库,下拉列表即可看到" });
    inFlight.add(ql);
    const t0 = Date.now();
    await acquireSlot();                       // 超并发上限则在此排队等待(不拒绝)
    try {
      const user = auth.userOf(req);
      auth.logEvent("search", { q: q.slice(0, 80), channel, ip, ...(user ? { uid: user.id, email: user.email } : {}) });
      const r = channel === "opportunities" ? await searchAndHarvest(q, 6, null, "user") : await harvestChannel(channel, q, 6, "user");
      // 检索入库溯源:每条新入库记录记下"谁的哪次检索带进来的"(后台可查)
      for (const rec of r.added) {
        db.ingestInsert({ channel, record_id: rec.id, title: rec.title_zh || rec.title, q: q.slice(0, 80), uid: user ? user.id : null, email: user ? user.email : null, ip });
      }
      recentQ.set(ql, Date.now());             // 成功才进短时缓存
      json(200, { query: q, channel, added: r.added, addedCount: r.added.length, probed: r.probed, candidates: r.candidates, ms: Date.now() - t0 });
      process.stderr.write(`[检索·${channel}] "${q}" ← ${ip} · 并发${running} → 探测${r.probed}/${r.candidates} 入库${r.added.length} (${Date.now() - t0}ms)\n`);
    } catch (e) {
      json(500, { error: String(e.message || e) });
    } finally { releaseSlot(); inFlight.delete(ql); }
    return;
  }
  return serveStatic(req, res);
}).listen(PORT, () => process.stderr.write(`ArtPortal 服务启动:http://localhost:${PORT}  (静态站 + /api/search + 账号/后台)\n`));
