// _tmp-probe25.mjs —— artistcommunities.org 更多目录 + 其他平台补充
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

// 检查 artistcommunities 更多目录
const acUrls = [
  "https://artistcommunities.org/residencies",
  "https://artistcommunities.org/residencies?page=1",
  "https://artistcommunities.org/residencies?page=2",
  "https://artistcommunities.org/residencies?page=3",
  "https://artistcommunities.org/residencies?page=4",
  "https://artistcommunities.org/residencies?page=5",
  "https://artistcommunities.org/search?type=residency",
  "https://artistcommunities.org/search?type=retreat",
  "https://artistcommunities.org/programs",
];
for (const url of acUrls) {
  const f = await fetchSource({ id: "ac-"+url.split("/").pop(), domain: "artistcommunities.org", url, type: "html", org_zh: "Artist Communities" }, null);
  if (f.skipped) { console.log(`ac-${url.split("/").pop().slice(0,30)} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artistcommunities.org", { cap: 30 });
  const detail = links.filter(l => /\/residencies\//.test(l.url));
  console.log(`${url.split("/").pop().slice(0,30)} | HTTP ${f.httpStatus ?? f.status} | 驻留详情 ${detail.length}`);
}

// 检查 current data 中来自 artistcommunities 的驻留列表中是否有更多分页
console.log("\nartistcommunities 探测完成");