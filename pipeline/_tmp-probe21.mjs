// _tmp-probe21.mjs —— 探索更多可抓平台
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const CANDIDATES = [
  ["artistsinresidence", "artistsinresidence.de", "https://artistsinresidence.de/", "html"],
  ["resartis-listings2", "resartis.org", "https://resartis.org/listings/?fwp_by_category=open-call", "html"],
  ["resartis-res2", "resartis.org", "https://resartis.org/listings/?fwp_by_category=residencies", "html"],
  ["artconnect-more", "artconnect.com", "https://www.artconnect.com/opportunities?page=36", "html"],
  ["artconnect-more2", "artconnect.com", "https://www.artconnect.com/opportunities?page=37", "html"],
  ["artconnect-more3", "artconnect.com", "https://www.artconnect.com/opportunities?page=38", "html"],
  ["artconnect-more4", "artconnect.com", "https://www.artconnect.com/opportunities?page=39", "html"],
  ["artconnect-more5", "artconnect.com", "https://www.artconnect.com/opportunities?page=40", "html"],
  ["artconnect-more6", "artconnect.com", "https://www.artconnect.com/opportunities?page=45", "html"],
  ["artconnect-more7", "artconnect.com", "https://www.artconnect.com/opportunities?page=50", "html"],
  ["callforart-demo", "callforart.com", "https://www.callforart.com/", "html"],
  ["artopps-new", "artopps.org", "https://artopps.org/", "html"],
  ["artschallenge", "artschallenge.com", "https://www.artschallenge.com/", "html"],
  ["artworkarchive", "artworkarchive.com", "https://www.artworkarchive.com/", "html"],
  ["artly", "artly.com", "https://www.artly.com/", "html"],
  ["artquest", "artquest.org.uk", "https://www.artquest.org.uk/opportunities/", "html"],
  ["artsadmin", "artsadmin.co.uk", "https://www.artsadmin.co.uk/opportunities", "html"],
  ["creativeopportunities", "creativeopportunities.co.uk", "https://creativeopportunities.co.uk/", "html"],
  ["artscouncil", "artscouncil.org.uk", "https://www.artscouncil.org.uk/", "html"],
  ["artvenue", "artvenue.org", "https://www.artvenue.org/", "html"],
  ["artlocal", "artlocal.org", "https://www.artlocal.org/", "html"],
  ["artforall", "artforall.org", "https://www.artforall.org/opportunities", "html"],
  ["artlook", "artlook.com", "https://www.artlook.com/", "html"],
  ["artbox", "artbox.ch", "https://www.artbox.ch/", "html"],
  ["artconnect-korea", "artconnectkorea.com", "https://www.artconnectkorea.com/", "html"],
  ["artconnect-blog", "artconnect.com", "https://www.artconnect.com/blog?page=2", "html"],
  ["artconnect-opportunities?type=", "artconnect.com", "https://www.artconnect.com/opportunities?type=residency", "html"],
  ["artconnect-opportunities?type=2", "artconnect.com", "https://www.artconnect.com/opportunities?type=open_call", "html"],
];

for (const [id, domain, url] of CANDIDATES) {
  const src = { id, domain, url, type: "html", org_zh: domain };
  try {
    const f = await fetchSource(src, null);
    if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
    const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 20 });
    const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
    const t = (f.text||"").length;
    console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 文本 ${t} | 详情 ${detail.length}`);
    if (detail.length) console.log(`  ${detail.slice(0,2).map(l=>l.url).join(" ; ")}`);
  } catch (e) { console.log(`${id} | ERR ${String(e.message).slice(0,80)}`); }
}
console.log("探测完成");