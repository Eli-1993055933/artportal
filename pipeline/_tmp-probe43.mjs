// _tmp-probe43.mjs —— curatorspace /opportunities 新颖率 + 分页
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

for (let p = 1; p <= 8; p++) {
  const url = `https://curatorspace.com/opportunities/calls?page=${p}`;
  const f = await fetchSource({ id: `cs-p${p}`, domain: "curatorspace.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`calls p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "curatorspace.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunities\/detail\//.test(l.url)).map(l => l.url);
  const fresh = detail.filter(u => !urls.has(u));
  console.log(`calls p${p} | 详情 ${detail.length} | 新 ${fresh.length}`);
}
