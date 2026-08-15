// _tmp-probe48.mjs —— curatorspace p7+ / artistcommunities p13+
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const urls = new Set((db.opportunities || []).map(o => (o.url || "").replace("https://www.", "https://")).filter(Boolean));

// curatorspace
for (let p = 7; p <= 10; p++) {
  const url = `https://curatorspace.com/opportunities?page=${p}`;
  const f = await fetchSource({ id: `cs-p${p}`, domain: "curatorspace.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`cs p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "curatorspace.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunities\/detail\//.test(l.url)).map(l => l.url.replace("https://www.", "https://"));
  const fresh = detail.filter(u => !urls.has(u));
  console.log(`cs p${p} | 详情 ${detail.length} | 新 ${fresh.length}`);
}

// artistcommunities
for (let p = 13; p <= 16; p++) {
  const url = `https://artistcommunities.org/residencies?page=${p}`;
  const f = await fetchSource({ id: `ac-p${p}`, domain: "artistcommunities.org", url, type: "html" }, null);
  if (f.skipped) { console.log(`ac p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artistcommunities.org", { cap: 30 });
  const detail = links.filter(l => /\/directory\//.test(l.url));
  console.log(`ac p${p} | HTTP ${f.httpStatus ?? f.status} | 目录详情 ${detail.length} | 文本 ${f.text?.length ?? 0}`);
}
