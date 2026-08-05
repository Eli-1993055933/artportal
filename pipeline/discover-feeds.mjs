// discover-feeds.mjs —— 给 sources.json 的 html 信源自动发现 RSS/Atom feed(v1.3.0)。
//
// 背景:209 个信源里 207 个是 HTML 页面扫描、真正接 RSS 的只有 1 个;RSS 增量推送比页面扫描
// 漏抓少、解析稳、成本低。本脚本探测两类线索,原则保守、绝不冒进:
//   ① 页面 <link rel="alternate" type="rss/atom"> 声明的 feed —— 它就是【这个列表页】的推送,
//      验证能解析出条目后【自动切换】type:"rss"(原 url 保留,可随时切回);
//   ② 根路径猜测(/feed /rss.xml /atom.xml /index.xml)—— 站级 feed 覆盖面可能与目标栏目页
//      不一致(如只推新闻不推公告),切过去可能丢覆盖,所以只记 rss_hint 字段供人工评估,不切换。
// 抓取走 fetchSource(robots 遵守 + 同域限速 + 署名 UA),与管道同一套合规。
//
// 用法: node --env-file=.env discover-feeds.mjs [--dry]

import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(__dir, "sources.json");
const DRY = process.argv.includes("--dry");
const CONC = 6;
const today = new Date().toISOString().slice(0, 10);

// 从页面 HTML 抽 <link> 声明的 feed(相对路径按页面 URL 解析)
function feedLinksOf(html, pageUrl) {
  const out = [];
  for (const m of String(html || "").matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate["']?/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag);
    if (!href) continue;
    try { out.push(new URL(href[1], pageUrl).href); } catch (e) {}
  }
  return [...new Set(out)];
}

// 验证 feed:真能抓到且解析出至少 1 条 item 才算数
async function validFeed(url, domain) {
  try {
    const r = await fetchSource({ url, rss: url, domain, type: "rss" });
    if (r.skipped) return false;
    return /标题: /.test(r.text || "");   // rssToText 逐条输出「标题: …」,有它=至少解析出一条
  } catch (e) { return false; }
}

const data = JSON.parse(await readFile(SRC_PATH, "utf8"));
const list = (data.sources || []).filter(s => s.type === "html" && s.url);
console.log(`共 ${data.sources.length} 个信源,待探测 html 信源 ${list.length} 个(--dry=${DRY})`);

let done = 0, switched = 0, hinted = 0, failed = 0;
const queue = list.slice();
async function worker() {
  while (queue.length) {
    const s = queue.shift();
    let tag = "";
    try {
      const page = await fetchSource({ url: s.url, domain: s.domain, type: "html" });
      if (page.skipped) { tag = "页面抓取跳过:" + page.reason; failed++; }
      else {
        // ① 页面声明的 feed → 验证后切换
        const declared = feedLinksOf(page.rawHtml, page.finalUrl || s.url);
        let hit = null;
        for (const f of declared.slice(0, 2)) { if (await validFeed(f, s.domain)) { hit = f; break; } }
        if (hit) {
          s.type = "rss"; s.rss = hit;
          s.notes = (s.notes ? s.notes + " | " : "") + `RSS自动发现(页面声明,${today}),原url保留可切回`;
          switched++; tag = "✚ 切换RSS " + hit;
        } else {
          // ② 根路径猜测 → 只记 hint
          const origin = new URL(s.url).origin;
          for (const g of ["/feed", "/rss.xml", "/atom.xml", "/index.xml"]) {
            if (await validFeed(origin + g, s.domain)) { s.rss_hint = origin + g; hinted++; tag = "? 站级feed提示 " + origin + g; break; }
          }
          if (!tag) tag = "无feed";
        }
      }
    } catch (e) { tag = "错误:" + String(e.message || e).slice(0, 40); failed++; }
    done++;
    console.log(`[${done}/${list.length}] ${s.id} ${tag}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

console.log(`\n完成:切换RSS ${switched} 个 · 站级feed提示 ${hinted} 个 · 抓取失败 ${failed} 个`);
if (!DRY && (switched || hinted)) {
  await writeFile(SRC_PATH + ".tmp", JSON.stringify(data, null, 2), "utf8");
  await rename(SRC_PATH + ".tmp", SRC_PATH);
  console.log("已写回 sources.json");
} else if (DRY) {
  console.log("(--dry 未写回)");
}
