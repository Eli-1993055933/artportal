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
