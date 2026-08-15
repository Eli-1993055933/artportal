// _tmp-probe32.mjs —— ArtConnect 正确 types 枚举探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const types = [
  "OPEN_CALL", "RESIDENCY", "AWARD", "GRANT", "FELLOWSHIP",
  "COMPETITION", "EXHIBITION", "BIENNALE", "COMMISSION", "CALL_FOR_ENTRY",
  "ARTIST_IN_RESIDENCE", "JOB", "PROJECT", "SYMPOSIUM", "WORKSHOP",
  "RESEARCH", "PERFORMANCE", "PUBLICATION", "SCHOLARSHIP", "PRIZE"
];

for (const t of types) {
  const url = `https://www.artconnect.com/opportunities?types=${t}`;
  const f = await fetchSource({ id: `ac-${t}`, domain: "artconnect.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`${t} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`${t} | HTTP ${f.httpStatus ?? f.status} | 机会详情 ${detail.length}`);
}
