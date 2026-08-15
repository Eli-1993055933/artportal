// _tmp-probe38.mjs —— 对比 ArtConnect types 过滤页与已有库的重复率
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => o.url).filter(Boolean));

async function check(t) {
  const url = `https://www.artconnect.com/opportunities?types=${t}`;
  const f = await fetchSource({ id: `ac-${t}`, domain: "artconnect.com", url, type: "html" }, null);
  if (f.skipped) return;
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url)).map(l => l.url);
  const fresh = detail.filter(u => !urls.has(u));
  console.log(`types=${t} | 详情 ${detail.length} | 库中已有 ${detail.length - fresh.length} | 新 ${fresh.length}`);
}

await check("OPEN_CALL");
await check("COMMISSION");
await check("JOB");
