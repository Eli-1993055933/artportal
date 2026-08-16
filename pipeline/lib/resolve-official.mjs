// resolve-official.mjs —— 官网溯源关卡(转载识别 + 官方链接溯源)。
//
// 放在收割【落地当刻】执行,取代"深夜事后回填"的滞后:检索到机会后先判断该页面/域
// 是主办方官网、可信报名平台、还是别人平台转载;若是转载,就用【转载页里的标题+主办方】
// 去搜索、找出真正的主办方官网链接,再落到本站 —— 绝不让用户点「前往官网」落到转载平台。
//
// 牢记反幻觉红线:拿到候选不是直接信,过了程序硬闸 + AI 定级两道才放行。
// 定位不到就如实不定位(via_repost + source_platform 如实标注),绝不硬造 URL、绝不冒充官网。
//
// 多关卡、可审计:每次 resolve 返回 gates 数组,记录每关结论,供反幻觉问责与排查。
// 搜索预算与全站统一账本共享(searchWebFull 的 who="resolve-official"),缓存命中不计费。

import { isThirdParty, isTrustedPlatform, hostOf } from "./aggregators.mjs";
import { searchWebFull } from "./websearch.mjs";
import { fetchSource } from "./fetch.mjs";
import { extractOrgLinksFromHtml, judge } from "./locate-official.mjs";

const SOCIAL = /facebook|instagram|twitter|linkedin|youtube|pinterest|t\.me|tiktok|vimeo|flickr|whatsapp|mailto|xiaohongshu|weixin|weibo|zhihu|baike\.baidu/i;

function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

// ============ 关卡 1:来源权威分类(确定性,零搜索) ============
//   trusted-platform  →《可信报名平台》(可接受,但走"平台登记"标注)
//   repost            → 黑名单第三方(转载/聚合/新闻/门户),必须溯源
//   official          → 非黑名单,视为主办方自己(不动它的链接)
export function classifySource(domain) {
  const u = "http://" + String(domain || "").replace(/^https?:\/\//, "");
  if (isTrustedPlatform(u)) return "trusted-platform";
  if (isThirdParty(u)) return "repost";
  return "official";
}

// ============ 关卡 4 辅助:候选页证据子串(程序硬闸 B) ============
// 候选页正文是否命中【标题 或 主办方】(宽松:任一字段归一后 ≥4 字节即算可用)。
// 返回 true/false/null:null=没有可用词(交给 AI 定级);false=词存在但页面没包含。
function pageEvidenceMatch(item, pageText) {
  const t = norm(pageText);
  const terms = [item.title, item.org].map(norm).filter(s => s && s.length >= 4);
  if (!terms.length) return null;
  return terms.some(term => t.includes(term));
}

// ============ 关卡 4:单候选真实性校验(程序硬闸 A/B + AI 定级) ============
async function verifyCandidate(item, cand) {
  const url = cand.url;
  // 硬闸 A:host 必须是主办方本站(非第三方/非社媒/非可信平台)
  if (isThirdParty(url) || SOCIAL.test(url)) return { level: "reject", reason: "第三方/社媒域名" };
  let f;
  try { f = await fetchSource({ url, domain: hostOf(url), type: "html" }); }
  catch (e) { return { level: "reject", reason: "抓取失败" }; }
  if (f.skipped || !f.text || f.text.length < 120) return { level: "reject", reason: "页面过短/跳过" };
  // 硬闸 B:证据子串(宽松)
  const evMatch = pageEvidenceMatch(item, f.text);
  // AI 定级(specific = 正是本机会专页;org = 主办方官网非专页;no = 存疑/第三方)
  let v;
  try { v = await judge(item, cand, f.text); } catch (e) { v = { level: "no", reason: "judge失败" }; }
  // specific 必须程序证据也命中才放行(防 AI 擅自把转载/无关页判成专页)
  if (v.level === "specific" && evMatch === false) v = { level: "no", reason: "AI称specific但页面无标题/主办方证据,疑误判" };
  return { level: v.level, reason: v.reason || (evMatch ? "有证据命中" : "无证据命中") };
}

// ============ 主入口:解析一条机会的官网 ============
// item:  { title, org, sourceHtml?, sourceUrl? }
// src:   { domain, name_zh?, org_zh? }
// opts:  { budget:本批次搜索预算(整数,<=0 则跳过关卡3), who? 已固化"resolve-official",
//          maxProbe:单条最多候选数 }
// 返回 { official_url, official_located, via_repost, source_platform, classify, searched, gates }
export async function resolve(item, src, opts = {}) {
  const gates = [];
  const batchBudget = Math.max(0, opts.budget !== undefined ? opts.budget : 80);
  const maxProbe = Math.max(1, opts.maxProbe || 6);

  // 关卡 1
  const cls = classifySource(src && src.domain);
  gates.push({ gate: 1, name: "来源权威分类", verdict: cls, note: (src && src.domain) || "" });
  // 主办方官网/未收录 → 不动链接
  if (cls === "official") {
    return { official_url: null, official_located: null, via_repost: false, source_platform: null,
      classify: cls, searched: 0, gates };
  }

  // 关卡 2(零搜索):转载页 HTML 里挖主办方官网(JSON-LD sameAs / "官网|visit site" 锚点)
  const cands = [];
  if (item.sourceHtml && item.sourceUrl) {
    for (const u of extractOrgLinksFromHtml(item.sourceHtml, item.sourceUrl)) {
      const key = u.split("#")[0];
      if (!isThirdParty(u) && !SOCIAL.test(u) && !cands.some(c => c.url === key)) cands.push({ url: key, fromHtml: true });
    }
  }
  gates.push({ gate: 2, name: "转载页内挖官方", verdict: cands.length ? "found" : "none" });

  // 关卡 3(预算共享):【转载页标题全称 + 主办方】检索候选官网 —— 你描述的那步
  let searched = 0, budget = batchBudget;
  if (budget > 0 && (item.title || item.org)) {
    const queries = [
      [item.org, item.title, "官网"].filter(Boolean).join(" "),
      [item.title, item.org, "official site open call"].filter(Boolean).join(" ")
    ];
    for (const q of queries) {
      if (budget - searched <= 0) break;
      let hits = [];
      try { hits = await searchWebFull(q, { who: "resolve-official" }); } catch (e) { hits = []; }
      searched++;
      for (const h of hits) {
        const hu = h && (h.link || h.url);   // searchWebFull 返回 {title,link};兼容 url
        if (!hu || isThirdParty(hu) || SOCIAL.test(hu)) continue;
        if (!cands.some(c => c.url === hu)) cands.push({ url: hu, fromSearch: true });
      }
    }
  }
  gates.push({ gate: 3, name: "标题检索候选", verdict: cands.length ? "found" : "none", searched });

  // 关卡 4:候选真实性校验(AI specific / org / no / reject)
  // 转载页内挖出的候选排最前优先验。
  const ordered = [...cands].sort((a, b) => (b.fromHtml ? 1 : 0) - (a.fromHtml ? 1 : 0));
  let specificUrl = null, orgFallback = null, checked = 0;
  for (const cand of ordered.slice(0, maxProbe)) {
    const r = await verifyCandidate(item, cand);
    checked++;
    if (r.level === "specific") { specificUrl = cand.url; break; }
    if (r.level === "org" && !orgFallback) orgFallback = cand.url;
  }
  gates.push({ gate: 4, name: "候选真实性校验", verdict: (specificUrl ? "specific" : (orgFallback ? "org" : "no")), checked });

  // 关卡 5:落库
  const out = {
    official_url: specificUrl || orgFallback || null,
    official_located: specificUrl ? "specific" : (orgFallback ? "org" : "not_found"),
    via_repost: cls === "repost",
    source_platform: (cls === "trusted-platform" || cls === "repost")
      ? (src.name_zh || src.org_zh || hostOf("http://" + (src.domain || ""))) : null,
    classify: cls, searched, gates
  };
  return out;
}

// 便捷:给定机会记录的出站 URL,判断它是否需溯源(第三方/可信平台入口 且 无真官网)
export function needsResolve(o) {
  const ob = o.official_url && !isThirdParty(o.official_url) ? o.official_url : (o.url || null);
  if (ob && !isThirdParty(ob) && !isTrustedPlatform(ob)) return false; // 出站已是男主本站
  return ob != null;
}