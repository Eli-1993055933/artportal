// _tmp-probe31.mjs —— artquest 深分页 + artconnect 正确过滤参数
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  // artquest 分页
  ["aq-p1", "https://artquest.org.uk/opportunities/", "artquest.org.uk"],
  ["aq-p2", "https://artquest.org.uk/opportunities/page/2/", "artquest.org.uk"],
  ["aq-p3", "https://artquest.org.uk/opportunities/page/3/", "artquest.org.uk"],
  ["aq-p4", "https://artquest.org.uk/opportunities/page/4/", "artquest.org.uk"],
  ["aq-p5", "https://artquest.org.uk/opportunities/page/5/", "artquest.org.uk"],
  ["aq-p6", "https://artquest.org.uk/opportunities/page/6/", "artquest.org.uk"],
  ["aq-p7", "https://artquest.org.uk/opportunities/page/7/", "artquest.org.uk"],
  ["aq-p8", "https://artquest.org.uk/opportunities/page/8/", "artquest.org.uk"],
  // artconnect 可能的类型参数
  ["ac-open-call", "https://www.artconnect.com/opportunities?types=OPEN_CALL", "artconnect.com"],
  ["ac-residency", "https://www.artconnect.com/opportunities?types=RESIDENCY", "artconnect.com"],
  ["ac-award", "https://www.artconnect.com/opportunities?types=AWARD", "artconnect.com"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
