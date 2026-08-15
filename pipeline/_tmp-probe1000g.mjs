// _tmp-probe1000g.mjs —— 最后冲刺: artcall.org + 其他高价值目录
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
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length} | 文本 ${f.text?.length ?? 0}`);
    fresh.slice(0, 6).forEach(l => console.log(`    ${l.url.slice(0, 105)}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

// artcall.org(目录平台)
await page('artcall', 'https://artcall.org/', 'artcall.org', /\/[a-z0-9-]+/, /artcall\.org\/$/);
await page('artcall-call', 'https://artcall.org/call-for-artists', 'artcall.org', /\/[a-z0-9-]+/);

// 更多国际机会平台
await page('yicca', 'https://www.yicca.org/', 'yicca.org', /\/[a-z0-9-]+/);
await page('transartists-award', 'https://www.transartists.org/en/transartists-awards', 'transartists.org', /\/[a-z0-9-]+/);
await page('cac', 'https://www.creativeapplications.net/', 'creativeapplications.net', /\/[a-z0-9-]+/);
await page('a-n', 'https://www.a-n.co.uk/opportunities/', 'a-n.co.uk', /\/opportunities\//);
await page('artopps-org', 'https://www.artopps.org/', 'artopps.org', /\/[a-z0-9-]+/);
await page('create-opportunities', 'https://www.creativelive.com/', 'creativelive.com', /\/[a-z0-9-]+/);
await page('elephant', 'https://elephant.art/', 'elephant.art', /\/[a-z0-9-]+/);
