// _tmp-probe39.mjs —— types 过滤页分页深度 + 新颖率
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(t, p) {
  const url = `https://www.artconnect.com/opportunities?types=${t}&page=${p}`;
  const f = await fetchSource({ id: `ac-${t}-p${p}`, domain: "artconnect.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`${t} p${p} | SKIPPED (${f.reason})`); return; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url)).map(l => l.url);
  const fresh = detail.filter(u => !urls.has(u));
  console.log(`${t} p${p} | 详情 ${detail.length} | 新 ${fresh.length}`);
}

for (let p = 1; p <= 5; p++) await page("JOB", p);
for (let p = 1; p <= 5; p++) await page("OPEN_CALL", p);
for (let p = 1; p <= 3; p++) await page("COMMISSION", p);
