// _tmp-probe1000c.mjs —— 第三波冲刺候选: transartists / e-flux / chinaresidencies / artenda 深挖
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

// transartists(库里仅 8 条,还有空间)
await page('ta-calls', 'https://www.transartists.org/en/transartists-calls', 'transartists.org', /\/transartists-calls\/[a-z0-9-]+/, /transartists-calls$/);
await page('ta-calls2', 'https://www.transartists.org/en/transartists-calls?page=1', 'transartists.org', /\/transartists-calls\/[a-z0-9-]+/, /transartists-calls$/);

// e-flux(库中 e-flux 相关)
await page('eflux-ann', 'https://www.e-flux.com/announcements/', 'e-flux.com', /\/announcements\/\d+\//);

// chinaresidencies(目录)
await page('cr-dir', 'https://www.chinaresidencies.com/residencies', 'chinaresidencies.com', /\/residenc/);

// artenda(库中 12 条)
await page('artenda-home', 'https://artenda.net/', 'artenda.net', /artenda\.net\/[0-9]+/);
await page('artenda-all', 'https://artenda.net/all-opportunities/', 'artenda.net', /artenda\.net\/[0-9]+/);

// wallarah / resartis(之前 TLS 失败,再试一次)
await page('resartis', 'https://www.resartis.org/en/residencies/', 'resartis.org', /\/en\/residenc/);
