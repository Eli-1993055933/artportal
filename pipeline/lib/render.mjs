// render.mjs —— 无头浏览器渲染 JS 页面(仅用于 fetchSource 判定为 SPA 空壳的极少数官网,如上海双年展)。
// 合规铁律与 fetch.mjs 完全一致:调用方已经过 robots + 同域限速检查,这里只负责渲染。
// 同一进程内复用一个浏览器实例(懒加载),管道跑完记得调 closeBrowser() 让进程能正常退出。

import { UA_TOKEN } from "./robots.mjs";

const USER_AGENT =
  `${UA_TOKEN}/0.1 (+ArtPortal art-opportunity aggregator; official sites and public RSS only; contact: atsang799@gmail.com)`;

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = import("puppeteer").then(({ default: puppeteer }) =>
      puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox", "--disable-setuid-sandbox",
          "--disable-gpu", "--disable-gpu-compositing",
          "--disable-dev-shm-usage",
          // 规避 Windows 沙箱对 GPU 缓存目录(NVIDIA DXCache)的写限制
          "--disable-direct-composition", "--disable-software-rasterizer",
          "--use-gl=swiftshader", "--disable-features=Vulkan,AngleSystemLayer,DirectComposition"
        ],
        env: Object.assign({}, process.env, { DISABLE_NVIDIA_GPU: "1" })
      })
    );
  }
  return browserPromise;
}

// 渲染一个页面,返回与 rawFetch 同形状的 { ok, status, body, url }
export async function renderPage(url, { timeout = 25000, settleMs = 1500 } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    const res = await page.goto(url, { waitUntil: "networkidle2", timeout });
    await new Promise(r => setTimeout(r, settleMs));   // 给首屏后的异步内容多一点渲染时间
    const body = await page.content();
    return { ok: res ? res.ok() : true, status: res ? res.status() : 200, body, url: page.url() };
  } finally {
    await page.close();
  }
}

// 截图(v1.2.0):渲染后整页视口截 JPEG,与 mShots 同规格(默认 1000x750,4:3 适配卡片封面)。
// 返回 { ok, bytes };体积过小(占位/近空白)判失败,与 lib/screenshot.mjs 同一把尺子,宁缺毋滥。
export async function screenshotPage(url, outPath, { w = 1000, h = 750, timeout = 25000, settleMs = 1200, minBytes = 14000 } = {}) {
  const { writeFile } = await import("node:fs/promises");
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    // networkidle2 超时不放弃(v1.2.1):重资源/带轮询的站永远安静不下来,但首屏早就渲染完了——
    // 首轮实测 279 条里 113 条失败大半是这种。超时就直接截当前画面,空白页会被下面的体积闸拒掉。
    try { await page.goto(url, { waitUntil: "networkidle2", timeout }); }
    catch (e) { if (!/timeout/i.test(String(e && e.name || e))) throw e; }
    await new Promise(r => setTimeout(r, settleMs));
    const buf = await page.screenshot({ type: "jpeg", quality: 72 });
    if (!buf || buf.length < minBytes) return { ok: false, bytes: buf ? buf.length : 0 };
    await writeFile(outPath, buf);
    return { ok: true, bytes: buf.length };
  } finally {
    await page.close();
  }
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise;
  await b.close();
  browserPromise = null;
}
