// _tmp-addsources7.mjs —— artistcommunities residencies p7-p12
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(await readFile(join(__dir, "sources.json"), "utf8"));
const sources = doc.sources;
const existing = new Set(sources.map(s => s.id));
let added = 0;

for (let p = 7; p <= 12; p++) {
  const id = `artistcommunities-residencies-p${p}`;
  if (existing.has(id)) continue;
  sources.push({
    id, org_zh: "Alliance of Artists Communities(美国)", name_zh: `驻留目录 第${p}页`,
    url: `https://artistcommunities.org/residencies?page=${p}`,
    domain: "artistcommunities.org", type: "html", rss: null, org_type: "independent",
    category_hint: ["residency"], reachable: true, robots: "none", confirmed: false,
    notes: `2026-08-15 实探:驻留目录分页,p${p} 仍有新内容`, trust_auto: true
  });
  existing.add(id);
  added++;
}

writeFile(join(__dir, "sources.json"), JSON.stringify(doc, null, 2), "utf8");
console.log("新增源:", added, "| 总数:", sources.length);
