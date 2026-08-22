// sitemap.mjs —— 用站点 sitemap.xml 精确定位"自上次抓取以来变了哪些详情页",
// 替代"抓列表页 → 猜链接 → 逐个抓详情页算哈希"这套更贵更粗的发现方式。
// 依据:《采集管线重构-方案评估与替代建议.md》第五节实测,国际源 10/13 有 sitemap 且带 lastmod。
//
// 只做发现,不保证一定有:没有 sitemap / 解析失败 → 返回 null,调用方(run.mjs)退回现有
// discoverDetailLinks;真伪仍由后续 verify.mjs 的 evidence 校验兜底,这里不改变反幻觉红线。

import { fetchRaw } from "./fetch.mjs";
import { looksLikeDetail } from "./discover.mjs";

const MAX_CHILD_SITEMAPS = 3;     // sitemapindex 下最多跟进这么多个子 sitemap,防止某些站几十个分片站文件耗光带宽
const MAX_URLS_PER_SITEMAP = 5000; // 单个 sitemap 最多解析这么多条,防超大文件撑爆内存

// sitemap 里的 URL 没有锚文本可判断,discover.mjs 的 looksLikeDetail() 是给"列表页猜链接"用的、
// 偏向国内 CMS 的数字 ID 形态,西方站常用可读 slug(/open-call-2026/)不会命中它。这里只做"排除明显
// 非内容页"的宽松过滤,真伪仍交给下游 verify.mjs 的 evidence 校验——过滤太严会让 sitemap 通道白搭。
const EXCLUDE_EXT = /\.(jpg|jpeg|png|gif|svg|webp|css|js|pdf|zip|ico|xml|json|mp4|mp3)$/i;
const EXCLUDE_SEGMENT = /^\/(tag|tags|category|categories|author|authors|page|search|cart|checkout|login|register|account|wp-json|wp-content|feed|sitemap|privacy|terms|cookie|accessibility|contact|about|team|staff)(\/|$)/i;

// 艺术机会相关关键词:用于给 sitemap URL 打分,优先抓取高价值页面
const ART_OPPORTUNITY_KEYWORDS = [
  // 英文
  "open.call", "opencall", "call.for.artists", "call.for.entries",
  "residency", "fellowship", "grant", "award", "prize",
  "exhibition", "exhibit", "show", "biennale", "triennale",
  "submission", "apply", "application", "deadline",
  "public.art", "commission", "artist.in.residence",
  "opportunity", "program", "project", "competition",
  "festival", "symposium", "workshop", "residencies",
  // 中文
  "征集", "公开", "驻留", "奖", "资助", "展览", "展出",
  "投稿", "申请", "截止", "报名", "入选", "公示",
  "艺术", "作品", "项目", "计划", "招募"
];

// URL 打分:分数越高越可能是艺术机会页面
function scoreUrlForArtOpportunity(urlStr) {
  let score = 0;
  try {
    const u = new URL(urlStr);
    // 解码 URL(处理中文等非 ASCII 字符)
    const decodedPath = decodeURIComponent(u.pathname + u.search).toLowerCase();
    const lowerFull = decodedPath;
    
    for (const kw of ART_OPPORTUNITY_KEYWORDS) {
      const kwPattern = kw.replace(/\./g, "[./-]");
      if (new RegExp(kwPattern, "iu").test(lowerFull)) {
        score += kw.length > 3 ? 3 : 2; // 长关键词权重更高
      }
    }
  } catch (e) {}
  return score;
}

function looksLikeContentPage(u) {
  const p = u.pathname;
  if (!p || p === "/") return false;
  if (EXCLUDE_EXT.test(p)) return false;
  if (EXCLUDE_SEGMENT.test(p)) return false;
  if (/[?&]page=\d+/i.test(u.search)) return false;
  return true;
}

function parseLocLastmod(xml) {
  const out = [];
  const blocks = String(xml).match(/<url>[\s\S]*?<\/url>/gi) || [];
  for (const b of blocks.slice(0, MAX_URLS_PER_SITEMAP)) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(b);
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/i.exec(b);
    if (loc && loc[1]) out.push({ url: loc[1].trim(), lastmod: lastmod ? lastmod[1].trim().slice(0, 10) : null });
  }
  return out;
}
function parseChildSitemaps(xml) {
  const out = [];
  const blocks = String(xml).match(/<sitemap>[\s\S]*?<\/sitemap>/gi) || [];
  for (const b of blocks) {
    const loc = /<loc>([\s\S]*?)<\/loc>/i.exec(b);
    if (loc && loc[1]) out.push(loc[1].trim());
  }
  return out;
}

// discoverViaSitemap(origin, domain, {cap, sinceDate}) → { urls:[{url,lastmod}], totalInSitemap } | null
//   null = 该站没有 sitemap.xml 或解析失败,调用方应退回旧的列表页发现方式。
//   sinceDate('YYYY-MM-DD',可选) = 只留 lastmod >= 这天的条目(无 lastmod 的条目视为"不确定",照留)。
export async function discoverViaSitemap(origin, domain, opts) {
  opts = opts || {};
  const cap = opts.cap || 40;
  const sinceDate = opts.sinceDate || null;

  let r;
  try { r = await fetchRaw(origin.replace(/\/$/, "") + "/sitemap.xml", "application/xml,text/xml", { timeoutMs: 5000 }); }
  catch (e) { return null; }
  if (!r || r.skipped || !r.ok || !r.body || !/<(urlset|sitemapindex)/i.test(r.body)) return null;

  let entries = [];
  if (/<sitemapindex/i.test(r.body)) {
    const children = parseChildSitemaps(r.body).slice(0, MAX_CHILD_SITEMAPS);
    for (const childUrl of children) {
      try {
        const cr = await fetchRaw(childUrl, "application/xml,text/xml", { timeoutMs: 5000 });
        if (cr && !cr.skipped && cr.ok && cr.body) entries.push(...parseLocLastmod(cr.body));
      } catch (e) { /* 单个子 sitemap 失败不影响其它子文件 */ }
    }
  } else {
    entries = parseLocLastmod(r.body);
  }
  if (!entries.length) return { urls: [], totalInSitemap: 0 };

  // lastmod 可信度自检(实测踩过坑):gasworks.org.uk 等站点的 lastmod 常年停在建站那天,形同摆设。
  // 只有当全站【最新】lastmod 距今 ≤90 天,才说明这个站真的在维护这个字段,才敢拿它来判"没变就跳过";
  // 否则不做时间过滤(只按数量截断),靠后续每页哈希/条件请求兜底——绝不能让一个不可靠的元数据字段
  // 造成"以为没变、其实一直没被重新检查"的静默盲区,这比多花一点带宽重新检查更重要。
  const newestLastmod = entries.reduce((mx, e) => (e.lastmod && e.lastmod > mx ? e.lastmod : mx), "");
  const trustLastmod = !!(newestLastmod && (Date.now() - Date.parse(newestLastmod)) < 90 * 86400e3);

  let base;
  try { base = new URL(origin); } catch (e) { return null; }
  const baseDomain = String(domain || base.host).replace(/^www\./, "");
  const seen = new Set();
  const filtered = [];
  for (const e of entries) {
    let u; try { u = new URL(e.url); } catch (err) { continue; }
    const host = u.host.replace(/^www\./, "");
    if (host !== baseDomain && !host.endsWith("." + baseDomain)) continue;
    if (!looksLikeDetail(u) && !looksLikeContentPage(u)) continue;
    if (sinceDate && trustLastmod && e.lastmod && e.lastmod < sinceDate) continue; // 只在 lastmod 可信时才拿它跳过未变页
    const key = u.href.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    // 为每个 URL 计算艺术机会评分
    const artScore = scoreUrlForArtOpportunity(key);
    filtered.push({ url: key, lastmod: e.lastmod, artScore });
  }
  // 按艺术机会评分排序,高分优先(更可能是征集/驻留/奖项页面)
  filtered.sort((a, b) => b.artScore - a.artScore);
  // 取前 cap 条
  const result = filtered.slice(0, cap).map(({ url, lastmod }) => ({ url, lastmod }));
  return { urls: result, totalInSitemap: entries.length, trustLastmod };
}
