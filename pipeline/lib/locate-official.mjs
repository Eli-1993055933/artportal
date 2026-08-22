// locate-official.mjs —— 官网定位器:给定一条机会(标题+主办方),找到该展览项目【主办方自己官网】上
// 对应的页面(或主办方官网首页),供「前往官网」直达,取代第三方聚合/新闻链接。
//
// 严守反幻觉红线:
//  - 只返回程序【真实抓取到、且经 DeepSeek 判定确为该主办方本站并与此机会相关】的 URL。
//  - 绝不返回第三方域名(黑名单);绝不凭空编造或猜测 URL。
//  - 拿不准就返回 null(宁可暂时没有官网直链,也不给错的)。
//
// 复用现有基础设施:serper 搜索(退回 DDG)+ fetchSource + DeepSeek 判定。

import { fetchSource } from "./fetch.mjs";
import { isThirdParty, hostOf } from "./aggregators.mjs";
import { extractGlmFree } from "./extract.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const SOCIAL = /facebook|instagram|twitter|x\.com|linkedin|youtube|pinterest|t\.me|tiktok|vimeo|flickr|mailto/i;

// 从聚合页/新闻页的原始 HTML 里挖主办方官网线索(比纯搜索更准):
//  ① JSON-LD 里的 url / sameAs / mainEntityOfPage;② "官网/官方网站/website/apply/organiser/visit" 附近的外链。
// 只返回非第三方、非社媒的外部绝对链接。
export function extractOrgLinksFromHtml(html, baseUrl) {
  if (!html) return [];
  const out = [], seen = new Set();
  let baseHost = ""; try { baseHost = new URL(baseUrl).host.replace(/^www\./, "").toLowerCase(); } catch (e) {}
  const push = (u) => {
    if (!u || !/^https?:\/\//i.test(u)) return;
    let h; try { h = new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch (e) { return; }
    if (!h || h === baseHost) return;                 // 排除聚合站自身链接
    if (isThirdParty(u) || SOCIAL.test(u)) return;    // 排除第三方/社媒
    const key = u.split("#")[0];
    if (seen.has(key)) return; seen.add(key); out.push(key);
  };
  // ① JSON-LD
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      const nodes = Array.isArray(j) ? j : (j["@graph"] || [j]);
      for (const n of (Array.isArray(nodes) ? nodes : [nodes])) {
        if (!n || typeof n !== "object") continue;
        [n.url, n.mainEntityOfPage, ...(Array.isArray(n.sameAs) ? n.sameAs : [n.sameAs])].forEach(v => {
          if (typeof v === "string") push(v);
          else if (v && typeof v === "object" && typeof v["@id"] === "string") push(v["@id"]);
        });
      }
    } catch (e) {}
  }
  // ② "官网/申请"等锚点上下文里的外链
  for (const m of html.matchAll(/(官方网站|官\s*网|官方|主办方网站|website|official\s*site|apply\s*here|organiser|organizer|visit\s*(the\s*)?site|external\s*link)[^<]{0,30}<a[^>]+href="(https?:\/\/[^"]+)"/gi)) {
    push(m[m.length - 1]);
  }
  for (const m of html.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[^<]{0,40}(官方网站|官\s*网|官方|website|official|apply|visit\s*site|外部链接)[^<]{0,10}<\/a>/gi)) {
    push(m[1]);
  }
  return out;
}

// Serper 熔断:一旦确认余额耗尽/失效,本进程后续搜索直接跳过它,避免每次溯源白打一次 400 拖慢。
let serperDead = false;
async function serperSearch(query) {
  if (serperDead) throw new Error("serper dead");
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10, gl: "cn", hl: "zh-cn" }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401 || res.status === 429 || res.status >= 500) serperDead = true; // 额度耗尽/失效:熔断
    throw new Error("serper " + res.status);
  }
  const j = await res.json();
  return (j.organic || []).map(o => ({ url: o.link, title: o.title, snippet: o.snippet })).filter(x => x.url);
}
// 免费兜底:必应(cn.bing,国内直连)。原 DDG 在服务器网络层被墙不可达,2026-08-23 改必应。
async function ddgSearch(query) {
  const url = "https://cn.bing.com/search?q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error("bing " + res.status);
  const html = await res.text();
  const out = [];
  const NAV = /bing\.com|microsoft\.com|msn\.com|miit\.gov\.cn|beian\b|baike\.baidu\.com|go\.microsoft\.com|javascript:|^#|^\//;
  for (const m of html.matchAll(/<a\s+href="(https?:\/\/[^"]+)"[^>]*>/g)) {
    const u = m[1].replace(/&amp;/g, "&");
    if (!/^https?:\/\//.test(u) || NAV.test(u)) continue;
    out.push({ url: u });
    if (out.length >= 10) break;
  }
  return out;
}
async function search(query) {
  if (process.env.SERPER_API_KEY) { try { return await serperSearch(query); } catch (e) { return await ddgSearch(query); } }
  return await ddgSearch(query);
}

// DeepSeek 判定:候选页面是否确为该主办方本站,且与此机会相关。
// 返回 { level: "specific"|"org"|"no" }:specific=正是这个机会的官网页;org=主办方官网但不是本机会专页;no=不相关/是第三方。
export async function judge(item, cand, pageText) {
  const sys =
    "你在核对一个「艺术机会」的官网链接是否可信。给你:机会的标题/主办方,以及一个候选网页的 URL 和正文节选。\n" +
    "判断该候选页面是不是【主办方自己官网】上的页面(不是新闻转载、不是聚合平台、不是他人博客)。只输出 JSON:\n" +
    '{ "level": "specific" | "org" | "no", "reason": "简述" }\n' +
    "- specific:该页就是这个机会/项目本身的官方页面(正文能对上标题或主办方与项目)。\n" +
    "- org:该页确为主办方官网(域名/正文能确认是该主办方本站),但不是这个机会的专门页面(如官网首页/栏目页)。\n" +
    "- no:无法确认是主办方本站,或明显是第三方(新闻/聚合/目录/社媒/百科)、或与该机会无关。\n" +
    "存疑一律给 no。绝不为了凑答案而给 specific/org。";
  const user = "机会标题:" + (item.title || "") + "\n主办方:" + (item.org || "") +
    "\n候选URL:" + cand.url + "\n候选网页正文节选:\n" + String(pageText || "").slice(0, 2500);
  // GLM 免费档为主(核实是短文本判断,flash 够用,且是长期主力,见 2026-08-02 决策;存疑照旧给 no,红线不松)
  try {
    const g = await extractGlmFree(sys, user, 200);
    const parsed = (g && g.data) || {};
    if (parsed.level) return { level: ["specific", "org", "no"].includes(parsed.level) ? parsed.level : "no", reason: parsed.reason };
  } catch (e) {}
  // GLM 不可用时 DeepSeek 兜底
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return { level: "no" };
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.EXTRACT_MODEL || "deepseek-chat",
        temperature: 0, max_tokens: 200, response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: user }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return { level: "no" };
    const j = await res.json();
    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "{}";
    const m = /\{[\s\S]*\}/.exec(raw);
    const parsed = m ? JSON.parse(m[0]) : {};
    return { level: ["specific", "org", "no"].includes(parsed.level) ? parsed.level : "no", reason: parsed.reason };
  } catch (e) { return { level: "no" };
  }
}

// 主入口:返回 { url, level, reason } 或 null。
// item: { title, org, city, country };opts.sourceHtml = 抓到该条时的原始 HTML(聚合页里常含官网链接,优先用)。
export async function locateOfficial(item, opts = {}) {
  const maxProbe = opts.maxProbe || 6;
  const org = (item.org || "").trim();
  const title = (item.title || "").trim();
  if (!org && !title) return null;

  const seen = new Set(), cands = [];
  const addCand = (url, extra) => {
    const key = (url || "").split("#")[0];
    if (!key || seen.has(key)) return;
    if (isThirdParty(key) || SOCIAL.test(key)) return;
    seen.add(key); cands.push({ url: key, ...(extra || {}) });
  };

  // ① 先用抓取时的原始 HTML 里挖到的官网线索(最准:聚合页本就链向主办方)
  if (opts.sourceHtml && opts.sourceUrl) {
    for (const u of extractOrgLinksFromHtml(opts.sourceHtml, opts.sourceUrl)) addCand(u, { fromHtml: true });
  }

  // ② 再用 AI/搜索:主办方 + 项目名 + 官网/征集词;国际项目补一条英文
  const queries = [
    [org, title, "官网"].filter(Boolean).join(" "),
    [org, title, "征集 报名 官网"].filter(Boolean).join(" "),
    [title, org, "official site open call"].filter(Boolean).join(" ")
  ];
  for (const q of queries) {
    let hits = [];
    try { hits = await search(q); } catch (e) {}
    for (const h of hits) addCand(h.url, { title: h.title, snippet: h.snippet });
    await new Promise(r => setTimeout(r, 600));
  }
  if (!cands.length) return null;

  // 逐个抓取 + DeepSeek 判定;specific 立即返回,org 记下作为兜底。HTML 挖出来的候选排在最前先验。
  let orgFallback = null, probed = 0;
  for (const cand of cands) {
    if (probed >= maxProbe) break;
    probed++;
    let f;
    try { f = await fetchSource({ url: cand.url, domain: hostOf(cand.url), type: "html" }); }
    catch (e) { continue; }
    if (f.skipped || !f.text || f.text.length < 120) continue;
    const v = await judge(item, cand, f.text);
    if (v.level === "specific") return { url: cand.url, level: "specific", reason: v.reason };
    if (v.level === "org" && !orgFallback) orgFallback = { url: cand.url, level: "org", reason: v.reason };
  }
  return orgFallback;   // 可能为 null
}
