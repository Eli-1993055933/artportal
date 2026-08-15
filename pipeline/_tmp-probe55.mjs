// _tmp-probe55.mjs —— 白名单平台可收割性 + artdeadlineslist 深挖
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, url, domain, linkRe, skipRe) {
  const f = await fetchSource({ id: "t", domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 60 });
  const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
  const fresh = detail.filter(l => !urls.has(l.url));
  console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length} | 文本 ${f.text?.length ?? 0}`);
  fresh.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}

await page("artcall", "https://artcall.org/", "artcall.org", null, null);
await page("entrythingy", "https://www.entrythingy.com/", "entrythingy.com", null, null);
await page("slideroom", "https://www.slideroom.com/", "slideroom.com", null, null);
await page("resartis", "https://resartis.org/", "resartis.org", null, null);
await page("adl-p2", "https://artdeadlineslist.com/page/2/", "artdeadlineslist.com", null, null);
await page("adl-calls", "https://artdeadlineslist.com/calls/", "artdeadlineslist.com", null, null);
