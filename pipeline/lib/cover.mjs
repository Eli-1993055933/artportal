// cover.mjs —— 从页面 HTML 提取"封面图"地址(og:image 等),供卡片使用。
//
// 只提取【页面自己指定的分享预览图】,不做截图、不搬运。返回绝对 URL 或 null。
// 版权:这相当于社交平台的链接预览缩略图;前端以热链方式加载,失败则退回色块。

// 从 <meta>/<link> 里找封面图候选,按优先级返回第一个绝对 URL。
export function extractCover(html, baseUrl) {
  const s = String(html || "");
  const pick = (re) => { const m = re.exec(s); return m ? m[1].trim() : null; };

  // 优先级:og:image:secure_url > og:image > twitter:image > itemprop image > link image_src
  const candidates = [
    pick(/<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i),
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i),
    pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i),
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i),
    pick(/<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i),
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i),
    pick(/<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i),
    pick(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)
  ].filter(Boolean);

  if (!candidates.length) return null;
  let url = candidates[0];
  try { url = new URL(url, baseUrl).href; } catch (e) { return null; }
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

// 从正文里提取候选图片(当页面没有可用 og:image 时的兜底)。
// 返回按文档顺序去重的绝对 URL 数组,已滤掉 logo/图标/头像/占位等。
export function extractContentImages(html, baseUrl) {
  const s = String(html || "");
  const out = [];
  const seen = new Set();
  const bad = /(logo|favicon|sprite|avatar|placeholder|blank|spacer|pixel|1x1|loading|icon|button|social|share[-_]|wechat|weixin|qrcode|erweima|footer|header[-_]bg)/i;
  const re = /<img\b[^>]*?\b(?:data-src|data-original|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    let raw = m[1].trim();
    if (!raw || raw.startsWith("data:")) continue;
    if (bad.test(raw)) continue;
    // 尺寸提示过滤:width/height 明确很小的跳过
    const tag = m[0];
    const wm = /\bwidth\s*=\s*["']?(\d+)/i.exec(tag);
    const hm = /\bheight\s*=\s*["']?(\d+)/i.exec(tag);
    if ((wm && +wm[1] < 200) || (hm && +hm[1] < 150)) continue;
    let abs;
    try { abs = new URL(raw, baseUrl).href; } catch (e) { continue; }
    if (!/^https?:\/\//i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
    if (out.length >= 8) break;
  }
  return out;
}

// 判断是否"疑似通用图"(站点 logo / 占位 / 默认分享图)——只认明显特征,避免误杀真封面。
// 注意:不要用宽泛的 "default"(会误伤 Drupal 的 /sites/default/files/ 上传目录)。
export function looksGeneric(coverUrl, domain) {
  if (!coverUrl) return true;
  const u = coverUrl.toLowerCase();
  if (/(logo_fb|favicon|placeholder|sprite|og[_-]default|share[_-]default|default[_-](og|share))/.test(u)) return true;
  if (/\/logos?\//.test(u)) return true;                          // .../images/logos/...
  if (/\blogo\b/.test(u) && !/(upload|files|media|photo|img|image|cdn)/.test(u)) return true;
  return false;
}
