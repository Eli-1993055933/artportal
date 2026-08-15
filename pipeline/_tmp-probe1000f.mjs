// _tmp-probe1000f.mjs —— curatorspace calls 深页 + artconnect 深页实际详情链接捕获
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, u, domain, linkRe, skipRe, cap = 80) {
  try {
    const f = await fetchSource({ id: "t", domain, url: u, type: "html" }, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
    const links = discoverDetailLinks(f.rawHtml, u, domain, { cap });
    const detail = links.filter(l => (!linkRe || linkRe.test(l.url)) && (!skipRe || !skipRe.test(l.url)));
    const fresh = detail.filter(l => !urls.has(l.url));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length}`);
    fresh.slice(0, 4).forEach(l => console.log(`    ${l.url.slice(0, 100)}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

// curatorspace calls 深页(p10 之后)
await page('cs-c25', 'https://www.curatorspace.com/opportunities?page=25', 'curatorspace.com', /\/opportunities\//);
await page('cs-c26', 'https://www.curatorspace.com/opportunities?page=26', 'curatorspace.com', /\/opportunities\//);
await page('cs-c27', 'https://www.curatorspace.com/opportunities?page=27', 'curatorspace.com', /\/opportunities\//);
await page('cs-c28', 'https://www.curatorspace.com/opportunities?page=28', 'curatorspace.com', /\/opportunities\//);
await page('cs-c29', 'https://www.curatorspace.com/opportunities?page=29', 'curatorspace.com', /\/opportunities\//);
await page('cs-c30', 'https://www.curatorspace.com/opportunities?page=30', 'curatorspace.com', /\/opportunities\//);

// artconnect 深页(检查详情链接捕获情况)
await page('ac-p9', 'https://www.artconnect.com/opportunities?page=9', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/);
await page('ac-p15', 'https://www.artconnect.com/opportunities?page=15', 'artconnect.com', /\/opportunities\/[a-z0-9-]+/);
