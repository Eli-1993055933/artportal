// _tmp-probe52.mjs —— theocp.live 归档深挖
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function page(u) {
  const f = await fetchSource({ id: "t", domain: "theocp.live", url: u, type: "html" }, null);
  if (f.skipped) { console.log(`${u} | SKIPPED (${f.reason})`); return; }
  const links = discoverDetailLinks(f.rawHtml, u, "theocp.live", { cap: 50 });
  const detail = links.filter(l => /\/open-calls\/[a-z0-9-]/.test(l.url) && !/archive|submit|my-calls|open-calls$/.test(l.url));
  const fresh = detail.filter(l => !urls.has(l.url));
  console.log(`${u} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length} | 新 ${fresh.length}`);
  fresh.slice(0, 5).forEach(l => console.log(`    ${l.url.slice(0, 110)}`));
}

await page("https://theocp.live/open-calls/archive");
await page("https://theocp.live/open-calls/archive?category=Photography");
await page("https://theocp.live/open-calls/archive?category=Painting");
await page("https://theocp.live/open-calls/archive?category=Sculpture");
