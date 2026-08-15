// _tmp-probe1000h.mjs —— 冲刺 1000 最终候选: 更多国际目录/聚合
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, u, domain, linkRe, skipRe, cap = 100) {
  try {
    const f = await fetchSource({ id: "t", domain, url: u, type: "html" }, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
    const links = discoverDetailLinks(f.rawHtml, u, domain, { cap });
    const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
    const fresh = detail.filter(l => !urls.has(l.url));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length}`);
    fresh.slice(0, 6).forEach(l => console.log(`    ${l.url.slice(0, 105)}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

// 高价值国际平台(继续)
await page('yicca', 'https://yicca.org/en/contest', 'yicca.org', /\/en\/contest\/(artwork|open-call|contest)/, /yicca\.org\/en\/contest$/);
await page('open-calls', 'https://www.opencalls.org/', 'opencalls.org', /\/[a-z0-9-]+/);
await page('callforentry2', 'https://callforentry.org/', 'callforentry.org', /\/[a-z0-9-]+/);
await page('artopptunity', 'https://www.artopptunity.com/', 'artopptunity.com', /\/[a-z0-9-]+/);
await page('creative-opps', 'https://www.creative-opps.com/', 'creative-opps.com', /\/[a-z0-9-]+/);
await page('the-artists', 'https://www.the-artists.org/', 'the-artists.org', /\/[a-z0-9-]+/);
await page('artcall2', 'https://www.artcall.xyz/', 'artcall.xyz', /\/[a-z0-9-]+/);
await page('international-artist', 'https://www.international-artist.org/', 'international-artist.org', /\/[a-z0-9-]+/);
await page('artguide', 'https://artguide.art/', 'artguide.art', /\/[a-z0-9-]+/);
await page('artistresidencies', 'https://artistresidencies.com/', 'artistresidencies.com', /\/[a-z0-9-]+/);
