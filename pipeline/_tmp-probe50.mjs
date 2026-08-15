// _tmp-probe50.mjs —— 新发现平台探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["resartis-open-calls", "https://resartis.org/open-calls/", "resartis.org"],
  ["resartis-p2", "https://resartis.org/open-calls/?sf_paged=2", "resartis.org"],
  ["rivet", "https://rivet.es/", "rivet.es"],
  ["theocp", "https://theocp.live/", "theocp.live"],
  ["fullyfunded", "https://fullyfunded-residencies.weebly.com/", "fullyfunded-residencies.weebly.com"],
  ["artenda-res", "https://artenda.net/art-open-call-opportunity/residency", "artenda.net"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 40 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 6).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
