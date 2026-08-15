// _tmp-probe54.mjs —— 剩余深度 + 新平台可收割性
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, url, domain, linkRe, skipRe) {
  const f = await fetchSource({ id: "t", domain, url, type: "html" }, null);
  if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 60 });
  const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
  const fresh = detail.filter(l => !urls.has(l.url));
  console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length} | 文本 ${f.text?.length ?? 0}`);
  fresh.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}

// artconnect 尾部页(前面已到 p37)
await page("artconnect-p38", "https://www.artconnect.com/opportunities?page=38", "artconnect.com", /\/opportunities\//, /category|tag=/);
await page("artconnect-p39", "https://www.artconnect.com/opportunities?page=39", "artconnect.com", /\/opportunities\//, /category|tag=/);
await page("artconnect-p40", "https://www.artconnect.com/opportunities?page=40", "artconnect.com", /\/opportunities\//, /category|tag=/);
// artistcommunities 剩余分页
await page("ac-res-p17", "https://artistcommunities.org/residencies?page=17", "artistcommunities.org", null, null);
await page("ac-res-p18", "https://artistcommunities.org/residencies?page=18", "artistcommunities.org", null, null);
await page("ac-res-p19", "https://artistcommunities.org/residencies?page=19", "artistcommunities.org", null, null);
// 新平台
await page("artdeadlineslist", "https://artdeadlineslist.com/", "artdeadlineslist.com", null, null);
await page("callforentries-1", "https://callforentries.com/", "callforentries.com", null, null);
// curatorspace 尾部
await page("cs-p25", "https://www.curatorspace.com/opportunities?page=25", "curatorspace.com", /\/opportunities\//, /category|tag=/);
await page("cs-p26", "https://www.curatorspace.com/opportunities?page=26", "curatorspace.com", /\/opportunities\//, /category|tag=/);
