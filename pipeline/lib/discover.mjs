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

// 详情页 URL 常见特征:含日期/长数字/文章 id
function looksLikeDetail(u) {
  const p = u.pathname + u.search;
  return (
    /\/\d{4,}[\/_-]/.test(p) ||            // /2026/ 或 /202606/
    /\d{6,}\.s?html?$/i.test(p) ||          // 90233266.htm
    /[?&]id=\d+/.test(p) ||                 // ?id=9815
    /\/t\d{6,}/.test(p) ||                  // /t20260324_...
    /info\/\d+\/\d+\.htm/i.test(p) ||       // info/1156/130711.htm
    /\/art\/\d+/.test(p)
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
    if (!looksLikeDetail(u)) continue;
    const key = u.href.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ url: key, text: a.text });
    if (results.length >= cap) break;
  }
  return results;
}

export { extractAnchors };
