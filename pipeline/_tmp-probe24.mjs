// _tmp-probe24.mjs —— ArtConnect 所有 type 类别探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const types = ["residency", "open_call", "award", "grant", "exhibition", "competition", "biennale", "fellowship", "artist-in-residence", "call-for-artists", "call-for-entry"];
for (const t of types) {
  for (const p of [1, 2]) {
    const url = `https://www.artconnect.com/opportunities?type=${t}&page=${p}`;
    const f = await fetchSource({ id: `ac-${t}-${p}`, domain: "artconnect.com", url, type: "html", org_zh: "ArtConnect" }, null);
    if (f.skipped) { console.log(`${t}-p${p} | SKIPPED (${f.reason})`); continue; }
    const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 20 });
    const detail = links.filter(l => /\/opportunity\//.test(l.url));
    if (p === 1) console.log(`${t}-p${p} | HTTP ${f.httpStatus ?? f.status} | 机会 ${detail.length}`);
  }
}
console.log("type 探测完成");
