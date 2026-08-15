// _tmp-probe30.mjs —— 探测更多目录平台(分散域名,便于并行)
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["artrabbit-calls", "https://artrabbit.com/calls-for-artists", "artrabbit.com"],
  ["artplanted", "https://www.artplanted.com/opportunities", "artplanted.com"],
  ["opportunitiesforartists", "https://www.opportunitiesforartists.com/", "opportunitiesforartists.com"],
  ["artandi-calls", "https://artandici.../", "artandi.com"],
  ["zentrum-fuer-kunst", "https://www.zentrum-fuer-kunst-und-medientechnologie.de/en/...", "zkm.de"],
  ["a-i-r-calls", "https://www.airberlin.../", "airberlin.de"],
  ["artconnect-calls2", "https://www.artconnect.com/calls-for-artists", "artconnect.com"],
  ["leeway", "https://www.leeway.org/opportunities", "leeway.org"],
  ["fracturedatlas", "https://www.fracturedatlas.org/site/fiscal/opportunities", "fracturedatlas.org"],
  ["artjobs-calls", "https://www.artjobs.com/open-calls/call-for-artists", "artjobs.com"],
  ["artjobs-entries", "https://www.artjobs.com/open-calls/call-for-entries", "artjobs.com"],
  ["artjobs-award", "https://www.artjobs.com/open-calls/award", "artjobs.com"],
  ["artjobs-comp", "https://www.artjobs.com/open-calls/competitions", "artjobs.com"],
  ["artjobs-exh", "https://www.artjobs.com/open-calls/exhibitions", "artjobs.com"],
  ["wooloo", "https://www.wooloo.org/calls", "wooloo.org"],
  ["artconnect-opps-p2", "https://www.artconnect.com/opportunities?page=2", "artconnect.com"],
  ["transartists-calls2", "https://www.transartists.org/en/calls/type/call-for-artists", "transartists.org"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
