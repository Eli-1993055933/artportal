// _tmp-addsources5.mjs —— 给 artistcommunities 添加 residencies 分页源
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(await readFile(join(__dir, "sources.json"), "utf8"));
const sources = doc.sources;

const existing = new Set(sources.map(s => s.id));
let added = 0;

function add({ id, name_zh, url, domain, hints, notes }) {
  if (existing.has(id)) return;
  sources.push({
    id, org_zh: "Alliance of Artists Communities(美国)", name_zh, url, domain,
    type: "html", rss: null, org_type: "independent",
    category_hint: hints, reachable: true, robots: "none", confirmed: false,
    notes, trust_auto: true
  });
  existing.add(id);
  added++;
}

// residencies 分页 p2-p6(实探:每页 ~20+ 详情候选)
for (let p = 2; p <= 6; p++) {
  add({
    id: `artistcommunities-residencies-p${p}`,
    name_zh: `驻留目录 第${p}页`,
    url: `https://artistcommunities.org/residencies?page=${p}`,
    domain: "artistcommunities.org",
    hints: ["residency"],
    notes: `2026-08-15 实探:驻留目录分页,每页约 20+ 详情,与 open-calls/residencies 目录不同`,
  });
}

writeFile(join(__dir, "sources.json"), JSON.stringify(doc, null, 2), "utf8");
console.log("新增源:", added, "| 总数:", sources.length);
