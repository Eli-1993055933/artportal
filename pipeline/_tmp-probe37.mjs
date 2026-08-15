// _tmp-probe37.mjs —— 更多国际机会目录探测
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  // 国际驻留/机会平台
  ["resartis-calls", "https://resartis.org/residencies/?sf_paged=1", "resartis.org"],
  ["guhring", "https://www.guhring.com/residencies", "guhring.com"],
  ["kulturstiftung", "https://www.kulturstiftung-des-bundes.de/en/", "kulturstiftung-des-bundes.de"],
  ["wallartcalls", "https://wallartcalls.com/", "wallartcalls.com"],
  ["artscult", "https://www.artscult.com/", "artscult.com"],
  ["artcall2024", "https://www.artcall.org/", "artcall.org"],
  ["theartist-info", "https://www.theartist-info.com/", "theartist-info.com"],
  ["loremart", "https://www.loremart.com/calls", "loremart.com"],
  ["verostko", "https://www.artopen-calls.com/", "artopen-calls.com"],
  ["artistopp", "https://artistopportunities.org/", "artistopportunities.org"],
  ["arts-opencall", "https://www.artsopportunities.org/", "artsopportunities.org"],
  ["call4artists", "https://call4artists.com/", "call4artists.com"],
];

for (const [id, url, domain] of targets) {
  const f = await fetchSource({ id, domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 详情候选 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
  detail.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}
