// websearch.mjs —— 可插拔"全网搜索"基础设施。
// 搜索源优先级: Brave Search(推荐,免费 2000 次/月) → Serper(Google 结果,付费) → DuckDuckGo(免费降级)。
// 配了 BRAVE_API_KEY 就用 Brave,配了 SERPER_API_KEY 就用 Serper,都没配就用 DDG(限流不稳定)。

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// —— 预算系统(按北京日归零,持久化到 state/search-budget.json) ——
// Brave 和 Serper 各自独立预算,互不抢占。
// 超预算后自动降级到下一级源(Serper 或 DDG)。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirB = dirname(fileURLToPath(import.meta.url));
const BUDGET_FILE = join(__dirB, "..", "state", "search-budget.json");
const BRAVE_BUDGET = Math.max(1, Number(process.env.BRAVE_DAILY_BUDGET || 50));
const SERPER_BUDGET = Math.max(1, Number(process.env.SERPER_DAILY_BUDGET || 12));
function bjDay() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function readBudget() {
  try {
    const b = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
    if (b && b.day === bjDay()) return b;
  } catch (e) {}
  return { day: bjDay(), brave: { used: 0, by: {} }, serper: { used: 0, by: {} }, hits: {} };
}
function saveBudget(b) {
  try { mkdirSync(join(__dirB, "..", "state"), { recursive: true }); writeFileSync(BUDGET_FILE, JSON.stringify(b)); } catch (e) {}
}
function bumpBudget(source, who) {
  const b = readBudget();
  const s = b[source] || (b[source] = { used: 0, by: {} });
  s.used++;
  const k = String(who || "other"); s.by[k] = (s.by[k] || 0) + 1;
  saveBudget(b);
}
function bumpCacheHit(who) {
  const b = readBudget();
  const k = String(who || "other"); b.hits[k] = (b.hits[k] || 0) + 1;
  saveBudget(b);
}
export function serperBudgetLeft() { const b = readBudget(); return SERPER_BUDGET - (b.serper ? b.serper.used : 0); }
export function braveBudgetLeft() { const b = readBudget(); return BRAVE_BUDGET - (b.brave ? b.brave.used : 0); }
// 今日用量报表(供 admin 简报)
export function serperUsageToday() {
  const b = readBudget();
  const s = b.serper || { used: 0, by: {} };
  return { used: s.used, budget: SERPER_BUDGET, by: s.by || {}, hits: b.hits || {} };
}
export function braveUsageToday() {
  const b = readBudget();
  const s = b.brave || { used: 0, by: {} };
  return { used: s.used, budget: BRAVE_BUDGET, by: s.by || {}, hits: b.hits || {} };
}

// —— 查询缓存(7 天,600 条上限,挤掉最旧) ——
// 只缓存付费源(Brave/Serper)的成功结果,DDG 免费不缓存。
const CACHE_FILE = join(__dirB, "..", "state", "search-cache.json");
const CACHE_DAYS = Math.max(1, Number(process.env.SEARCH_CACHE_DAYS || 7));
function cacheLoad() {
  try { const c = JSON.parse(readFileSync(CACHE_FILE, "utf8")); return c && c.entries ? c : { entries: {} }; } catch (e) { return { entries: {} }; }
}
function cacheGet(key) {
  const c = cacheLoad();
  const e = c.entries[key];
  if (!e) return null;
  if (Date.now() - e.at > CACHE_DAYS * 86400e3) return null;
  return e.val;
}
function cachePut(key, val) {
  const c = cacheLoad();
  c.entries[key] = { at: Date.now(), val };
  const keys = Object.keys(c.entries);
  if (keys.length > 600) {
    keys.sort((a, b) => c.entries[a].at - c.entries[b].at);
    for (const k of keys.slice(0, keys.length - 600)) delete c.entries[k];
  }
  for (const k of Object.keys(c.entries)) if (Date.now() - c.entries[k].at > CACHE_DAYS * 86400e3) delete c.entries[k];
  try { mkdirSync(join(__dirB, "..", "state"), { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch (e) {}
}
function cacheKey(fn, query, opts) {
  return fn + "|" + String(query) + "|" + ((opts && opts.gl) || "cn") + "|" + ((opts && opts.hl) || "zh-cn") + "|" + (opts && opts.recent ? 1 : 0);
}

// 明显不是目标内容的噪声域名(社交/问卷/电商/招聘聚合/百科/搜索引擎自身等)。
export const BLOCK = /(weixin\.qq|mp\.weixin|zhihu\.com|xiaohongshu|xhslink|weibo\.|douban\.com|bilibili|baike\.baidu|baidu\.com|bing\.com|duckduckgo|zhipin|liepin|58\.com|facebook\.|instagram\.|youtube\.|twitter\.|t\.me|tiktok|douyin|1688\.|taobao|jd\.com|csdn|jianshu|sohu\.com|163\.com\/|qq\.com\/a\/|sina\.com|1zj\.com|wjx\.cn|zhengjifuwu|opencallradar|saikr\.com|gfbzb|征兵|cpta\.com\.cn|activity\.tencent|meishujia\.cn|zcool\.com\.cn\/work|nipic|huitu\.com|quanjing)/i;

// 候选 host 硬闸(SSRF 防线):裸 IP、localhost、内网后缀一律不抓
export function unsafeHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").split(":")[0];
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  if (h.includes(":")) return true;
  return false;
}

// ============================================================
//  对外接口: searchWeb / searchWebRich / searchWebFull
// ============================================================

// 统一入口(回链接数组)。优先级: Brave → Serper → DDG。
// opts.recent=true 时偏向最近结果;opts.who 标注花钱方(分桶审计)。
// 近 7 天同词缓存命中直接复用,不花额度。
export async function searchWeb(query, opts) {
  // 先查缓存(缓存键不含源,谁先剧缓存谁)
  const key = cacheKey("web", query, opts);
  const hit = cacheGet(key);
  if (hit) { bumpCacheHit(opts && opts.who); return hit.slice(); }

  // Brave 优先
  if (process.env.BRAVE_API_KEY && braveBudgetLeft() > 0) {
    try {
      bumpBudget("brave", opts && opts.who);
      const links = await braveSearch(query, opts);
      if (links.length) { cachePut(key, links); return links; }
    } catch (e) { /* 降级到下一级 */ }
  }
  // Serper 次之
  if (process.env.SERPER_API_KEY && serperBudgetLeft() > 0) {
    try {
      bumpBudget("serper", opts && opts.who);
      const links = await serperSearch(query, opts);
      if (links.length) { cachePut(key, links); return links; }
    } catch (e) { /* 降级到 DDG */ }
  }
  // DDG 兜底
  return await ddgSearch(query);
}

// 富结果搜索(自动化发现用):只回标题+摘要,【刻意不回链接】——
// 社媒只能当线索,下游拿不到链接就永远不可能去抓页面/存外链,合规由结构保证。
// 用 Brave 或 Serper;没 key 或没余量直接空手而归(发现属锦上添花,不做 DDG 兜底)。
export async function searchWebRich(query, opts) {
  // Brave 优先
  if (process.env.BRAVE_API_KEY && braveBudgetLeft() > 0) {
    try {
      bumpBudget("brave", (opts && opts.who) || "detective");
      return await braveSearchRich(query, opts);
    } catch (e) { /* 降级 */ }
  }
  // Serper 次之
  if (process.env.SERPER_API_KEY && serperBudgetLeft() > 0) {
    try {
      bumpBudget("serper", (opts && opts.who) || "detective");
      return await serperSearchRich(query, opts);
    } catch (e) { return []; }
  }
  return [];
}

// 全量搜索(信源发现用):同时要标题【和】链接——
// searchWeb 只回链接、searchWebRich 故意不回链接,都不够用。
// 用 Brave → Serper;两者都没 key 或余量不足走免费 DDG 兜底(不花付费额度)。
export async function searchWebFull(query, opts) {
  const key = cacheKey("full", query, opts);
  const hit = cacheGet(key);
  if (hit) { bumpCacheHit((opts && opts.who) || "discover"); return hit.map(o => ({ ...o })); }

  // Brave 优先
  if (process.env.BRAVE_API_KEY && braveBudgetLeft() > 0) {
    try {
      bumpBudget("brave", (opts && opts.who) || "discover");
      const out = await braveSearchFull(query, opts);
      if (out.length) { cachePut(key, out); return out; }
    } catch (e) { /* 降级 */ }
  }
  // Serper 次之
  if (process.env.SERPER_API_KEY && serperBudgetLeft() > 0) {
    try {
      bumpBudget("serper", (opts && opts.who) || "discover");
      const out = await serperSearchFull(query, opts);
      if (out.length) { cachePut(key, out); return out; }
    } catch (e) { /* 降级到 DDG */ }
  }
  // 免费兜底(不记付费账本,不缓存 —— DDG 限流且与付费源结果独立)
  return await ddgSearchFull(query);
}

// ============================================================
//  Brave Search 实现
// ============================================================

// 搜索(回链接数组)
async function braveSearch(query, opts) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "15");
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": process.env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("brave " + res.status);
  const j = await res.json();
  return (j.web && j.web.results || []).map(r => r.url).filter(Boolean);
}

// 富结果(标题+摘要,无链接)
async function braveSearchRich(query, opts) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "15");
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": process.env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("brave " + res.status);
  const j = await res.json();
  return (j.web && j.web.results || [])
    .map(r => ({ title: String(r.title || "").slice(0, 200), snippet: String(r.description || "").slice(0, 300) }))
    .filter(r => r.title);
}

// 全量(标题+链接)
async function braveSearchFull(query, opts) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "15");
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": process.env.BRAVE_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("brave " + res.status);
  const j = await res.json();
  return (j.web && j.web.results || [])
    .map(r => ({ title: String(r.title || "").slice(0, 200), link: String(r.url || "") }))
    .filter(r => r.link);
}

// ============================================================
//  Serper 实现(保留,作为付费备选)
// ============================================================

async function serperSearch(query, opts) {
  const body = { q: query, num: 15, gl: (opts && opts.gl) || "cn", hl: (opts && opts.hl) || "zh-cn" };
  if (opts && opts.recent) body.tbs = "qdr:y";
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("serper " + res.status);
  const j = await res.json();
  return (j.organic || []).map(o => o.link).filter(Boolean);
}

async function serperSearchRich(query, opts) {
  const body = { q: query, num: 15, gl: (opts && opts.gl) || "cn", hl: (opts && opts.hl) || "zh-cn" };
  if (opts && opts.recent) body.tbs = "qdr:m";
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("serper " + res.status);
  const j = await res.json();
  return (j.organic || [])
    .map(o => ({ title: String(o.title || "").slice(0, 200), snippet: String(o.snippet || "").slice(0, 300) }))
    .filter(o => o.title);
}

async function serperSearchFull(query, opts) {
  const body = { q: query, num: 15, gl: (opts && opts.gl) || "cn", hl: (opts && opts.hl) || "zh-cn" };
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("serper " + res.status);
  const j = await res.json();
  const out = (j.organic || [])
    .map(o => ({ title: String(o.title || "").slice(0, 200), link: String(o.link || "") }))
    .filter(o => o.link);
  return out;
}

// ============================================================
//  DuckDuckGo 降级(免费,限流不稳定)
// ============================================================

async function ddgSearch(query) {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    const out = [];
    for (const m of html.matchAll(/uddg=([^&"']+)/g)) {
      try { out.push(decodeURIComponent(m[1])); } catch (e) {}
    }
    return out;
  } catch (e) { return []; }
}

// DDG lite 全量(标题+链接),免费兜底用;goo.gl 转跳链接统一解码回真实目标。
async function ddgSearchFull(query) {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(10000) });
    const html = await res.text();
    const out = [];
    for (const m of html.matchAll(/<a[^>]+rel="nofollow"[^>]+href="([^"]*uddg=[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[1];
      const title = String(m[2] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
      const um = href.match(/uddg=([^&]+)/);
      if (!um) continue;
      let target;
      try { target = decodeURIComponent(um[1]); } catch (e) { continue; }
      if (!/^https?:\/\//.test(target)) continue;
      if (!title) continue;
      out.push({ title, link: target });
    }
    return out;
  } catch (e) { return []; }
}