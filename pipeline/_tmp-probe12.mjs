// _tmp-probe12.mjs —— 深度探测各平台可挖深度
// 目标:确认 ArtConnect/CuratorSpace/e-flux/TransArtists/TheArtList 的分页上限
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

async function probePage(id, domain, url, label) {
  const src = { id, domain, url, type: "html", org_zh: domain };
  try {
    const f = await fetchSource(src, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return 0; }
    const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
    const detail = links.filter(l => !/\.(css|js|png|ico|webmanifest|jpg|svg|xml)$/.test(l.url));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 文本 ${(f.text||"").length} | 详情 ${detail.length}`);
    return detail.length;
  } catch (e) { console.log(`${label} | ERR ${String(e.message).slice(0,90)}`); return 0; }
}

// ArtConnect 深挖到 p20
for (let p = 15; p <= 20; p++) {
  await probePage(`ac-p${p}`, "artconnect.com", `https://www.artconnect.com/opportunities?page=${p}`, `artconnect-p${p}`);
}

// CuratorSpace 深挖到 p16
for (let p = 11; p <= 16; p++) {
  await probePage(`cs-p${p}`, "curatorspace.com", `https://www.curatorspace.com/opportunities?page=${p}`, `curatorspace-p${p}`);
}

// e-flux announcements 分页
await probePage("eflux-1", "e-flux.com", "https://www.e-flux.com/announcements/", "eflux-p1");
await probePage("eflux-2", "e-flux.com", "https://www.e-flux.com/announcements/page/2/", "eflux-p2");

// TransArtists calls
await probePage("ta", "transartists.org", "https://www.transartists.org/en/transartists-calls", "transartists");

// TheArtList 分类页更深分页
await probePage("tl-a1", "theartlist.com", "https://www.theartlist.com/category/art-and-photo-calls?page=4", "theartlist-artphoto-p4");
await probePage("tl-a2", "theartlist.com", "https://www.theartlist.com/category/art-and-photo-calls?page=5", "theartlist-artphoto-p5");
await probePage("tl-e2", "theartlist.com", "https://www.theartlist.com/category/exhibitions?page=4", "theartlist-exhibitions-p4");

// resartis open-calls
await probePage("resartis", "resartis.org", "https://resartis.org/listings/", "resartis-listings");
await probePage("resartis2", "resartis.org", "https://resartis.org/open-calls/", "resartis-opencalls");

console.log("深度探测完成");
