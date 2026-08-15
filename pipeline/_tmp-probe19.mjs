// _tmp-probe19.mjs —— artjobs 各分类页详情链接数
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const cats = [
  ["call-for-artists", "opencall"], ["call-for-entries", "opencall"],
  ["notforprofit", "opencall"], ["award", "award"],
  ["competitions", "award"], ["performance", "opencall"],
  ["exhibitions", "exhibition"], ["films", "opencall"],
  ["festivals", "opencall"], ["photography", "opencall"],
  ["residencies", "residency"], ["visual-arts", "opencall"],
  ["workshops", "workshop"],
];
for (const [cat, hint] of cats) {
  const url = `https://www.artjobs.com/open-calls/${cat}`;
  const f = await fetchSource({ id: `aj-${cat}`, domain: "artjobs.com", url, type: "html", org_zh: "artjobs" }, null);
  if (f.skipped) { console.log(`${cat} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artjobs.com", { cap: 40 });
  // 真实详情 = 含 /open-calls/call- 或 /open-calls/[类型]/ 的深层 slug
  const detail = links.filter(l => /\/(call-|node\/)/.test(l.url));
  const t = (f.text||"").length;
  console.log(`${cat} | HTTP ${f.httpStatus ?? f.status} | 文本 ${t} | 真实详情 ${detail.length}`);
}
console.log("artjobs 分类探测完成");
