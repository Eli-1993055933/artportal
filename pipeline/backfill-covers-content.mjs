// backfill-covers-content.mjs —— 第二轮:对还没有贴切封面的条目,抓正文首图作封面。
import { readFile, writeFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { extractContentImages } from "./lib/cover.mjs";

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
    if (!res.ok || !ct.startsWith("image/")) return false;
    if (len && len < 8000) return false; // 正文图门槛高一点,避免小图标
    return true;
  } catch (e) { return false; }
}

const doc = JSON.parse(await readFile(DATA, "utf8"));
const targets = doc.opportunities.filter(o => !o.cover || o.cover_generic);
let fixed = 0; const stillNone = [];
for (let i = 0; i < targets.length; i++) {
  const o = targets[i];
  if (!o.url) { stillNone.push(o.id); continue; }
  process.stderr.write(`[${i + 1}/${targets.length}] ${o.title_zh.slice(0, 20)} … `);
  const f = await fetchSource({ url: o.url, domain: o.domain, type: "html" });
  if (f.skipped) { process.stderr.write("跳过 " + f.reason + "\n"); stillNone.push(o.id); continue; }
  const cands = extractContentImages(f.rawHtml, o.url);
  let picked = null;
  for (const c of cands) { if (await validateImage(c)) { picked = c; break; } }
  if (picked) { o.cover = picked; o.cover_source = o.domain; delete o.cover_generic; fixed++; process.stderr.write("✓ 正文图\n"); }
  else { stillNone.push(o.id); process.stderr.write("正文无可用图\n"); }
}
await writeFile(DATA, JSON.stringify(doc, null, 2), "utf8");
const withCover = doc.opportunities.filter(o => o.cover && !o.cover_generic).length;
console.log("\n===== 正文图回填 =====");
console.log("本轮新补:", fixed, "| 现有贴切封面:", withCover, "/", doc.opportunities.length);
console.log("仍无封面(需联网检索或接受色块):", stillNone.length);
console.log(JSON.stringify(stillNone));
