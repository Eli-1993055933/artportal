// _tmp-cn-stats.mjs —— 统计国内(cn)未截止机会基线
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const db = JSON.parse(readFileSync(DATA, "utf8"));
const today = "2026-08-24";
const list = db.opportunities || [];
const cn = list.filter(r => String(r.country_zh || "").includes("中国"));
// status 判定:仅认可未闭/未过期的。避免把 dead/expired 当可投
const alive = s => !s || /open|ongoing|call|征稿|active|null/i.test(String(s)) || !/expired|dead|closed|clos|end/i.test(String(s));
const open = cn.filter(r => {
  if (r.status && /expired|dead|closed/i.test(String(r.status))) return false;
  if (r.deadline == null) return true;          // 未注明截止 → 视为可投
  return String(r.deadline) >= today;
});
const cnMainland = cn.filter(r => {
  const dom = String(r.domain || "").toLowerCase();
  const org = String(r.org_zh || "");
  const isHKorMOorTW = /hkadc|cstb\.gov\.hk|fdc\.gov\.mo|ncafroc\.org\.tw|\.com\.mo|\.org\.hk/.test(dom) || /澳门|香港|台灣|臺灣|台湾/.test(org);
  return !isHKorMOorTW;
});
const openMainland = open.filter(r => cnMainland.includes(r));
const openList = open.map(r => `${r.title_zh} | dl=${r.deadline || "未注明"} | ${r.domain} | ${r.trust} | ${r.status}`);
console.log(`总记录: ${list.length}`);
console.log(`中国大陆源(country_zh含中国): ${cn.length}`);
console.log(`国内未截止(含港澳台): ${open.length}`);
console.log(`内地未截止: ${openMainland.length}`);
console.log(`--- 国内未截止清单 ---`);
console.log(openList.join("\n"));