// _tmp-probe56.mjs —— resartis open-calls + on-the-move 可收割性
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, url, domain, linkRe, skipRe) {
  const f = await fetchSource({ id: "t", domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 80 });
  const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
  const fresh = detail.filter(l => !urls.has(l.url));
  console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length} | 文本 ${f.text?.length ?? 0}`);
  fresh.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}

await page("resartis-opencalls", "https://resartis.org/open-calls/", "resartis.org", /\/open-call\//, null);
await page("otm-countries", "https://on-the-move.org/news/countries", "on-the-move.org", /\/news\//, /\/news\/countries/);
await page("otm-all", "https://on-the-move.org/news", "on-the-move.org", /\/news\//, /\/news\/countries|\/news\?/);
