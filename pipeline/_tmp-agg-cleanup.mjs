// _tmp-agg-cleanup.mjs —— 清理本轮聚合门户新增条目中的垃圾/重复(仅动 source_note==="平台转载·非官网直采" 的条目)
//   ① 删「导航标签页」垃圾(xingxiancn 的 article?catID=xx 关键词列表被当成征集)
//   ② 同一条比赛被门户拆成多页(如 ogdcn「作品征集公告丨X」与「X」、「15天倒计时…X」与「X」)→ 归一标题判重,留标题最短最干净的一条
//   ③ 去标题尾部门户水印(如「_艺赛中国」「 -艺赛中国」)
// 不碰任何其它条目。加 --apply 才写回。
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const APPLY = process.argv.includes("--apply");

// 归一键:去机构前缀(到 : : 丨 |)、去门户水印、只留 CJK+字母数字
function key(s) {
  return String(s || "")
    .replace(/^\s*(作品征集公告|征集公告|征稿|倒计时|公告)\s*[丨|:：]\s*/g, "")
    .replace(/\s*[-—_]\s*艺赛中国\s*$/g, "")
    .replace(/^\d{1,3}\s*天倒计时[！!]*/g, "")
    .replace(/^\d{1,2}月\d{1,2}日截稿[！!]*/g, "")
    .replace(/^\s*20\d{2}\s*[-—·]?\s*/g, "")     // 去掉开头年份(跨站同赛事:「2026紫艺奖…」vs「紫艺奖…」)
    .replace(/[\s\u3000\p{P}\p{S}]/gu, "")
    .toLowerCase().slice(0, 40);
}
function cleanTitle(s) {
  return String(s || "").replace(/\s*[-—_]\s*艺赛中国\s*$/, "").trim();
}
// 导航标签垃圾:标题里用下划线堆了 3+ 个「xx大赛/征集」关键词,且 URL 是栏目页
function isNavJunk(o) {
  const t = o.title_zh || "";
  return (t.split("_").length >= 3) && /(征集|大赛)/.test(t);
}

async function main() {
  const doc = JSON.parse(await readFile(DATA, "utf8"));
  const all = doc.opportunities || [];
  const isNew = o => o.source_note === "平台转载·非官网直采";
  const news = all.filter(isNew);

  const removed = new Set();          // id 集合
  const tided = [];

  // ③ 去水印
  for (const o of news) {
    const c = cleanTitle(o.title_zh);
    if (c && c !== o.title_zh) { if (APPLY) o.title_zh = c; tided.push([o.title_zh, c]); }
  }
  // ① 导航垃圾
  for (const o of news) if (isNavJunk(o)) removed.add(o.id);
  // ② 归一判重(只在未删的条目里)
  const groups = new Map();
  for (const o of news) {
    if (removed.has(o.id)) continue;
    const k = key(o.title_zh || o.title_en || "");
    if (!k || k.length < 12) continue;   // 归一后太短的不参与合并,避免误杀两个不同的短赛事名
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const dupPairs = [];
  for (const [k, arr] of groups) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => (a.title_zh || "").length - (b.title_zh || "").length);
    for (let i = 1; i < arr.length; i++) { removed.add(arr[i].id); dupPairs.push([arr[0].title_zh, arr[i].title_zh]); }
  }

  console.log("本批新增条目:", news.length, "| 去水印:", tided.length, "| 删导航垃圾+重复:", removed.size);
  console.log("\n-- 删除明细 --");
  for (const o of news) if (removed.has(o.id)) console.log("  ✗", (o.title_zh || "").slice(0, 44), "|", o.url);
  console.log("\n-- 判重保留 --");
  dupPairs.forEach(([keep, drop]) => console.log("  ✓", keep.slice(0, 40), "  ← 弃:", drop.slice(0, 40)));

  if (APPLY && removed.size) {
    doc.opportunities = all.filter(o => !removed.has(o.id));
    doc.count = doc.opportunities.length;
    doc.generated_at = new Date().toISOString().slice(0, 10);
    const tmp = DATA + ".tmp-" + process.pid;
    await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
    await rename(tmp, DATA);
    console.log("\n已写回,总数:", doc.count);
  } else {
    console.log("\n(未写回;加 --apply 生效)");
  }
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });