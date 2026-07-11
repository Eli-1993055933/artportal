// backfill-covers.mjs —— 给现有 opportunities.json 回填封面图(og:image)。
// 纯确定性:抓详情页 → 提 og:image → 校验图片可加载 → 写入 cover 字段。
// 用法:node backfill-covers.mjs
import { readFile, writeFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { extractCover, looksGeneric } from "./lib/cover.mjs";

const DATA = new URL("../site/data/opportunities.json", import.meta.url);

async function validateImage(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "ArtPortalBot/0.1 (+cover check)" } });
    clearTimeout(t);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    try { res.body && res.body.cancel(); } catch (e) {}
    if (!res.ok) return false;
    if (!ct.startsWith("image/")) return false;
    if (len && len < 3000) return false; // 太小多半是 logo/像素
    return true;
  } catch (e) { return false; }
}

const doc = JSON.parse(await readFile(DATA, "utf8"));
const list = doc.opportunities;
let got = 0, generic = 0, none = 0, fail = 0;
const needSearch = [];

for (let i = 0; i < list.length; i++) {
  const o = list[i];
  if (!o.url) { none++; continue; }
  process.stderr.write(`[${i + 1}/${list.length}] ${o.title_zh.slice(0, 20)} … `);
  const f = await fetchSource({ url: o.url, domain: o.domain, type: "html" });
  if (f.skipped) { process.stderr.write("抓取跳过 " + f.reason + "\n"); fail++; needSearch.push(o.id); continue; }
  const cover = extractCover(f.rawHtml, o.url);
  if (!cover) { process.stderr.write("无 og:image\n"); none++; needSearch.push(o.id); continue; }
  const ok = await validateImage(cover);
  if (!ok) { process.stderr.write("图片校验失败\n"); fail++; needSearch.push(o.id); continue; }
  const gen = looksGeneric(cover, o.domain);
  o.cover = cover;
  o.cover_source = o.domain;
  o.cover_generic = gen || undefined;
  if (gen) { generic++; needSearch.push(o.id); process.stderr.write("✓ 但疑似通用图(待联网另找)\n"); }
  else { got++; process.stderr.write("✓ 封面\n"); }
}

doc.generated_at = doc.generated_at;
await writeFile(DATA, JSON.stringify(doc, null, 2), "utf8");
console.log("\n===== 封面回填结果 =====");
console.log("贴切封面 got:", got, "| 疑似通用(需联网另找):", generic, "| 无 og:image:", none, "| 抓取/校验失败:", fail);
console.log("需要联网检索封面的 id 数:", needSearch.length);
console.log(JSON.stringify(needSearch));
