// _tmp-probe51.mjs —— rivet/theocp/artenda 分页与目录
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  ["rivet-calls", "https://rivet.es/calls/", "rivet.es"],
  ["rivet-p2", "https://rivet.es/calls/page/2/", "rivet.es"],
  ["rivet-p3", "https://rivet.es/calls/page/3/", "rivet.es"],
  ["rivet-res", "https://rivet.es/?discipline=&funding=any&duration=any&type=residency", "rivet.es"],
  ["theocp-open", "https://theocp.live/open-calls/", "theocp.live"],
  ["theocp-archive", "https://theocp.live/open-calls/archive", "theocp.live"],
  ["artenda-calls", "https://artenda.net/art-open-call-opportunity", "artenda.net"],
  ["artenda-call-p2", "https://artenda.net/art-open-call-opportunity?page=2", "artenda.net"],
  ["artenda-grant", "https://artenda.net/art-open-call-opportunity/grant", "artenda.net"],
  ["artenda-award", "https://artenda.net/art-open-call-opportunity/award", "artenda.net"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 40 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
