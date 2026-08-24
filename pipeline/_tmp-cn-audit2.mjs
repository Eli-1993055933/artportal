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

// 明确非"可投递艺术机会"的条目特征(非征稿/非奖项/非资助/非驻留/非工作坊)
const NON_OPPORTUNITY = /个人会员|入会细则|申办程序|志愿者招募|征稿平台|答申报者问|成立70周年|独家记忆|招标|招聘|采购公告|批复|公示|名录/;
const bad = mainlandAlive.filter(r => NON_OPPORTUNITY.test([r.title_zh, r.title_en].filter(Boolean).join(" ")));
console.log("内地未截止可投(基线):", mainlandAlive.length);
console.log("明显非机会(应清洗):", bad.length);
for (const r of bad) console.log("  [BAD]", r.title_zh, "|", r.domain, "|", r.category);

// 勉强算机会但价值存疑的
const weak = mainlandAlive.filter(r => /志愿者|史料征集|藏品征集|展陈物品|采访故事|回忆/.test([r.title_zh, r.title_en].filter(Boolean).join(" ")))
  .filter(r => !bad.includes(r));
console.log("价值存疑(可保留):", weak.length);
for (const r of weak) console.log("  [WEAK]", r.title_zh, "|", r.domain);

console.log("清洗明显非机会后净剩:", mainlandAlive.length - bad.length);