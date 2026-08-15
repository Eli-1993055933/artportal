// _tmp-addsources3.mjs —— 加 artquest 源 + ArtConnect p31-35
import { readFile, writeFile } from "node:fs/promises";

const data = JSON.parse(await readFile("./pipeline/sources.json", "utf8"));
const existing = new Set(data.sources.map(s => s.id));
const added = [];
function add(id, org, name, url, domain, hints, notes) {
  if (existing.has(id)) return;
  data.sources.push({
    id, org_zh: org, name_zh: name, url, domain, type: "html", rss: null,
    org_type: "independent", category_hint: hints, reachable: true,
    robots: "none", confirmed: false, notes, trust_auto: true
  });
  added.push(id);
}

// artquest p1/p2
add("artquest-opportunities-p1", "ArtQuest(英国)", "机会列表 第1页", "https://artquest.org.uk/opportunities/", "artquest.org.uk",
  ["opencall", "residency", "award", "commission"], "2026-08-15 实探:18 机会详情,纯HTML");
add("artquest-opportunities-p2", "ArtQuest(英国)", "机会列表 第2页", "https://artquest.org.uk/opportunities/page/2/", "artquest.org.uk",
  ["opencall", "residency", "award", "commission"], "2026-08-15 实探:18 机会详情");

// ArtConnect p31-35(补充;p38+为空,上限p37)
for (let p = 31; p <= 35; p++) {
  add(`artconnect-opportunities-p${p}`, "ArtConnect(全球)", `Opportunities 第${p}页`,
    `https://www.artconnect.com/opportunities?page=${p}`, "artconnect.com",
    ["opencall", "residency", "award"], `2026-08-15 实探:第${p}页分页,10 机会`);
}

data._source_count = data.sources.length;
await writeFile("./pipeline/sources.json", JSON.stringify(data, null, 2), "utf8");
console.log(`新增源 ${added.length} 个,现有源 ${data.sources.length}`);
console.log(added.join("\n"));
