// _tmp-probe36.mjs —— ArtConnect 主页 p36+ 是否还有内容
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

for (let p = 36; p <= 45; p++) {
  const url = `https://www.artconnect.com/opportunities?page=${p}`;
  const f = await fetchSource({ id: `ac-p${p}`, domain: "artconnect.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`p${p} | HTTP ${f.httpStatus ?? f.status} | 机会详情 ${detail.length}`);
}
