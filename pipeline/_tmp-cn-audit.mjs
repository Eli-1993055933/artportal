import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const db = JSON.parse(readFileSync(DATA, "utf8"));
const t = "2026-08-24";
const isHK = d => /hkadc|cstb\.gov\.hk|fdc\.gov\.mo|ncafroc\.org\.tw|com\.mo|org\.hk|gov\.tw|org\.tw/.test(d);
const isMain = r => !isHK(String(r.domain || "")) && !/澳门|香港|台|港/.test(String(r.org_zh || ""))
  && (/(\.cn)$/.test(String(r.domain || "")) || /^https?:\/\/(www\.)?[a-z0-9.-]+\.cn\//i.test(String(r.url || "")));
const alive = r => !(r.status && /expired|dead|closed/i.test(String(r.status)))
  && (r.deadline == null || String(r.deadline) >= t);
const list = (db.opportunities || []).filter(r => isMain(r) && alive(r));
const bad = list.filter(r => /入会细则|志愿者|成立70周年|独家记忆|征稿平台|个人会员|申办程序|答申报者问|收藏史|博物馆展览申办/.test(String(r.title_zh || "") + String(r.title_en || "")));
console.log("内地未截止:", list.length);
console.log("可疑非机会条目数:", bad.length);
for (const r of bad) console.log(" -", r.title_zh, "|", r.domain);
console.log("--- 无明确截止日期的条目(长期开放) ---");
list.filter(r => r.deadline == null).forEach(r => console.log(" +", r.title_zh, "|", r.domain, "|", r.category, "|", r.status));