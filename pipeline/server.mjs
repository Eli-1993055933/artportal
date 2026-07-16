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
import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize, sep } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";
import { extract } from "./lib/extract.mjs";
import { verifyRecord } from "./lib/verify.mjs";
import * as auth from "./lib/auth.mjs";
import { isThirdParty } from "./lib/aggregators.mjs";
import { searchWeb, BLOCK, unsafeHost } from "./lib/websearch.mjs";
import { CHANNELS, harvestChannel } from "./lib/channels.mjs";

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
