// _tmp-probe26.mjs —— 探测新目录平台可挖深度(不写库)
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const targets = [
  // 高价值艺术机会目录站
  ["callforentry", "https://www.callforentry.org/opportunities/", "opencall", "CaFÉ"],
  ["artdeadlines", "https://www.artdeadlines.com/", "opencall", "ArtDeadlines"],
  ["curatorspace-opps", "https://curatorspace.com/opportunities/calls", "opencall", "CuratorSpace"],
  ["artopps", "https://www.artopps.org/opportunities", "opencall", "ArtOpps"],
  ["artquest-opps", "https://artquest.org.uk/opportunities/", "opencall", "ArtQuest"],
  ["transartists", "https://www.transartists.org/en/calls", "residency", "TransArtists"],
  ["resartis", "https://resartis.org/residencies/", "residency", "ResArtis"],
  ["artsfwd", "https://artsfwd.org/opportunities/", "opencall", "ArtsFwd"],
  ["artjobs", "https://www.artjobs.com/art-opportunities", "opencall", "ArtJobs"],
  ["glac", "https://glaconline.org/calls-for-artists", "opencall", "GLAC"],
  ["nyfa", "https://www.nyfa.org/opportunities/", "opencall", "NYFA"],
  ["artworkarchive", "https://www.artworkarchive.com/blog/calls-for-artists", "opencall", "ArtworkArchive"],
];

for (const [id, url, hint, org] of targets) {
  const f = await fetchSource({ id, domain: new URL(url).host, url, type: "html", org_zh: org }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, new URL(url).host, { cap: 30 });
  const detail = links.filter(l => !/\.(jpg|png|css|js|ico|svg)$/i.test(l.url) && /\/[a-z0-9-]{4,}\//i.test(l.url));
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 文本 ${f.text?.length ?? 0} | 详情候选 ${detail.length}`);
  detail.slice(0, 8).forEach(l => console.log(`    ${l.url.slice(0, 100)}`));
}
