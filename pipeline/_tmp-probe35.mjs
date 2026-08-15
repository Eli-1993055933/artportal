// _tmp-probe35.mjs —— 复数 types 全枚举 + 有效枚举分页深度
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const types = [
  "OPEN_CALL", "RESIDENCY", "AWARD", "GRANT", "FELLOWSHIP",
  "COMPETITION", "EXHIBITION", "BIENNALE", "COMMISSION", "JOB",
  "PROJECT", "WORKSHOP", "SCHOLARSHIP", "PRIZE", "PERFORMANCE",
  "PUBLICATION", "RESEARCH", "SYMPOSIUM", "RESIDENCIES", "AWARDS",
  "GRANTS", "FELLOWSHIPS", "CALLS", "OPPORTUNITIES", "ARTIST_RESIDENCY"
];

const valid = [];
for (const t of types) {
  const url = `https://www.artconnect.com/opportunities?types=${t}`;
  const f = await fetchSource({ id: `ac-${t}`, domain: "artconnect.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`${t} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`${t} | HTTP ${f.httpStatus ?? f.status} | 机会详情 ${detail.length}`);
  if (detail.length >= 3) valid.push(t);
}
console.log("有效枚举:", valid.join(","));
