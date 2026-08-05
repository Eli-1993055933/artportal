// websearch.mjs —— 频道无关的"全网搜索"基础设施(从 server.mjs 抽出,供机会/资讯/招聘三频道共用)。
//
// 可插拔搜索源:配了 SERPER_API_KEY(serper.dev,Google 结果,有免费额度)就用它(稳定);
// 否则退回 DuckDuckGo lite(免密钥但会被限流,仅适合原型)。上线稳定跑建议配 key。

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// —— serper 每日预算闸门(2026-07-18,用户要求余额至少撑半年)——
// 每次 serper 调用计一次数,持久化在 state/search-budget.json(按北京日归零);
// 超预算后 searchWeb 自动降级 DDG(免费,稳定性差些,但用户检索不中断)。
// SERPER_DAILY_BUDGET 每日上限(默认 12);serperBudgetLeft() 供自动检索调度器让路用。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirB = dirname(fileURLToPath(import.meta.url));
const BUDGET_FILE = join(__dirB, "..", "state", "search-budget.json");
const DAILY_BUDGET = Math.max(1, Number(process.env.SERPER_DAILY_BUDGET || 12));
function bjDay() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }
function readBudget() {
  try { const b = JSON.parse(readFileSync(BUDGET_FILE, "utf8")); if (b && b.day === bjDay()) return { by: {}, hits: {}, ...b }; } catch (e) {}
  return { day: bjDay(), used: 0, by: {}, hits: {} };
}
function saveBudget(b) {
  try { mkdirSync(join(__dirB, "..", "state"), { recursive: true }); writeFileSync(BUDGET_FILE, JSON.stringify(b)); } catch (e) {}
}
// 分桶计数(v1.5.0):who=谁在花钱(user 用户检索 / region 区域经理 / detective 探长 / discover 信源发现 / channels 频道 / other)
function bumpBudget(who) {
  const b = readBudget(); b.used++;
  const k = String(who || "other"); b.by[k] = (b.by[k] || 0) + 1;
  saveBudget(b);
}
function bumpCacheHit(who) {
  const b = readBudget();
  const k = String(who || "other"); b.hits[k] = (b.hits[k] || 0) + 1;
  saveBudget(b);
}
export function serperBudgetLeft() { return DAILY_BUDGET - readBudget().used; }
// 今日用量报表(供 admin 简报):{ used, budget, by:{...}, hits:{...} }
export function serperUsageToday() {
  const b = readBudget();
  return { used: b.used, budget: DAILY_BUDGET, by: b.by || {}, hits: b.hits || {} };
}

// —— 查询缓存(v1.5.0):同样的 (接口|词|gl|hl|recent) 近 N 天内命中直接复用,省真金白银的 serper 调用 ——
// 只缓存 serper 成功结果(DDG 免费不缓存);TTL 默认 7 天(SEARCH_CACHE_DAYS 可调),条目上限 600(挤掉最旧)。
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
  // 顺手清过期
  for (const k of Object.keys(c.entries)) if (Date.now() - c.entries[k].at > CACHE_DAYS * 86400e3) delete c.entries[k];
  try { mkdirSync(join(__dirB, "..", "state"), { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(c)); } catch (e) {}
}
function cacheKey(fn, query, opts) {
  return fn + "|" + String(query) + "|" + ((opts && opts.gl) || "cn") + "|" + ((opts && opts.hl) || "zh-cn") + "|" + (opts && opts.recent ? 1 : 0);
}

// 明显不是目标内容的噪声域名(社交/问卷/电商/招聘聚合/百科/搜索引擎自身等)。
// 注意:这里挡的是"绝不采集"的硬边界(微信/小红书/抖音等)+ 内容农场;
// 三频道共用。机会频道另有 aggregators.mjs 的第三方黑名单(资讯/招聘不适用——媒体本身就是资讯的信源)。
export const BLOCK = /(weixin\.qq|mp\.weixin|zhihu\.com|xiaohongshu|xhslink|weibo\.|douban\.com|bilibili|baike\.baidu|baidu\.com|bing\.com|duckduckgo|zhipin|liepin|58\.com|facebook\.|instagram\.|youtube\.|twitter\.|t\.me|tiktok|douyin|1688\.|taobao|jd\.com|csdn|jianshu|sohu\.com|163\.com\/|qq\.com\/a\/|sina\.com|1zj\.com|wjx\.cn|zhengjifuwu|opencallradar|saikr\.com|gfbzb|征兵|cpta\.com\.cn|activity\.tencent|meishujia\.cn|zcool\.com\.cn\/work|nipic|huitu\.com|quanjing)/i;

// 候选 host 硬闸(SSRF 防线):裸 IP、localhost、内网后缀一律不抓——
// 正规机构官网/媒体都有域名;搜索结果里出现 IP 直连没有任何正当理由。
export function unsafeHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").split(":")[0];
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;      // IPv4 直连
  if (h.includes(":")) return true;                        // IPv6 直连(host 端口已剥)
  return false;
}

// 统一入口。opts.recent=true 时(资讯频道)偏向最近一年的结果(serper 支持;DDG 忽略)。
// 今日 serper 预算用尽 → 自动降级 DDG(计数在调用前记,失败也算,宁紧勿松)。
// opts.who 标注花钱方(分桶审计);近 7 天同词缓存命中直接复用,不花额度。
export async function searchWeb(query, opts) {
  if (process.env.SERPER_API_KEY) {
    const key = cacheKey("web", query, opts);
    const hit = cacheGet(key);
    if (hit) { bumpCacheHit(opts && opts.who); return hit.slice(); }
    if (serperBudgetLeft() > 0) {
      try {
        bumpBudget(opts && opts.who);
        const links = await serperSearch(query, opts);
        if (links.length) cachePut(key, links);
        return links;
      } catch (e) { return await ddgSearch(query); }   // API 失败降级 DDG
    }
  }
  return await ddgSearch(query);
}

// 富结果搜索(自动化发现用):只回 SERP 的标题+摘要,【刻意不回链接】——
// 社媒(小红书等)只能当"线索",下游拿不到链接就永远不可能去抓页面/存外链,合规由结构保证。
// 仅走 serper(计预算);没 key 或没余量直接空手而归(发现属锦上添花,不做 DDG 兜底)。
export async function searchWebRich(query, opts) {
  if (!process.env.SERPER_API_KEY || serperBudgetLeft() <= 0) return [];
  bumpBudget((opts && opts.who) || "detective");   // 线索要新鲜,刻意不缓存
  const body = { q: query, num: 15, gl: (opts && opts.gl) || "cn", hl: (opts && opts.hl) || "zh-cn" };
  if (opts && opts.recent) body.tbs = "qdr:m";     // 线索要新:最近一个月
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

// 全量搜索(信源发现用,discover-sources.mjs):同时要标题【和】链接——
// searchWeb 只回链接、searchWebRich 故意不回链接(social 线索用途),都不够用。
// 计同一份 serper 预算;没 key 或余量不足直接空手而归(信源发现是锦上添花,不做 DDG 兜底,
// 免得把低质量结果当真实机构收进 sources.json)。
export async function searchWebFull(query, opts) {
  if (!process.env.SERPER_API_KEY) return [];
  const key = cacheKey("full", query, opts);
  const hit = cacheGet(key);
  if (hit) { bumpCacheHit((opts && opts.who) || "discover"); return hit.map(o => ({ ...o })); }
  if (serperBudgetLeft() <= 0) return [];
  bumpBudget((opts && opts.who) || "discover");
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
  if (out.length) cachePut(key, out);
  return out;
}

async function serperSearch(query, opts) {
  // 地域/语言自适应(2026-07-20):默认中国区中文,但检索国际地点时由调用方传入 gl/hl
  // (如洛杉矶 → gl=us/hl=en),否则 Google 只返中国区结果、国际站被严重降权。
  const body = { q: query, num: 15, gl: (opts && opts.gl) || "cn", hl: (opts && opts.hl) || "zh-cn" };
  if (opts && opts.recent) body.tbs = "qdr:y";     // 最近一年(资讯要新)
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
