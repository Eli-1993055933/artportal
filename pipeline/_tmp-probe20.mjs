// _tmp-probe20.mjs —— Funds for NGOs 分页深度 + e-flux p1 详情质量 + artistcommunities 更多目录
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

// Funds for NGOs 分页
for (let p = 6; p <= 12; p++) {
  const url = `https://www.fundsforngos.org/?s=art+culture+grants&paged=${p}`;
  const f = await fetchSource({ id: `ffn-p${p}`, domain: "fundsforngos.org", url, type: "html", org_zh: "Funds for NGOs" }, null);
  if (f.skipped) { console.log(`ffn-p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "fundsforngos.org", { cap: 25 });
  const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
  console.log(`ffn-p${p} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length}`);
}

// e-flux p1 的 22 条里到底哪些是征集
const ef = await fetchSource({ id: "eflux-p1", domain: "e-flux.com", url: "https://www.e-flux.com/announcements/", type: "html", org_zh: "e-flux" }, null);
if (!ef.skipped) {
  const links = discoverDetailLinks(ef.rawHtml, "https://www.e-flux.com/announcements/", "e-flux.com", { cap: 30 });
  const real = links.filter(l => /\/announcements\/\d+/.test(l.url));
  console.log("e-flux p1 真实公告:", real.length);
  real.slice(0, 10).forEach(l => console.log("  ", l.url));
}
console.log("探测完成");
