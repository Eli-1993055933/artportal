// _tmp-probe1000d.mjs —— ArtConnect 聚合子页深挖 + 其他新平台
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

// ArtConnect 聚合子页(探测时发现 2 个详情指向它们)
await page('ac-cfe', 'https://www.artconnect.com/opportunities/calls-for-entry', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/, /opportunities\/(calls-for-entry|opencalls|opportunities)$/);
await page('ac-oc', 'https://www.artconnect.com/opportunities/opencalls', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/, /opportunities\/(calls-for-entry|opencalls|opportunities)$/);
// ArtConnect 用 types= 参数的正确分页(之前 types=OPEN_CALL 有效)
await page('ac-types', 'https://www.artconnect.com/opportunities?types=OPEN_CALL', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/, /opportunities\/(calls-for-entry|opencalls|opportunities)$/);

// artistopportunities.xyz(新目录平台)
await page('ao-home', 'https://artistopportunities.xyz/', 'artistopportunities.xyz', /\/[a-z0-9-]+\//);
await page('ao-res', 'https://artistopportunities.xyz/category/residencies/', 'artistopportunities.xyz', /\/[a-z0-9-]+\//);
