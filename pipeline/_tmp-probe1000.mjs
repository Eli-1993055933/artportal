// _tmp-probe1000.mjs —— 冲刺 1000 的候选源探测
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, u, domain, linkRe, skipRe, cap = 60) {
  try {
    const f = await fetchSource({ id: "t", domain, url: u, type: "html" }, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
    const links = discoverDetailLinks(f.rawHtml, u, domain, { cap });
    const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
    const fresh = detail.filter(l => !urls.has(l.url));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length} | 文本 ${f.text?.length ?? 0}`);
    fresh.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 100)}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

// artdeadlineslist.com —— 专门的截止日期清单
await page('adl-home', 'https://artdeadlineslist.com/', 'artdeadlineslist.com', /\/deadline\//, /artdeadlineslist\.com\/$/);
await page('adl-2', 'https://artdeadlineslist.com/page/2/', 'artdeadlineslist.com', /\/deadline\//, /artdeadlineslist\.com\/$/);

// callforentries.com —— 提交征集目录
await page('cfe-home', 'https://www.callforentries.com/', 'callforentries.com', /\/competition\//);
await page('cfe-2', 'https://www.callforentries.com/page/2/', 'callforentries.com', /\/competition\//);

// theartlist 更深分页
await page('tal-artp6', 'https://www.theartlist.com/category/art-and-photo-calls?page=6', 'theartlist.com', /\/call\//);
await page('tal-artp7', 'https://www.theartlist.com/category/art-and-photo-calls?page=7', 'theartlist.com', /\/call\//);
await page('tal-exh6', 'https://www.theartlist.com/category/exhibitions?page=6', 'theartlist.com', /\/call\//);

// ArtConnect 更深分页
await page('ac-p9', 'https://www.artconnect.com/opportunities?page=9', 'artconnect.com', /\/opportunities\//);
await page('ac-p10', 'https://www.artconnect.com/opportunities?page=10', 'artconnect.com', /\/opportunities\//);
await page('ac-p11', 'https://www.artconnect.com/opportunities?page=11', 'artconnect.com', /\/opportunities\//);
