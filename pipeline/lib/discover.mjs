// discover.mjs —— 列表页 → 详情页链接发现。
// 从一个"通知列表页"的原始 HTML 里,找出指向【同域名】各条通知详情页的链接,
// 供 run.mjs 逐条抓取+提取。这样一个信源能产出许多条真实机会,而不是只有一条。
//
// 只做链接发现,不生成任何内容。真实与否仍由后续 verify.mjs 的 evidence 校验兜底。

// 从 HTML 提取 <a href> 及其锚文本
function extractAnchors(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = (m[2] || m[3] || m[4] || "").trim();
    const text = m[5].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (href) out.push({ href, text });
  }
  return out;
}

// 明显不是机会详情页的链接(导航/栏目/功能页),过滤掉
const NAV_NOISE = /(首页|关于|简介|章程|登录|注册|下载|地图|留言|隐私|版权|联系我们|english|返回|上一页|下一页|首\s*页|末\s*页|more|列表|index\.(s?html?|htm)$)/i;

// 锚文本像一条"机会通知标题"的特征词(简繁 + 英文)。用于兜底:
// 有些站(何香凝/港台澳机构)详情 URL 不含日期/数字 id,靠标题文本命中来发现。
const OPP_TITLE = /(征集|徵集|征稿|徵稿|徵件|徵選|征选|招募|徵求|驻留|駐留|駐村|驻地|驻校|工作坊|开放课题|開放課題|奖学金|獎學金|大奖|大獎|双年展|雙年展|三年展|open\s*call|call\s+for|补助|補助|资助|資助|奖助|獎助|徵展|徵稿|甄選|遴選|计划征|計劃徵|作品征|作品徵)/i;

// 详情页 URL 常见特征:含日期/长数字/文章 id。
// 尽量覆盖大陆/港台常见 CMS 的详情 URL 形态;宁可多抓几条,内容真伪仍由 verify.mjs 兜底。
function looksLikeDetail(u) {
  const p = u.pathname + u.search;
  return (
    /\/\d{4,}[\/_-]/.test(p) ||            // /2026/ 或 /202606/
    /\d{6,}\.s?html?$/i.test(p) ||          // 90233266.htm
    /[?&]\w*id=\d+/i.test(p) ||             // ?id= / ?NewsID= / ?InfoID= / ?contentId= 等(不分大小写)
    /[?&]n=\d+/i.test(p) ||                 // 台湾 .gov.tw:News_Content.aspx?n=1466&s=...
    /\/t\d{6,}/i.test(p) ||                 // /t20260324_...
    /info\/\d+\/\d+\.s?html?/i.test(p) ||   // info/1156/130711.htm
    /\/art\/\d+/i.test(p) ||
    /\/(h-nd|h-pd)-\d+/i.test(p) ||         // faisys/凡科 详情:h-nd-123.html
    /[_-]\d{4,}\.(s?html?|aspx|jsp|action)$/i.test(p) || // news_detail-1234.html / show-1234.aspx
    /\/\d{5,}\.(aspx|jsp|shtml|html?)$/i.test(p) ||      // 纯数字文件名详情页
    // —— 聚合平台 / 机会专属词的详情页形态 ——
    /\/announcements\/\d+/.test(p) ||       // e-flux: /announcements/612345/...
    /\/opportunity\/[\w-]{6,}/.test(p) ||   // ArtConnect: /opportunity/<id>
    /\/opportunities\/detail\/[^/]+\/\d+/.test(p) || // CuratorSpace: /opportunities/detail/<slug>/10778
    /\/(residency|residencies|open-call|call-for|announcement|opportunity|apply|application|programme)s?\/[\w%-]{4,}/i.test(p) // 机会专属词详情
  );
}

// discover(rawHtml, listUrl, domain) → [{url, text}]  同域、疑似详情、去重、限量
export function discoverDetailLinks(rawHtml, listUrl, domain, opts) {
  const cap = (opts && opts.cap) || 40;
  const base = new URL(listUrl);
  const baseDomain = String(domain || base.host).replace(/^www\./, "");
  const seen = new Set();
  const results = [];

  for (const a of extractAnchors(rawHtml)) {
    if (!a.href || /^(javascript:|mailto:|tel:|#)/i.test(a.href)) continue;
    if (NAV_NOISE.test(a.text) && a.text.length < 8) continue;
    let u;
    try { u = new URL(a.href, base); } catch (e) { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const host = u.host.replace(/^www\./, "");
    if (host !== baseDomain && !host.endsWith("." + baseDomain)) continue;   // 必须同域
    if (u.href === base.href) continue;
    // 详情判定:URL 形态命中,或(兜底)锚文本像一条机会通知标题(≥8字且含特征词)。
    // 兜底路径专为详情 URL 不规则的站(何香凝/港台澳)而设;真伪仍由 verify.mjs 兜底。
    const byText = a.text && a.text.length >= 8 && OPP_TITLE.test(a.text) && /\/[^/]/.test(u.pathname);
    if (!looksLikeDetail(u) && !byText) continue;
    const key = u.href.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ url: key, text: a.text });
    if (results.length >= cap) break;
  }
  return results;
}

export { extractAnchors, looksLikeDetail };
