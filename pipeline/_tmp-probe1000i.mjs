// _tmp-probe1000i.mjs —— artconnect 深页 /opportunity/ 链接统计
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(label, u) {
  try {
    const f = await fetchSource({ id: "t", domain: "artconnect.com", url: u, type: "html" }, null);
    if (f.skipped) { console.log(`${label} | SKIPPED (${f.reason})`); return; }
    const html = f.rawHtml || "";
    const m = html.match(/\/opportunity\/[A-Za-z0-9_-]+/g) || [];
    const uniq = [...new Set(m)];
    const fresh = uniq.filter(x => !urls.has("https://www.artconnect.com" + x));
    console.log(`${label} | HTTP ${f.httpStatus ?? f.status} | opp-links ${uniq.length} | 新 ${fresh.length} | html ${html.length}`);
    fresh.slice(0, 6).forEach(x => console.log(`    ${x}`));
  } catch (e) { console.log(`${label} | ERR ${e.message}`); }
}

await page('p1', 'https://www.artconnect.com/opportunities?page=1');
await page('p9', 'https://www.artconnect.com/opportunities?page=9');
await page('p13', 'https://www.artconnect.com/opportunities?page=13');
await page('p20', 'https://www.artconnect.com/opportunities?page=20');
await page('p30', 'https://www.artconnect.com/opportunities?page=30');
