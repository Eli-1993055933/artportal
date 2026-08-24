// _tmp-cn-stats2.mjs —— 更宽松但严谨的内地可投口径盘点
// 判定"内地可投":域名/机构非港澳台 + 非expired/dead/closed + 截止未过
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const db = JSON.parse(readFileSync(DATA, "utf8"));
const today = "2026-08-24";
const list = db.opportunities || [];

const isHKorMOorTW = r => {
  const dom = String(r.domain || "").toLowerCase();
  const org = String(r.org_zh || "");
  return /hkadc|cstb\.gov\.hk|fdc\.gov\.mo|ncafroc\.org\.tw|\.com\.mo|\.org\.hk|\.gov\.tw|\.org\.tw/.test(dom)
    || /澳门|香港|台灣|臺灣|台湾/.test(org);
};
// 内地判定:短域名带 .cn / gov.cn / edu.cn / org.cn 或域名/org 含明确内地信号,或 country_zh 含中国
const isMainland = r => {
  if (isHKorMOorTW(r)) return false;
  const dom = String(r.domain || "").toLowerCase();
  const org = String(r.org_zh || "");
  const cnty = String(r.country_zh || "");
  if (/\..*(\.cn|\.cn\.)$/.test(dom) || /\.cn$/.test(dom) || /.+\.cn$/.test(dom)) return true;
  if (/中国大陆|中国$|内&quot;|北京|上海|广东|江|浙|天|重|四|湖|湖|山|陕|安徽|福建|广西|云南|海南|山西|辽|吉|黑龙江|河南|河北|内蒙|贵州|甘肃|青海|宁夏|新疆|西藏/.test(org)) return true;
  return cnty.includes("中国");
};
const alive = r => !(r.status && /expired|dead|closed/i.test(String(r.status)))
  && (r.deadline == null || String(r.deadline) >= today);

const mainlandAlive = list.filter(r => isMainland(r) && alive(r));
const totalMainland = list.filter(isMainland);

// 按 status/类别全景
const bycat = {};
for (const r of mainlandAlive) { const c = r.category || "未分类"; bycat[c] = (bycat[c] || 0) + 1; }

console.log(`总记录: ${list.length}`);
console.log(`内地机会(全部,含过/闭): ${totalMainland.length}`);
console.log(`内地未截止可投: ${mainlandAlive.length}`);
console.log(`--- 按类别 ---`);
for (const [c, n] of Object.entries(bycat).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${c}`);
console.log(`\n--- 内地未截止清单 ---`);
for (const r of mainlandAlive)
  console.log(`${r.title_zh} | dl=${r.deadline || "未注明"} | ${r.category || "?"} | ${r.domain} | ${r.trust} | ${r.status}`);