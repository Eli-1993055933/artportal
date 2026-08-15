// _tmp-probe41.mjs —— artquest 分页 URL 排查
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const urls = [
  ["aq-opps", "https://artquest.org.uk/opportunities/"],
  ["aq-opps-2", "https://artquest.org.uk/opportunities/page/2/"],
  ["aq-opps-page2", "https://artquest.org.uk/opportunities?page=2"],
  ["aq-opps-call", "https://artquest.org.uk/opportunities?type=calls"],
  ["aq-opps-res", "https://artquest.org.uk/opportunities?type=residencies"],
];

for (const [id, url] of urls) {
  const f = await fetchSource({ id, domain: "artquest.org.uk", url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artquest.org.uk", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 机会详情 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 3).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
