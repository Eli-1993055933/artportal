// _tmp-cn-src.mjs —— 国内未截止机会按域名分布,定位可深挖来源
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const db = JSON.parse(readFileSync(DATA, "utf8"));
const today = "2026-08-24";
const list = db.opportunities || [];
const isCN = r => String(r.country_zh || "").includes("中国");
const open = r => !(r.status && /expired|dead|closed/i.test(String(r.status))) && (r.deadline == null || String(r.deadline) >= today);
const cn = list.filter(isCN);
const openCN = cn.filter(open);
// 按域名Aggregate
const byDom = {};
for (const r of openCN) {
  const d = String(r.domain || "?").replace(/^www\./, "");
  byDom[d] = (byDom[d] || 0) + 1;
}
const sorted = Object.entries(byDom).sort((a, b) => b[1] - a[1]);
console.log(`国内(含港澳台)未截止: ${openCN.length}`);
console.log(`--- 按域名 ---`);
for (const [d, n] of sorted) console.log(`  ${String(n).padStart(3)}  ${d}`);
// artda/聚合平台明细
const keys = Object.keys(byDom);
console.log(`\n--- trusted 聚合平台贡献(artda/everyart/artconnect/art-mate) ---`);
for (const [d, n] of sorted) if (/artda|everyart|artconnect|art-mate/.test(d)) console.log(`  ${n}  ${d}`);