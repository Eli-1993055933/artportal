// _tmp-probe16.mjs —— 探测剩余可挖平台:artcall/open-calls-art 变体/artresidencyguide/更小但可抓的目录
// 目标:找够 open 1000 的补充来源
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const CANDIDATES = [
  ["artcall-opportunities", "artcall.org", "https://artcall.org/opportunities", "html"],
  ["artcall-submit", "artcall.org", "https://artcall.org/call-for-submission", "html"],
  ["opencalls-me", "opencalls.me", "https://opencalls.me/", "html"],
  ["callforartists", "callforartists.org", "https://callforartists.org/", "html"],
  ["artjobs", "artjobs.com", "https://www.artjobs.com/", "html"],
  ["a-n-co", "a-n.co.uk", "https://www.a-n.co.uk/opportunities/", "html"],
  ["artopps-uk", "artopps-uk.com", "https://www.artopps-uk.com/", "html"],
  ["artopps", "artopps.org", "https://artopps.org/", "html"],
  ["foundationforarts", "foundationforarts.org", "https://www.foundationforarts.org/", "html"],
  ["artisttrust", "artisttrust.org", "https://artisttrust.org/", "html"],
  ["artgallery-saatchi", "saatchigallery.com", "https://www.saatchigallery.com/", "html"],
  ["afk-us", "afk.ch", "https://afk.ch/", "html"],
];

for (const [id, domain, url] of CANDIDATES) {
  const src = { id, domain, url, type: "html", org_zh: domain };
  try {
    const f = await fetchSource(src, null);
    if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
    const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 25 });
    const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
    const t = (f.text || "").length;
    console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 文本 ${t} | 详情 ${detail.length}`);
    if (detail.length) console.log(`  ${detail.slice(0,3).map(l=>l.url).join("\n  ")}`);
  } catch (e) { console.log(`${id} | ERR ${String(e.message).slice(0,80)}`); }
}
console.log("探测完成");
