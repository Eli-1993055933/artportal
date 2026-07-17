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
  try { const b = JSON.parse(readFileSync(BUDGET_FILE, "utf8")); if (b && b.day === bjDay()) return b; } catch (e) {}
  return { day: bjDay(), used: 0 };
}
function bumpBudget() {
  const b = readBudget(); b.used++;
  try { mkdirSync(join(__dirB, "..", "state"), { recursive: true }); writeFileSync(BUDGET_FILE, JSON.stringify(b)); } catch (e) {}
}
export function serperBudgetLeft() { return DAILY_BUDGET - readBudget().used; }

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
export async function searchWeb(query, opts) {
  if (process.env.SERPER_API_KEY && serperBudgetLeft() > 0) {
    try { bumpBudget(); return await serperSearch(query, opts); }
    catch (e) { return await ddgSearch(query); }   // API 失败也降级 DDG
  }
  return await ddgSearch(query);
}

async function serperSearch(query, opts) {
  const body = { q: query, num: 15, gl: "cn", hl: "zh-cn" };
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
