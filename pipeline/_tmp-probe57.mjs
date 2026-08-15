// _tmp-probe57.mjs —— 新一轮高产平台探测
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, url, domain, linkRe, skipRe) {
  try {
    const f = await fetchSource({ id: "t", domain, url, type: "html" }, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
    const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 80 });
    const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
    const fresh = detail.filter(l => !urls.has(l.url));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length} | 文本 ${f.text?.length ?? 0}`);
    fresh.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

await page("artopps", "https://artopps.co.uk/", "artopps.co.uk", /\/opportunities\//, null);
await page("colossal-opps", "https://www.thisiscolossal.com/opportunities/", "thisiscolossal.com", null, null);
await page("sharjah-oc", "https://www.sharjahart.org/en/open-calls/", "sharjahart.org", null, null);
await page("artenda-p2", "https://artenda.net/art-open-call-opportunity/residency/page/2/", "artenda.net", null, null);
await page("artenda-award", "https://artenda.net/art-open-call-opportunity/award", "artenda.net", null, null);
await page("e-flux-p2", "https://www.e-flux.com/announcements/?page=2", "e-flux.com", /\/announcements\/\d+\//, null);
await page("e-flux-p3", "https://www.e-flux.com/announcements/?page=3", "e-flux.com", /\/announcements\/\d+\//, null);
