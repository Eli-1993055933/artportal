// _tmp-addsources8.mjs —— curatorspace /opportunities 分页 p1-p6
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(await readFile(join(__dir, "sources.json"), "utf8"));
const sources = doc.sources;
const existing = new Set(sources.map(s => s.id));
let added = 0;

for (let p = 1; p <= 6; p++) {
  const id = `curatorspace-opportunities-dir-p${p}`;
  if (existing.has(id)) continue;
  sources.push({
    id, org_zh: "CuratorSpace(英国)", name_zh: `机会目录 第${p}页`,
    url: `https://curatorspace.com/opportunities?page=${p}`,
    domain: "curatorspace.com", type: "html", rss: null, org_type: "independent",
    category_hint: ["opencall", "residency", "award", "commission"],
    reachable: true, robots: "none", confirmed: false,
    notes: `2026-08-15 实探:主机会目录分页,13 详情/页,部分与 calls 目录重复`, trust_auto: true
  });
  existing.add(id);
  added++;
}

writeFile(join(__dir, "sources.json"), JSON.stringify(doc, null, 2), "utf8");
console.log("新增源:", added, "| 总数:", sources.length);
