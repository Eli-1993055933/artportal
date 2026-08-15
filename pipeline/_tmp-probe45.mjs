// _tmp-probe45.mjs —— curatorspace /opportunities 实际详情 URL 格式对比
import { readFile } from "node:fs/promises";
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const db = JSON.parse(await readFile("d:/Vibe Coding/Trae/site/data/opportunities.json", "utf8"));
const cs = (db.opportunities || []).filter(o => o.domain === "curatorspace.com").map(o => o.url);
console.log("库中 curatorspace 条目数:", cs.length);
console.log("库中 URL 示例:");
cs.slice(0, 5).forEach(u => console.log("   ", u));

const f = await fetchSource({ id: "cs-p1", domain: "curatorspace.com", url: "https://curatorspace.com/opportunities", type: "html" }, null);
const links = discoverDetailLinks(f.rawHtml, "https://curatorspace.com/opportunities", "curatorspace.com", { cap: 30 });
const detail = links.filter(l => /\/opportunities\/detail\//.test(l.url));
console.log("\n页面详情 URL:");
detail.slice(0, 10).forEach(u => console.log("   ", u));
