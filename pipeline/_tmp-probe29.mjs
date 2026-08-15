// _tmp-probe29.mjs —— TheArtList 单页类别深分页探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const cats = {
  "grants-scholarships": "grants",
  "residencies": "residencies",
  "rfps": "rfps",
  "jobs-internships": "jobs",
  "fairs-festivals": "fairs",
  "workshops": "workshops",
};

for (const [cat, name] of Object.entries(cats)) {
  for (let p = 1; p <= 4; p++) {
    const url = p === 1 ? `https://www.theartlist.com/category/${cat}` : `https://www.theartlist.com/category/${cat}?page=${p}`;
    const f = await fetchSource({ id: `tl-${name}-p${p}`, domain: "theartlist.com", url, type: "html" }, null);
    if (f.skipped) { console.log(`${name}-p${p} | SKIPPED (${f.reason})`); continue; }
    const links = discoverDetailLinks(f.rawHtml, url, "theartlist.com", { cap: 30 });
    const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url) && /\/opportunity\//.test(l.url));
    console.log(`${name}-p${p} | HTTP ${f.httpStatus ?? f.status} | 机会详情 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  }
}
