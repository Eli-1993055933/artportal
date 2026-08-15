// _tmp-probe14.mjs —— ArtConnect 深挖 p21-p35 + CuratorSpace p17-p22
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

async function probeAC(p) {
  const url = `https://www.artconnect.com/opportunities?page=${p}`;
  const f = await fetchSource({ id: `ac-p${p}`, domain: "artconnect.com", url, type: "html", org_zh: "ArtConnect" }, null);
  if (f.skipped) { console.log(`artconnect-p${p} | SKIPPED (${f.reason})`); return 0; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
  console.log(`artconnect-p${p} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length}`);
  return detail.length;
}
async function probeCS(p) {
  const url = `https://www.curatorspace.com/opportunities?page=${p}`;
  const f = await fetchSource({ id: `cs-p${p}`, domain: "curatorspace.com", url, type: "html", org_zh: "CuratorSpace" }, null);
  if (f.skipped) { console.log(`curatorspace-p${p} | SKIPPED (${f.reason})`); return 0; }
  const links = discoverDetailLinks(f.rawHtml, url, "curatorspace.com", { cap: 30 });
  const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
  console.log(`curatorspace-p${p} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length}`);
  return detail.length;
}

for (let p = 21; p <= 35; p++) { if (!(await probeAC(p))) break; }
for (let p = 17; p <= 24; p++) { if (!(await probeCS(p))) break; }
console.log("探测完成");
