// _tmp-probe40.mjs —— artistcommunities open-calls 分页 + residencies p7+
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["ac-oc-p1", "https://artistcommunities.org/directory/open-calls", "artistcommunities.org"],
  ["ac-oc-p2", "https://artistcommunities.org/directory/open-calls?page=2", "artistcommunities.org"],
  ["ac-oc-p3", "https://artistcommunities.org/directory/open-calls?page=3", "artistcommunities.org"],
  ["ac-oc-p4", "https://artistcommunities.org/directory/open-calls?page=4", "artistcommunities.org"],
  ["ac-ongoing", "https://artistcommunities.org/directory/ongoing-open-calls", "artistcommunities.org"],
  ["ac-res-p7", "https://artistcommunities.org/residencies?page=7", "artistcommunities.org"],
  ["ac-res-p8", "https://artistcommunities.org/residencies?page=8", "artistcommunities.org"],
  ["ac-res-p9", "https://artistcommunities.org/residencies?page=9", "artistcommunities.org"],
  ["ac-res-p10", "https://artistcommunities.org/residencies?page=10", "artistcommunities.org"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
