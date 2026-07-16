// screenshot.mjs —— 给一个网页 URL 拿"界面截图"(用免费的 WordPress mShots 服务,无需 key、无需装无头浏览器)。
//
// mShots 是异步生成:首次请求触发生成、返回占位 GIF;隔几秒再请求才拿到真 JPEG。
// 所以这里轮询若干次,拿到 JPEG(FF D8 magic + 体积够大)就存盘。
// 生成在本机跑(北京服务器访问该服务被 403);截好的图存到我们自己的站点目录,中国用户直接从我们服务器加载。

import { writeFile } from "node:fs/promises";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export async function captureScreenshot(url, outPath, opts = {}) {
  const w = opts.w || 1000, h = opts.h || 750;    // 4:3,适配卡片封面
  const tries = opts.tries || 8, wait = opts.wait || 9000;
  const shot = "https://s.wordpress.com/mshots/v1/" + encodeURIComponent(url) + "?w=" + w + "&h=" + h;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(shot, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        // 真截图 = JPEG 且体积够大(占位 GIF 约 8.7KB;近乎空白页 JPEG 也很小,一并挡掉)
        if (buf[0] === 0xFF && buf[1] === 0xD8 && buf.length > 14000) {
          await writeFile(outPath, buf);
          return { ok: true, bytes: buf.length, tries: i + 1 };
        }
      }
    } catch (e) { /* 超时/网络错,继续轮询 */ }
    if (i < tries - 1) await new Promise(x => setTimeout(x, wait));
  }
  return { ok: false };
}
