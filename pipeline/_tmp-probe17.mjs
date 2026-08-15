// _tmp-probe17.mjs —— 深挖 artjobs.com 结构
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const urls = [
  ["artjobs-home", "https://www.artjobs.com/"],
  ["artjobs-oc", "https://www.artjobs.com/open-calls"],
  ["artjobs-cfa", "https://www.artjobs.com/open-calls/call-for-artists"],
  ["artjobs-cfe", "https://www.artjobs.com/open-calls/call-for-entries"],
  ["artjobs-res", "https://www.artjobs.com/open-calls/residencies"],
  ["artjobs-grant", "https://www.artjobs.com/open-calls/grants"],
  ["artjobs-comp", "https://www.artjobs.com/open-calls/competitions"],
  ["artjobs-ex", "https://www.artjobs.com/open-calls/exhibitions"],
];

for (const [id, url] of urls) {
  const f = await fetchSource({ id, domain: "artjobs.com", url, type: "html", org_zh: "artjobs" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artjobs.com", { cap: 30 });
  const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
  const t = (f.text || "").length;
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 文本 ${t} | 详情 ${detail.length}`);
  if (detail.length) console.log(`  样例: ${detail.slice(0, 2).map(l => l.url).join(" ; ")}`);
}
console.log("artjobs 探测完成");