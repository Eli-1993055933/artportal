// _tmp-probe22.mjs —— artquest.org.uk 结构 + ArtConnect p31-35 确认
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

// artquest 主列表 + 分类/分页
const aqUrls = [
  ["aq-main", "https://artquest.org.uk/opportunities/"],
  ["aq-p2", "https://artquest.org.uk/opportunities/page/2/"],
  ["aq-p3", "https://artquest.org.uk/opportunities/page/3/"],
  ["aq-p4", "https://artquest.org.uk/opportunities/page/4/"],
  ["aq-p5", "https://artquest.org.uk/opportunities/page/5/"],
  ["aq-res", "https://artquest.org.uk/opportunity-type/residency/"],
  ["aq-grant", "https://artquest.org.uk/opportunity-type/grant/"],
  ["aq-open", "https://artquest.org.uk/opportunity-type/open-call/"],
];
for (const [id, url] of aqUrls) {
  const f = await fetchSource({ id, domain: "artquest.org.uk", url, type: "html", org_zh: "ArtQuest" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artquest.org.uk", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 文本 ${(f.text||"").length} | 机会详情 ${detail.length}`);
}

// ArtConnect p31-35
for (let p = 31; p <= 35; p++) {
  const url = `https://www.artconnect.com/opportunities?page=${p}`;
  const f = await fetchSource({ id: `ac-${p}`, domain: "artconnect.com", url, type: "html", org_zh: "ArtConnect" }, null);
  if (f.skipped) { console.log(`artconnect-p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`artconnect-p${p} | HTTP ${f.httpStatus ?? f.status} | 机会 ${detail.length}`);
}
console.log("探测完成");
