// _tmp-probe49.mjs —— 更多国际机会目录探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["artguide", "https://artguide.com/calls", "artguide.com"],
  ["artur", "https://artur.org/", "artur.org"],
  ["kaunas", "https://www.kaunasbiennial.com/", "kaunasbiennial.com"],
  ["artsscientific", "https://www.artsscientific.org/opportunities", "artsscientific.org"],
  ["artful", "https://www.artful.ly/calls", "artful.ly"],
  ["culture360", "https://culture360.asef.org/opportunities/", "culture360.asef.org"],
  ["creativeeurope", "https://culture.ec.europa.eu/creative-europe/calls-for-proposals", "ec.europa.eu"],
  ["artresidency", "https://www.artresidency.org/", "artresidency.org"],
  ["artistcall", "https://artistcall.org/", "artistcall.org"],
  ["artopps2", "https://www.art-opportunities.org/", "art-opportunities.org"],
  ["callforart", "https://callforart.org/", "callforart.org"],
  ["artlance", "https://www.artlance.com/opportunities", "artlance.com"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
