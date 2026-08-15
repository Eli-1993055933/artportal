// _tmp-probe1000e.mjs —— 冲刺最后 20+ 条: 未测试的国际机会聚合平台
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, u, domain, linkRe, skipRe, cap = 80) {
  try {
    const f = await fetchSource({ id: "t", domain, url: u, type: "html" }, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
    const links = discoverDetailLinks(f.rawHtml, u, domain, { cap });
    const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
    const fresh = detail.filter(l => !urls.has(l.url));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length} | 文本 ${f.text?.length ?? 0}`);
    fresh.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 105)}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

// 国际机会聚合/目录平台(此前未实探)
await page('calls-art', 'https://calls.art/', 'calls.art', /\/[a-z0-9-]+/);
await page('artopp', 'https://www.artopp.org.uk/', 'artopp.org.uk', /\/[a-z0-9-]+/);
await page('artistopendoor', 'https://artistopendoor.com/', 'artistopendoor.com', /\/[a-z0-9-]+/);
await page('opencall', 'https://opencall.io/', 'opencall.io', /\/[a-z0-9-]+/);
await page('opportunitiesart', 'https://opportunities.art/', 'opportunities.art', /\/[a-z0-9-]+/);
await page('artrabbit-deadline', 'https://www.artrabbit.com/deadlines', 'artrabbit.com', /\/deadlines\//, /artrabbit\.com\/deadlines$/);
await page('creative-opportunities', 'https://www.creative-opportunities.co.uk/', 'creative-opportunities.co.uk', /\/[a-z0-9-]+/);
await page('artjobs', 'https://artjobs.art/', 'artjobs.art', /\/[a-z0-9-]+/);
