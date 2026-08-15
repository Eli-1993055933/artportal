// _tmp-probe53.mjs —— artenda 各类型目录
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["artenda-all", "https://artenda.net/", "artenda.net"],
  ["artenda-exh", "https://artenda.net/art-open-call-opportunity/exhibition", "artenda.net"],
  ["artenda-grant", "https://artenda.net/art-open-call-opportunity/grant", "artenda.net"],
  ["artenda-award", "https://artenda.net/art-open-call-opportunity/award", "artenda.net"],
  ["artenda-fellowship", "https://artenda.net/art-open-call-opportunity/fellowship", "artenda.net"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 40 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 6).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
