// _tmp-probe47.mjs —— 更多平台探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["cs-opps-res", "https://curatorspace.com/opportunities/residency", "curatorspace.com"],
  ["cs-opps-grant", "https://curatorspace.com/opportunities/grants", "curatorspace.com"],
  ["cs-all", "https://curatorspace.com/opportunities/all", "curatorspace.com"],
  ["artopps-org", "https://www.artopps.org/", "artopps.org"],
  ["kulturserver", "https://www.kulturserver.de/-/ausschreibungen", "kulturserver.de"],
  ["artconnect-events", "https://www.artconnect.com/events", "artconnect.com"],
  ["artsy-open", "https://www.artsy.net/open-calls", "artsy.net"],
  ["cassone", "https://www.cassone.com/open-calls", "cassone.com"],
  ["artshift", "https://www.artshift.com/", "artshift.com"],
  ["artsadmin", "https://www.artsadmin.co.uk/opportunities", "artsadmin.co.uk"],
  ["transartists-all", "https://www.transartists.org/en", "transartists.org"],
  ["worldresidencies", "https://www.worldwideartistresidencies.com/", "worldwideartistresidencies.com"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
