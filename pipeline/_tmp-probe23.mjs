// _tmp-probe23.mjs —— ArtConnect type 过滤分页 + TheArtList 深分页 + artenda 更多分类
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

// ArtConnect type=residency 分页
for (let p = 1; p <= 3; p++) {
  const url = `https://www.artconnect.com/opportunities?type=residency&page=${p}`;
  const f = await fetchSource({ id: `ac-res-${p}`, domain: "artconnect.com", url, type: "html", org_zh: "ArtConnect" }, null);
  if (f.skipped) { console.log(`ac-res-p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 20 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`ac-type=residency-p${p} | HTTP ${f.httpStatus ?? f.status} | 机会 ${detail.length}`);
}

// ArtConnect type=open_call 分页
for (let p = 1; p <= 3; p++) {
  const url = `https://www.artconnect.com/opportunities?type=open_call&page=${p}`;
  const f = await fetchSource({ id: `ac-oc-${p}`, domain: "artconnect.com", url, type: "html", org_zh: "ArtConnect" }, null);
  if (f.skipped) { console.log(`ac-oc-p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 20 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`ac-type=opencall-p${p} | HTTP ${f.httpStatus ?? f.status} | 机会 ${detail.length}`);
}

// TheArtList 深分页探测
const tlCats = ["art-and-photo-calls", "calls-for-submissions", "contests-and-juried-shows", "exhibitions", "residencies", "grants-scholarships"];
for (const cat of tlCats) {
  for (const p of [2, 3, 4]) {
    const url = `https://www.theartlist.com/category/${cat}?page=${p}`;
    const f = await fetchSource({ id: `tl-${cat}-p${p}`, domain: "theartlist.com", url, type: "html", org_zh: "TheArtList" }, null);
    if (f.skipped) { console.log(`tl-${cat}-p${p} | SKIPPED (${f.reason})`); continue; }
    const links = discoverDetailLinks(f.rawHtml, url, "theartlist.com", { cap: 20 });
    const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
    console.log(`tl-${cat}-p${p} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length}`);
  }
}
console.log("探测完成");
