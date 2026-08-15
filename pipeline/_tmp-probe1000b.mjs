// _tmp-probe1000b.mjs —— 第二波冲刺候选: ArtConnect 分类页深挖 + artistcommunities 更深
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, u, domain, linkRe, skipRe, cap = 60) {
  try {
    const f = await fetchSource({ id: "t", domain, url: u, type: "html" }, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
    const links = discoverDetailLinks(f.rawHtml, u, domain, { cap });
    const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
    const fresh = detail.filter(l => !urls.has(l.url));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length}`);
    fresh.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 100)}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

// ArtConnect 分类页(此前按 types=OPEN_CALL 有效,深挖其他类型)
await page('ac-res', 'https://www.artconnect.com/opportunities?types=RESIDENCY', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/, /opportunities\/(opencalls|calls-for-entry|opportunities)$/);
await page('ac-grant', 'https://www.artconnect.com/opportunities?types=GRANT', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/, /opportunities\/(opencalls|calls-for-entry|opportunities)$/);
await page('ac-award', 'https://www.artconnect.com/opportunities?types=AWARD', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/, /opportunities\/(opencalls|calls-for-entry|opportunities)$/);
await page('ac-calls', 'https://www.artconnect.com/opportunities?types=OPEN_CALL&page=5', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/, /opportunities\/(opencalls|calls-for-entry|opportunities)$/);

// artistcommunities residencies 更深分页(此前 p1-p18)
await page('acom-p19', 'https://www.artistcommunities.org/residencies?page=19', 'artistcommunities.org', /\/residencies\/[0-9]+/);
await page('acom-p20', 'https://www.artistcommunities.org/residencies?page=20', 'artistcommunities.org', /\/residencies\/[0-9]+/);
await page('acom-p21', 'https://www.artistcommunities.org/residencies?page=21', 'artistcommunities.org', /\/residencies\/[0-9]+/);
