// server.mjs —— 本地一体化服务:①托管静态站(site/) ②提供"按需 AI 检索"接口 /api/search
//
// 「搜索即检索」闭环(严守反幻觉红线,与每日管道同一套校验):
//   用户搜关键词 → DuckDuckGo 找相关官网页 → 抓官网原文 → DeepSeek 提取+逐字 evidence
//   → verify.mjs 程序校验 evidence 是原文子串 → 只有真实、校验通过的才写入 opportunities.json
// 数量尽力(默认目标 6),真实优先:某词真实只找到 3 条就是 3 条,绝不编造凑数。
//
// 启动:  set -a && . ./.env && set +a && node server.mjs   (需 DEEPSEEK_API_KEY)
// 搜索环节用 DDG lite(免密钥);上线到大陆生产环境时可换成正规搜索 API(见 README)。

import { createServer, request as httpRequest } from "node:http";
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
import { searchWeb, BLOCK, unsafeHost, serperBudgetLeft } from "./lib/websearch.mjs";
import { CHANNELS, harvestChannel } from "./lib/channels.mjs";
import { inspectChannel } from "./lib/qc.mjs";
import { moderateText } from "./lib/moderation.mjs";
import * as db from "./lib/db.mjs";
import { generateWeekly, readWeekly, readWeeklyIndex, weekIdOf, renderEmailHtml, renderEmailText, generatePersonalSummary } from "./lib/weekly.mjs";
import { mailerOn, sendMail } from "./lib/mailer.mjs";

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
// 2) 并发信号量:同时进行的检索上限;超出的"排队等待"(不是拒绝)。检索大多在等网络IO,故上限可较高。
const MAX_CONCURRENT = 12;
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
const ipHits = new Map();                    // ip -> [时间戳...]
const IP_WINDOW = 60 * 1000, IP_MAX = 4;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < IP_WINDOW);
  if (arr.length >= IP_MAX) { ipHits.set(ip, arr); return true; }
  arr.push(now); ipHits.set(ip, arr);
  return false;
}

async function searchAndHarvest(query, target = 6) {
  // AI 理解需求 → 结构化意图(地点/领域 + 精准查询);理解失败退回关键词模板。
  const intent = await understandQuery(query);
  const loc = intent && intent.location ? String(intent.location).trim() : null;
  // 地点的中英文/别名数组(供相关性匹配,防"洛杉矶"匹配不到"Los Angeles");无则回退单地点
  const locTerms = (intent && Array.isArray(intent.location_terms) && intent.location_terms.length)
    ? intent.location_terms.map(s => String(s).trim()).filter(Boolean) : (loc ? [loc] : []);
  // 检索地域/语言(2026-07-20):国际地点用 gl=us/hl=en,否则默认中国区中文——否则国际站被 Google 严重降权
  const gl = (intent && intent.gl) ? String(intent.gl).toLowerCase() : "cn";
  const hl = (intent && intent.hl) ? String(intent.hl) : "zh-cn";
  const cnRegion = /^(cn|hk|tw|mo)$/.test(gl);
  process.stderr.write("  [意图] 地点=" + (loc || "—") + " 领域=" + ((intent && intent.subject) || "—") + " 区域=" + gl + "\n");
  // 官网限定查询按区域自适应:中国/港澳台用 .cn/.hk/.tw 官方后缀;国际用 .org/.edu/.gov/.museum/.ac.uk
  const OFFICIAL_SITES = cnRegion
    ? "(site:edu.cn OR site:org.cn OR site:gov.cn OR site:ac.cn OR site:museum OR site:org.hk OR site:gov.tw OR site:org.tw)"
    : "(site:.org OR site:.edu OR site:.gov OR site:.museum OR site:.ac.uk OR site:.org.uk)";
  const baseQ = (intent && Array.isArray(intent.search_queries) && intent.search_queries.length)
    ? intent.search_queries.slice(0, 3).map(String)
    : [query + " 艺术 驻留 征集 报名", query + " 展览 征集 大赛 奖 官网", query + " art residency open call apply"];
  const queries = [(baseQ[0] || query) + " " + OFFICIAL_SITES].concat(baseQ);   // ① 官网限定 + ②③④ 意图查询
  const rawUrls = [];
  for (const q of queries) {
    rawUrls.push(...await searchWeb(q, { gl, hl }));
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
  const existUrls = new Set(doc.opportunities.map(o => o.url));

  const added = [], log = [];
  let probed = 0;
  const MAX_PROBE = 16;                          // 最多探测这么多候选,控制耗时
  const t0 = Date.now();
  const BUDGET = 110000;                         // 总检索时间预算:超 110 秒就返回已收集的,别让请求无限跑
  for (const url of cands) {
    if (added.length >= target || probed >= MAX_PROBE) break;
    if (Date.now() - t0 > BUDGET) { log.push("time-budget-reached"); break; }
    if (existUrls.has(url)) continue;
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
      const urls = new Set(cur.opportunities.map(o => o.url));
      const fresh = added.filter(o => !ids.has(o.id) && !urls.has(o.url));  // 并发下再去一次重
      if (fresh.length) {
        cur.opportunities.push(...fresh);
        cur.count = cur.opportunities.length;
        await writeFile(DATA, JSON.stringify(cur, null, 2), "utf8");
      }
      return fresh;
    });
  }
  return { added: saved, probed, candidates: cands.length, log };
}

function finalize(rec, url, host) {
  const dom = host.replace(/^www\./, "");
  const id = "search-" + dom.split(".")[0] + "-" + slug(rec.title_zh || rec.title_en || "item");
  const today = todayISO();
  return {
    id,
    category: rec.category || "opencall",
    title_zh: rec.title_zh || null, title_en: rec.title_en || null,
    org_zh: rec.org_zh || null, city_zh: rec.city_zh || null, country_zh: rec.country_zh || null,
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
    verified_at: null, last_seen: today, updated_at: today, _via: "search"
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
      if (!res.ok) { if (res.status === 429 || res.status >= 500) { await sleep(600 * (attempt + 1)); continue; } return null; }
      const j = await res.json();
      const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      const m = /\{[\s\S]*\}/.exec(raw);
      if (m) { try { return JSON.parse(m[0]); } catch (e) { /* 解析失败→重试 */ } }
      await sleep(400);
    } catch (e) { await sleep(600 * (attempt + 1)); }   // 超时/网络错→退避重试
  }
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
    const body = await readFile(full);
    // HTML 绝不缓存(每次拿最新,带上最新的 ?v= 资源引用);其余交给 ?v= 版本号控缓存
    const isHtml = extname(full) === ".html" || p === "/index.html";
    res.writeHead(200, { "Content-Type": MIME[extname(full)] || "application/octet-stream", "Cache-Control": isHtml ? "no-store, no-cache, must-revalidate" : "no-cache" });
    res.end(body);
  } catch (e) { res.writeHead(404); res.end("not found"); }
}

// 请求体读取(JSON,默认限 256KB;投稿带压缩封面 base64 时调用方放宽到 ~900KB)
function readBody(req, max = 262144) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > max) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}
// 客户端 IP:默认只信 socket 真实地址(当前 IP 直连、无反代,X-Forwarded-For 可被任意伪造,
// 若信它则所有限频形同虚设)。以后套 nginx 反代时设 TRUST_PROXY=1 才改用 XFF 首值。
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ipOf = req => {
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) return String(req.headers["x-forwarded-for"]).split(",")[0].trim();
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
    org_zh: p.org, city_zh: p.city, country_zh: p.country,
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
    last_seen: today, updated_at: today, _via: "submit"
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
          apply_url: p.url, url: p.url, domain: dom, posted_at: today, _via: "submit" }
      : { id: "submit-n" + row.id, title: p.title, title_zh: p.title, source: p.source,
          url: p.url, domain: dom, published_at: p.published_at || today,
          summary: p.summary, summary_zh: p.summary, added_at: today, _via: "submit" };
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
// 人工审核通过才搬进 site/assets/works/ 公开;拒绝即删文件。文字部分照常机审。
const WORKS_PENDING = join(__dir, "state", "works_pending");
const WORKS_PUB = join(SITE, "assets", "works");
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
// 作品举报限频(防刷):单 IP 每天 20 次
const reportHits = new Map();
function reportLimited(ip) {
  const now = Date.now();
  const arr = (reportHits.get(ip) || []).filter(t => now - t < 24 * 3600e3);
  if (arr.length >= 20) { reportHits.set(ip, arr); return true; }
  arr.push(now); reportHits.set(ip, arr);
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
      if (r.body && r.body.user) {   // 画室工具入口可见性:授权 uid 或管理员(STUDIO_OWNERS 未设时任何登录用户,先本人用)
        const owners = (process.env.STUDIO_OWNERS || "").split(",").map(s => s.trim()).filter(Boolean);
        r.body.user.studio = auth.isAdmin(req, ip) || owners.length === 0 || owners.includes(r.body.user.id);
      }
      return json(r);
    }
    if (p === "/api/auth/register" && m === "POST") { const b = await readBody(req); return json(await auth.register(b.email, b.password, b.code, ip, b.newsletter === true)); }
    if (p === "/api/auth/sendcode" && m === "POST") { const b = await readBody(req); return json(await auth.sendEmailCode(b, ip)); }
    if (p === "/api/auth/login" && m === "POST") { const b = await readBody(req); return json(auth.login(b.email, b.password, ip)); }
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
          uid: c.uid, author: byId.get(c.uid) || null
        })) } });
      } catch (e) { return json({ code: 503, body: { error: "暂不可用" } }); }
    }
    if (p === "/api/comments" && m === "POST") {
      const me = auth.userOf(req);
      if (!me) return json({ code: 401, body: { error: "请先登录再评论" } });
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
        const id = await db.insertComment({ kind, target, uid: me.id, email: me.email, parent, content, mod, status });
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
      const b = await readBody(req, 9 * 1024 * 1024);   // ≤9 张压缩图
      const v = validateWork(b);
      if (v.error) return json({ code: 400, body: { error: v.error } });
      try {
        if (!(await db.workRateOk(me.id))) return json({ code: 429, body: { error: "今天上传已达上限(3 组),明天再来" } });
        // 审核策略(2026-07-17 起):文字机审 pass → 自动通过、图片直接进公开目录即时发布;
        // review/reject → 图片留在非公开待审目录,交人工。后台全量可见,已发布的可"下架"。
        // (注:DeepSeek 只能审文字;图片内容靠 后台可见+举报+下架 兜底)
        const mod = await moderateText(v.data.title + "\n" + v.data.description, "work");
        const autoPass = mod.verdict === "pass";
        const id = await db.insertWork({ uid: me.id, email: me.email, title: v.data.title, description: v.data.description, tags: v.data.tags, mod });
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
        return json({ code: 200, body: { works: rows.map(w => ({
          id: w.id, uid: w.uid, title: w.title, description: w.description || "",
          created_at: w.created_at, n: w.images.length, tags: w.tags || [],
          images: w.images.map(n => "assets/works/" + n),
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
        return json({ code: 200, body: { works: rows.map(w => ({
          id: w.id, title: w.title, description: w.description || "",
          created_at: w.created_at, n: w.images.length, tags: w.tags || [],
          status: own ? w.status : "approved",
          images: w.status === "approved" ? w.images.map(n => "assets/works/" + n) : []
        })) } });
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
      try { return json({ code: 200, body: { list: await db.worksAdminList() } }); }
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
        if (w.status !== "pending") return json({ code: 400, body: { error: "该作品已裁决过" } });
        if (action === "approved") {
          await mkdir(WORKS_PUB, { recursive: true });
          for (const n of w.images) {
            if (!workFileRe.test(n)) continue;
            await rename(join(WORKS_PENDING, n), join(WORKS_PUB, n));   // 过审才进公开目录
          }
        } else {
          for (const n of w.images) {
            if (!workFileRe.test(n)) continue;
            await unlink(join(WORKS_PENDING, n)).catch(() => {});       // 拒绝即删文件
          }
        }
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
      const r = auth.adminSetBan(b.email, !!b.on);
      if (r.code === 200) await db.logModeration("user", String(b.email), b.on ? "banned" : "unbanned", null).catch(() => {});
      return json(r);
    }
    // —— 投稿:提交 / 后台队列 / 人工裁决 ——
    if (p === "/api/submit" && m === "POST") {
      const user = auth.userOf(req);
      if (!user) return json({ code: 401, body: { error: "请先登录后再投稿" } });
      const b = await readBody(req, 900 * 1024);   // 放宽:压缩封面 base64
      const v = validateSubmission(b);
      if (v.error) return json({ code: 400, body: { error: v.error } });
      try {
        if (!(await db.submissionRateOk(user.id))) return json({ code: 429, body: { error: "今天投稿已达上限(5 条),明天再来" } });
        const modText = [v.data.title, v.data.org, v.data.source, v.data.city, v.data.country, v.data.salary, v.data.summary, v.data.url, v.data.source_note].filter(Boolean).join("\n");
        const mod = await moderateText(modText);
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
        const brief = { serper_left: serperBudgetLeft(), disk_free_gb: null, today: {}, pending: 0 };
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
const nlState = { running: false, wid: null, done: 0, ok: 0, total: 0 };
async function sendWeeklyBulk(report) {
  const audience = auth.newsletterAudience();
  const sent = await db.nlSentSet(report.id);
  const targets = audience.filter(a => !sent.has(a.email));
  nlState.running = true; nlState.wid = report.id; nlState.done = 0; nlState.ok = 0; nlState.total = targets.length;
  process.stderr.write(`[周报] 群发开始 ${report.id}:订阅 ${audience.length},本轮待发 ${targets.length}\n`);
  for (const t of targets) {
    try {
      await sendWeeklyTo(report, t.email);
      await db.nlLogSend(report.id, t.email, true, null);
      nlState.ok++;
    } catch (e) {
      await db.nlLogSend(report.id, t.email, false, e.message);
      process.stderr.write(`[周报] 发送失败 ${t.email}: ${String(e.message || e).slice(0, 100)}\n`);
    }
    nlState.done++;
    await new Promise(r => setTimeout(r, 3000));   // 逐封限速:对 SMTP 服务商客气,防触发风控
  }
  process.stderr.write(`[周报] 群发结束 ${report.id}:成功 ${nlState.ok}/${nlState.total}\n`);
  db.agentLog({ agent: "postman", ok: nlState.ok === nlState.total, summary: `群发 ${report.id}:成功 ${nlState.ok}/${nlState.total}`, metrics: { wid: report.id, ok: nlState.ok, total: nlState.total } }).catch(() => {});
  nlState.running = false;
}
// 每周自动出刊:.env 设 WEEKLY_REPORT=1 开启 —— 每小时看一眼,北京时间周一 9 点后本周还没出就生成;
// 生成后若 NEWSLETTER_AUTO=1 且群发闸(NEWSLETTER_BULK=1)已开、发信已配置,则自动群发(备案后的全自动形态)。
if (process.env.WEEKLY_REPORT === "1") {
  async function weeklyTick() {
    try {
      const bj = new Date(Date.now() + 8 * 3600e3);
      if (bj.getUTCDay() !== 1 || bj.getUTCHours() < 9) return;    // 北京时间周一 9 点后
      if (await readWeekly(weekIdOf())) return;                    // 本周已出刊
      const r = await generateWeekly({});
      if (!r.report) return;
      process.stderr.write(`[周报] 已生成 ${r.report.id}「${r.report.title}」(AI=${r.report.ai_composed})\n`);
      db.agentLog({ agent: "eli", ok: true, summary: `出刊 ${r.report.id}「${r.report.title}」`, metrics: { id: r.report.id, format: r.report.format || 1, refs: (r.report.references || []).length, en: !!r.report.en } }).catch(() => {});
      if (!r.existed) notifyWeeklyPublished(r.report);   // 站内通知全体用户:新周刊出刊
      if (process.env.NEWSLETTER_AUTO === "1" && process.env.NEWSLETTER_BULK === "1" && mailerOn() && !nlState.running) {
        sendWeeklyBulk(r.report);
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
    "商业画廊 青年艺术家 计划 征集", "艺术基金会 资助 扶持 计划 申请", "高校 研究生 毕业 创作 征集展"
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
async function autoHarvestTick() {
  if (process.env.SERPER_API_KEY && serperBudgetLeft() < 6) {
    process.stderr.write("[自动检索] 今日搜索预算余量不足,本轮让路(优先保用户手动检索)\n");
    db.agentLog({ agent: "scout", ok: true, summary: "预算余量不足,本轮让路(保用户手动检索)", metrics: { skipped: true } }).catch(() => {});
    return;
  }
  const ch = AUTO_ROTATION[autoTickN++ % AUTO_ROTATION.length];
  const pool = AUTO_QUERIES[ch];
  const q = pool[Math.floor(Math.random() * pool.length)];   // 随机取词:长期均匀覆盖词池,无需持久化游标
  try {
    await acquireSlot();                       // 和用户检索共用并发闸,互不挤占
    try {
      const t0 = Date.now();
      const r = ch === "opportunities" ? await searchAndHarvest(q, 6) : await harvestChannel(ch, q, 6);
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
if (process.env.AUTO_HARVEST === "1") {
  const mins = Math.max(10, Number(process.env.AUTO_HARVEST_MINUTES || 480));   // 默认 8 小时一轮(省额);下限 10 分钟防手滑
  const boot = Math.max(5, Number(process.env.AUTO_HARVEST_BOOT || 180));
  setTimeout(autoHarvestTick, boot * 1000);
  setInterval(autoHarvestTick, mins * 60 * 1000);
  process.stderr.write(`[自动检索] 已开启:每 ${mins} 分钟检索一个频道(机会→资讯→机会→招聘 轮转;首轮 ${boot} 秒后)\n`);
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
    let tail = "";
    const p = spawn(process.execPath, [join(__dir, "run.mjs"), "--cap", cap], { cwd: __dir, env: process.env });
    p.stdout.on("data", d => { tail = (tail + d).slice(-1000); });
    p.stderr.on("data", d => { tail = (tail + d).slice(-1000); });
    p.on("close", (code) => {
      dcRunning = false;
      process.stderr.write("[每日抓取] run.mjs 结束 code=" + code + " 用时 " + Math.round((Date.now() - t0) / 1000) + "s\n");
      db.agentLog({ agent: "harvester", ok: code === 0, summary: "服务器每日抓取 run.mjs(code=" + code + "):" + tail.replace(/\s+/g, " ").slice(-150), took_ms: Date.now() - t0 }).catch(() => {});
    });
    p.on("error", (e) => { dcRunning = false; process.stderr.write("[每日抓取] spawn 失败:" + e.message + "\n"); });
  }
  setTimeout(dailyCrawlTick, 200 * 1000);
  setInterval(dailyCrawlTick, 3600 * 1000);
  process.stderr.write("[每日抓取] 已开启:每日北京时间 " + Number(process.env.DAILY_CRAWL_HOUR || 3) + " 点抓 sources.json 全部信源(run.mjs,并发安全)\n");
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
    const owners = (process.env.STUDIO_OWNERS || "").split(",").map(s => s.trim()).filter(Boolean);
    const ok = me && (auth.isAdmin(req, ipOf(req)) || owners.length === 0 || owners.includes(me.id));
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
  if (u.pathname.startsWith("/api/auth/") || u.pathname === "/api/track" || u.pathname.startsWith("/api/favorites") || u.pathname.startsWith("/api/summary") || u.pathname === "/api/submit" || u.pathname === "/api/follow" || u.pathname === "/api/block" || u.pathname === "/api/works" || u.pathname.startsWith("/api/works/") || u.pathname === "/api/comments" || u.pathname.startsWith("/api/comments/") || u.pathname === "/api/notifications" || u.pathname.startsWith("/api/notifications/") || u.pathname.startsWith("/api/admin/") || u.pathname.startsWith("/api/users/")) {
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
      const r = channel === "opportunities" ? await searchAndHarvest(q, 6) : await harvestChannel(channel, q, 6);
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
