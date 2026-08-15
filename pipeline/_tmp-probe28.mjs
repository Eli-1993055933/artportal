// _tmp-probe28.mjs —— 探测高分平台更深分页
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  // artistcommunities.org 更多分页
  ["ac-res-p1", "https://artistcommunities.org/residencies", "artistcommunities.org", "Alliance"],
  ["ac-res-p2", "https://artistcommunities.org/residencies?page=2", "artistcommunities.org", "Alliance"],
  ["ac-res-p3", "https://artistcommunities.org/residencies?page=3", "artistcommunities.org", "Alliance"],
  ["ac-res-p4", "https://artistcommunities.org/residencies?page=4", "artistcommunities.org", "Alliance"],
  ["ac-res-p5", "https://artistcommunities.org/residencies?page=5", "artistcommunities.org", "Alliance"],
  ["ac-res-p6", "https://artistcommunities.org/residencies?page=6", "artistcommunities.org", "Alliance"],
  ["ac-programs", "https://artistcommunities.org/programs", "artistcommunities.org", "Alliance"],
  // CuratorSpace 更深分页
  ["cs-opps-p7", "https://curatorspace.com/opportunities/calls?page=7", "curatorspace.com", "CuratorSpace"],
  ["cs-opps-p8", "https://curatorspace.com/opportunities/calls?page=8", "curatorspace.com", "CuratorSpace"],
  ["cs-opps-p9", "https://curatorspace.com/opportunities/calls?page=9", "curatorspace.com", "CuratorSpace"],
];

for (const [id, url, domain, org] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html", org_zh: org }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
