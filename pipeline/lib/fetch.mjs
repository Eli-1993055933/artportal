// fetch.mjs —— 抓取:robots 校验 + 每域名限速 3 秒 + 署名 UA + 正文哈希 + HTML→纯文本。
//
// 合规铁律(需求第二/四节):
//  · 只抓机构官网和公开 RSS;绝不抓微信公众号/小红书/抖音。
//  · 抓前先读 robots.txt 并遵守;禁止即跳过。
//  · 同一域名两次请求间隔 >= 3 秒。
//  · User-Agent 如实署名身份 + 联系邮箱,不伪装浏览器。
//  · 对正文算哈希;内容没变就跳过,不调用 AI(省 ~90% 费用)。

import { createHash } from "node:crypto";
import { parseRobots, isAllowed, UA_TOKEN } from "./robots.mjs";

// 如实署名的 UA:身份 + 联系邮箱(需求第二节要求)。
// 注意:HTTP 头值必须是 ASCII,不能含中文,否则 fetch 抛 TypeError。
export const USER_AGENT =
  `${UA_TOKEN}/0.1 (+ArtPortal art-opportunity aggregator; official sites and public RSS only; contact: atsang799@gmail.com)`;

const MIN_INTERVAL_MS = 3000;         // 同域名最小间隔
const TIMEOUT_MS = 15000;
const lastHitByHost = new Map();
const robotsCache = new Map();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 同域限速。按 host 串行排队(promise 链):并发协程各自 check-then-sleep 会同时醒来连发,
// 破坏"同域 >= 3 秒"的承诺;串行链保证进程内任意并发下间隔都成立(跨进程仍各自计时)。
const hostChains = new Map();
function throttle(host) {
  const prev = hostChains.get(host) || Promise.resolve();
  const p = prev.then(async () => {
    const now = Date.now();
    const last = lastHitByHost.get(host) || 0;
    const wait = MIN_INTERVAL_MS - (now - last);
    if (wait > 0) await sleep(wait);
    lastHitByHost.set(host, Date.now());
  });
  hostChains.set(host, p.then(() => {}, () => {}));
  return p;
}

async function rawFetch(url, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, "Accept": accept || "text/html,application/xhtml+xml" }
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, url: res.url || url };   // res.url = 重定向后的最终地址
  } finally { clearTimeout(t); }
}

// 读取并缓存某域名的 robots 规则
async function getRobots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  let rules;
  try {
    const host = new URL(origin).host;
    await throttle(host);
    const r = await rawFetch(origin + "/robots.txt", "text/plain");
    if (r.status === 404 || r.status >= 500 || !r.body.trim()) {
      rules = { none: true, rules: { allow: [], disallow: [] } }; // 无 robots → 视为允许
    } else {
      rules = { none: false, rules: parseRobots(r.body, UA_TOKEN) };
    }
  } catch (e) {
    rules = { error: String(e.message || e), rules: { allow: [], disallow: [] } };
  }
  robotsCache.set(origin, rules);
  return rules;
}

// HTML → 纯文本:去 script/style/注释,标签转空白,解码常见实体,压缩空白。
// 这份文本既喂给 AI,也用于 evidence 子串校验——两边必须一致。
export function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").replace(/[ \t]*\n[ \t]*/g, "\n");
  return s.trim();
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…" };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCP(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCP(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (named[n.toLowerCase()] != null ? named[n.toLowerCase()] : m));
}
function safeCP(cp) { try { return String.fromCodePoint(cp); } catch (e) { return ""; } }

export function sha256(str) { return createHash("sha256").update(str, "utf8").digest("hex"); }

// 抓取一个信源。返回 { skipped, reason, status, text, hash, isRss }
export async function fetchSource(src) {
  // RSS 源抓 feed 地址;HTML 源抓页面地址
  const targetUrl = (src.type === "rss" && src.rss) ? src.rss : src.url;
  const u = new URL(targetUrl);
  const origin = u.origin;

  // 1) robots
  const rb = await getRobots(origin);
  if (!rb.none && !rb.error) {
    if (!isAllowed(rb.rules, u.pathname)) {
      return { skipped: true, reason: "robots-disallow", robots: "disallow" };
    }
  }

  // 2) 限速后抓取。src.render=true → 该站是 JS 渲染空壳,纯 fetch 只能拿到骨架,走无头浏览器
  //    (仅限个别站点显式标记,其余 207 个信源行为不变)。
  await throttle(u.host);
  let r;
  if (src.render) {
    try { const { renderPage } = await import("./render.mjs"); r = await renderPage(targetUrl); }
    catch (e) { return { skipped: true, reason: "render-error", error: String(e.name || e.message || e) }; }
  } else {
    const accept = src.type === "rss" ? "application/rss+xml,application/xml,text/xml" : "text/html,application/xhtml+xml";
    try { r = await rawFetch(targetUrl, accept); }
    catch (e) { return { skipped: true, reason: "fetch-error", error: String(e.name || e.message || e) }; }
  }

  if (!r.ok) return { skipped: true, reason: "http-" + r.status, status: r.status };

  const isRss = src.type === "rss";
  const text = isRss ? rssToText(r.body) : htmlToText(r.body);
  return {
    skipped: false, status: r.status, isRss,
    rawHtml: r.body, text,
    hash: sha256(text),
    finalUrl: r.url,      // 跟随重定向后的最终地址(调用方可据此做落点安全校验)
    robots: rb.none ? "none" : (rb.error ? "unknown" : "allow")
  };
}

// RSS/Atom → 逐条 item 的文本(标题 + 链接 + 描述/日期)。极简解析,无第三方依赖。
export function rssToText(xml) {
  const items = [];
  const blocks = String(xml).match(/<(item|entry)[\s\S]*?<\/\1>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i").exec(b);
      if (!m) return "";
      return decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    };
    const linkAttr = /<link[^>]*href="([^"]+)"/i.exec(b);
    const title = pick("title");
    const link = pick("link") || (linkAttr ? linkAttr[1] : "");
    const desc = pick("description") || pick("summary") || pick("content");
    const date = pick("pubDate") || pick("updated") || pick("published");
    items.push([title && ("标题: " + title), link && ("链接: " + link), date && ("日期: " + date), desc && ("摘要: " + desc)].filter(Boolean).join("\n"));
  }
  return items.join("\n\n---\n\n");
}
