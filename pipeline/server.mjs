// server.mjs —— 本地一体化服务:①托管静态站(site/) ②提供"按需 AI 检索"接口 /api/search
//
// 「搜索即检索」闭环(严守反幻觉红线,与每日管道同一套校验):
//   用户搜关键词 → DuckDuckGo 找相关官网页 → 抓官网原文 → DeepSeek 提取+逐字 evidence
//   → verify.mjs 程序校验 evidence 是原文子串 → 只有真实、校验通过的才写入 opportunities.json
// 数量尽力(默认目标 6),真实优先:某词真实只找到 3 条就是 3 条,绝不编造凑数。
//
// 启动:  set -a && . ./.env && set +a && node server.mjs   (需 DEEPSEEK_API_KEY)
// 搜索环节用 DDG lite(免密钥);上线到大陆生产环境时可换成正规搜索 API(见 README)。

import { createServer } from "node:http";
import { readFile, writeFile, stat, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, sep } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";
import { extract, llmExtract } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import * as auth from "./lib/auth.mjs";
import { isThirdParty } from "./lib/aggregators.mjs";
import { searchWeb, BLOCK, unsafeHost } from "./lib/websearch.mjs";
import { CHANNELS, harvestChannel } from "./lib/channels.mjs";
import { saveFulltext } from "./lib/fulltext.mjs";

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
  return /(\.edu\.cn|\.gov\.cn|\.gov|\.org\.cn|\.ac\.cn|\.museum)$/i.test(String(host)) ? 1 : 0;
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
  process.stderr.write("  [意图] 地点=" + (loc || "—") + " 领域=" + ((intent && intent.subject) || "—") + "\n");
  const OFFICIAL_SITES = "(site:edu.cn OR site:org.cn OR site:gov.cn OR site:ac.cn OR site:museum OR site:org.hk OR site:gov.tw OR site:org.tw)";
  const baseQ = (intent && Array.isArray(intent.search_queries) && intent.search_queries.length)
    ? intent.search_queries.slice(0, 3).map(String)
    : [query + " 艺术 驻留 征集 报名", query + " 展览 征集 大赛 奖 官网", query + " art residency open call apply"];
  const queries = [(baseQ[0] || query) + " " + OFFICIAL_SITES].concat(baseQ);   // ① 官网限定 + ②③④ 意图查询
  const rawUrls = [];
  for (const q of queries) {
    rawUrls.push(...await searchWeb(q));
    await new Promise(r => setTimeout(r, 800)); // 对搜索端点客气一点
  }
  // 候选去重 + 过滤噪声
  const seen = new Set(), cands = [];
  for (const u of rawUrls) {
    let host; try { host = new URL(u).host; } catch (e) { continue; }
    if (BLOCK.test(u) || isThirdParty(u) || unsafeHost(host)) continue;   // 第三方聚合/门户不采;裸IP/内网host不抓(SSRF闸)
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
    if (loc && !matchLocation(rec, loc)) { log.push("跑题(不含 " + loc + ") " + host); continue; }   // 地点相关性过滤
    if (existIds.has(rec.id) || added.find(a => a.id === rec.id)) continue;
    // 官网原文存档:精简成 summary 之前的正文存成静态文件,前端"详情"秒开
    const ft = await saveFulltext(rec.id, f.text);
    if (ft) rec.fulltext = ft;
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
    "  location: 用户明确提到的地点/城市/地区(如 大理、上海、香港),没提就 null。\n" +
    "  subject: 核心领域或形式(如 摄影、版画、驻留、雕塑),没提就 null。\n" +
    "  search_queries: 2-3 条适合直接丢给搜索引擎的精准查询,每条都把地点/领域和机会类型词(征集/驻留/报名/申请/open call)组合好;以中文为主,可含 1 条英文覆盖国际。\n" +
    '例 "大理" -> {"location":"大理","subject":null,"search_queries":["大理 艺术 驻留 征集 报名","大理 展览 征集 美术馆 艺术中心 官网","Dali Yunnan art residency open call"]}\n' +
    '例 "面向青年的免费版画奖" -> {"location":null,"subject":"版画","search_queries":["版画 奖 青年 征集 报名","青年 版画 大赛 征稿 申请","printmaking award young artists open call"]}';
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.EXTRACT_MODEL || "deepseek-chat",
        temperature: 0.2, max_tokens: 400, response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: "用户需求:" + userQuery }]
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    const m = /\{[\s\S]*\}/.exec(raw);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return null; }
}
// 相关性把关:机会文本是否包含用户明确指定的地点(硬约束);不含则判为跑题、丢弃。
function matchLocation(rec, loc) {
  if (!loc) return true;
  const hay = (rec.title_zh || "") + (rec.title_en || "") + (rec.city_zh || "") + (rec.country_zh || "") + (rec.org_zh || "") + (rec.summary_zh || "");
  return hay.indexOf(loc) !== -1;
}

// —— 官网内容速览(机器翻译辅助阅读):按需抓收录的官网页面 → DeepSeek 忠实翻译 → 站内面板展示 ——
// 诚实与版权边界:只做"辅助阅读",正文限长截取,面板固定标注"机器翻译·以官网原文为准",
// 主按钮仍是"前往官网";绝不替代官网、不索引、不当作本站内容二次分发。
// 安全边界:URL 必须是本站数据里收录的链接(官网/资讯原文/招聘申请页)——不做开放代理。
const TRANS_CACHE_FILE = join(__dir, "state", "pagetrans.json");
const TRANS_TTL = 7 * 24 * 3600 * 1000;      // 同页译文缓存 7 天(控 API 费)
const TRANS_NEG_TTL = 10 * 60 * 1000;        // 失败负缓存 10 分钟(防对稳定失败页反复烧钱)
const TRANS_MAX = 2000;                       // 缓存条数上限(须大于 收录URL数×2语种,否则扫一遍即击穿)
let transCache = null;
async function loadTransCache() {
  if (!transCache) { try { transCache = JSON.parse(await readFile(TRANS_CACHE_FILE, "utf8")); } catch (e) { transCache = {}; } }
  return transCache;
}
// 白名单:三个数据文件里出现过的外链(60 秒缓存,避免每请求重读三份 JSON)
let knownUrls = { at: 0, set: new Set() };
async function isKnownUrl(u) {
  if (Date.now() - knownUrls.at > 60000) {
    const set = new Set();
    try { const d = JSON.parse(await readFile(DATA, "utf8")); for (const o of d.opportunities || []) { if (o.url) set.add(o.url); if (o.official_url) set.add(o.official_url); } } catch (e) {}
    try { const d = JSON.parse(await readFile(join(SITE, "data", "news.json"), "utf8")); for (const o of d.items || []) if (o.url) set.add(o.url); } catch (e) {}
    try { const d = JSON.parse(await readFile(join(SITE, "data", "jobs.json"), "utf8")); for (const o of d.jobs || []) if (o.apply_url) set.add(o.apply_url); } catch (e) {}
    knownUrls = { at: Date.now(), set };
  }
  return knownUrls.set.has(u);
}
// 翻译接口独立限频(6 次/分),与检索限频分开计
const transHits = new Map();
function transLimited(ip) {
  const now = Date.now();
  const arr = (transHits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 6) { transHits.set(ip, arr); return true; }
  arr.push(now); transHits.set(ip, arr);
  return false;
}
const transInFlight = new Map();              // url+to -> Promise(同页并发请求只翻一次)
// 翻译独立小信号量(3 并发,排队上限 50):绝不与检索抢 12 个大并发槽,
// 否则廉价的翻译 GET 能把正在等 170 秒的检索用户饿死(评审 MEDIUM)。
const TRANS_CONC = 3, TRANS_QUEUE_MAX = 50;
let transRunning = 0;
const transWaiters = [];
function acquireTransSlot() {
  if (transRunning < TRANS_CONC) { transRunning++; return Promise.resolve(); }
  if (transWaiters.length >= TRANS_QUEUE_MAX) return null;   // 队伍太长直接请客稍候
  return new Promise(r => transWaiters.push(r));
}
function releaseTransSlot() {
  if (transWaiters.length) transWaiters.shift()();
  else transRunning--;
}
function persistTransCache(cache) {
  const keys = Object.keys(cache);
  if (keys.length > TRANS_MAX) {
    keys.sort((a, b) => cache[a].at - cache[b].at);
    for (const k of keys.slice(0, keys.length - TRANS_MAX)) delete cache[k];
  }
  // 原子写(tmp+rename):直接覆盖写在进程中断时会把缓存文件截成非法 JSON,下次全量丢失
  const tmp = TRANS_CACHE_FILE + ".tmp-" + process.pid + "-" + Date.now();
  withWriteLock(async () => {
    await writeFile(tmp, JSON.stringify(cache), "utf8");
    await rename(tmp, TRANS_CACHE_FILE);
  }).catch(() => {});
}
async function translatePage(url, to) {
  const cache = await loadTransCache();
  const key = to + "\n" + url;
  const hit = cache[key];
  if (hit && hit.neg && Date.now() - hit.at < TRANS_NEG_TTL) throw new Error(hit.fail || "速览失败,请稍后再试");
  if (hit && !hit.neg && Date.now() - hit.at < TRANS_TTL) { hit.at = Date.now(); return { ...hit, cached: true }; }
  try {
    let host; try { host = new URL(url).host; } catch (e) { throw new Error("bad url"); }
    if (unsafeHost(host)) throw new Error("该页面不支持速览");
    const f = await fetchSource({ url, domain: host, type: "html" });
    // SSRF 防线:fetchSource 跟随重定向,落点若是内网/裸 IP,内容绝不能进面板(评审 MEDIUM)
    if (f.finalUrl) {
      let fh; try { fh = new URL(f.finalUrl).host; } catch (e) { fh = ""; }
      if (!fh || unsafeHost(fh)) throw new Error("该页面不支持速览");
    }
    if (f.skipped || !f.text || f.text.length < 100) throw new Error("官网页面暂时抓取不到(" + (f.reason || "内容过少") + "),请直接打开官网");
    // raw 模式:原文直出,不调 LLM(老数据没有 fulltext 存档时的"详情"兜底,秒级、零 API 费)
    if (to === "raw") {
      const entry = { title: "", text: f.text.slice(0, 12000), truncated: f.text.length > 12000, at: Date.now() };
      cache[key] = entry;
      persistTransCache(cache);
      return { ...entry, cached: false };
    }
    const raw = f.text.slice(0, 7000);
    const truncated = f.text.length > 7000;
    const sys = "你是忠实的网页翻译器。把用户给的【网页正文】翻译成" + (to === "en" ? "英文" : "简体中文") +
      "。只翻译,绝不增删信息、不解释、不评论、不补全;保留段落结构(段落间用 \\n 分隔);" +
      "数字、日期、金额、邮箱、URL、专有名词原文照抄。若正文本身已是目标语言,原样整理返回。" +
      '只输出一个 JSON:{"title":"页面标题的译文","text":"正文译文"}';
    let r;
    try { r = await llmExtract(sys, "【网页正文】\n\n" + raw, 4000); }
    catch (e) {
      // 不把 DeepSeek 原始报错(可能含响应体)透传给访客
      process.stderr.write("[pagetrans] LLM 失败: " + (e.message || e) + "\n");
      throw new Error("翻译服务暂时不可用,请稍后再试");
    }
    const title = typeof r.data.title === "string" ? r.data.title.slice(0, 200) : "";
    const text = typeof r.data.text === "string" ? r.data.text.slice(0, 12000) : "";
    if (!text.trim()) throw new Error("翻译失败,请稍后再试");
    const entry = { title, text, truncated, at: Date.now() };
    cache[key] = entry;
    persistTransCache(cache);
    return { ...entry, cached: false };
  } catch (e) {
    // 失败负缓存:同页 10 分钟内不再反复 fetch+LLM(评审 LOW)
    cache[key] = { neg: true, fail: String(e.message || e).slice(0, 200), at: Date.now() };
    persistTransCache(cache);
    throw e;
  }
}

// —— 静态文件服务 ——
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".webp": "image/webp" };
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

// 请求体读取(JSON,限 256KB,防大包;收藏最多 2000 条约 100–120KB,留足余量)
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 262144) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
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

// —— 账号 / 统计 / 管理后台 API(实现见 lib/auth.mjs)——
async function handleAuthApi(req, res, u) {
  const json = r => { res.writeHead(r.code, { "Content-Type": "application/json; charset=utf-8", ...(r.headers || {}) }); res.end(JSON.stringify(r.body)); };
  const ip = ipOf(req);
  const p = u.pathname, m = req.method;
  try {
    if (p === "/api/auth/me" && m === "GET") return json(auth.me(req));
    if (p === "/api/auth/register" && m === "POST") { const b = await readBody(req); return json(auth.register(b.email, b.password, ip)); }
    if (p === "/api/auth/login" && m === "POST") { const b = await readBody(req); return json(auth.login(b.email, b.password, ip)); }
    if (p === "/api/auth/logout" && m === "POST") return json(auth.logout(req));
    if (p === "/api/favorites" && m === "POST") { const b = await readBody(req); return json(auth.setFavorites(req, b.ids)); }
    if (p === "/api/track" && m === "POST") { const b = await readBody(req); return json(auth.track(req, b, ip)); }
    if (p === "/api/admin/login" && m === "POST") { const b = await readBody(req); return json(auth.adminLogin(b.password, ip)); }
    if (p === "/api/admin/overview" && m === "GET") return json(auth.isAdmin(req, ip) ? await auth.adminOverview() : { code: 401, body: { error: "unauthorized" } });
    if (p === "/api/admin/users" && m === "GET") return json(auth.isAdmin(req, ip) ? auth.adminUsers() : { code: 401, body: { error: "unauthorized" } });
  } catch (e) {
    return json({ code: 400, body: { error: "请求格式不正确" } });
  }
  return json({ code: 404, body: { error: "not found" } });
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
  if (u.pathname.startsWith("/api/auth/") || u.pathname === "/api/track" || u.pathname === "/api/favorites" || u.pathname.startsWith("/api/admin/")) {
    return handleAuthApi(req, res, u);
  }
  if (u.pathname === "/api/pagetrans") {
    const url = (u.searchParams.get("url") || "").trim();
    const toRaw = (u.searchParams.get("to") || "zh");
    const to = ["zh", "en", "raw"].includes(toRaw) ? toRaw : "zh";
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(obj)); };
    if (!/^https?:\/\//i.test(url)) return json(400, { error: "bad url" });
    const ip = ipOf(req);
    if (transLimited(ip)) return json(429, { error: "rate", message: "操作太频繁,请稍候再试" });
    if (!(await isKnownUrl(url))) return json(403, { error: "not allowed", message: "仅支持速览本站收录的官网页面" });
    const key = to + "\n" + url;
    const slot = acquireTransSlot();           // 翻译独立小并发池(3),不与检索抢槽
    if (!slot) return json(429, { error: "busy", message: "速览请求排队太多,请稍候再试" });
    await slot;
    try {
      let p = transInFlight.get(key);
      if (!p) {
        p = translatePage(url, to);
        transInFlight.set(key, p);
        // 关键:catch(()=>{}) 先把派生链接住,再 finally 清表。
        // 直接 p.finally(...) 会产生一条无人接住的派生 Promise,任何一次翻译失败
        // 都会以 unhandledRejection 击杀整个进程(评审 HIGH,已复现)。
        p.catch(() => {}).finally(() => transInFlight.delete(key));
      }
      const r = await p;
      json(200, { url, to, title: r.title, text: r.text, truncated: !!r.truncated, cached: !!r.cached });
    } catch (e) {
      json(500, { error: "trans", message: String(e.message || e).slice(0, 200) });
    } finally { releaseTransSlot(); }
    return;
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
