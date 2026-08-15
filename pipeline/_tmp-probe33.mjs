// _tmp-probe33.mjs —— ArtConnect 单数 type= 枚举探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const types = [
  "residency", "open_call", "award", "grant", "fellowship",
  "competition", "exhibition", "biennale", "commission", "call-for-artists",
  "call-for-entry", "artist-in-residence", "job", "project", "workshop",
  "scholarship", "prize", "performance", "publication", "research"
];

for (const t of types) {
  const url = `https://www.artconnect.com/opportunities?type=${t}`;
  const f = await fetchSource({ id: `ac-${t}`, domain: "artconnect.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`${t} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`${t} | HTTP ${f.httpStatus ?? f.status} | 机会详情 ${detail.length}`);
}
