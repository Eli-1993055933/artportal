// _tmp-addsources6.mjs —— 补 ArtConnect 主页 p36-p37
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(await readFile(join(__dir, "sources.json"), "utf8"));
const sources = doc.sources;
const existing = new Set(sources.map(s => s.id));
let added = 0;

function add({ id, name_zh, url, notes }) {
  if (existing.has(id)) return;
  sources.push({
    id, org_zh: "ArtConnect(全球)", name_zh, url,
    domain: "artconnect.com", type: "html", rss: null, org_type: "independent",
    category_hint: ["opencall", "residency", "award"], reachable: true, robots: "none",
    confirmed: false, notes, trust_auto: true
  });
  existing.add(id);
  added++;
}

add({ id: "artconnect-opportunities-p36", name_zh: "Opportunities 第36页", url: "https://www.artconnect.com/opportunities?page=36", notes: "2026-08-15 实探:10 机会/页" });
add({ id: "artconnect-opportunities-p37", name_zh: "Opportunities 第37页", url: "https://www.artconnect.com/opportunities?page=37", notes: "2026-08-15 实探:5 机会/页,p38 起为空" });

writeFile(join(__dir, "sources.json"), JSON.stringify(doc, null, 2), "utf8");
console.log("新增源:", added, "| 总数:", sources.length);
