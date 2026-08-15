// _tmp-addsources.mjs —— 批量生成 ArtConnect/CuratorSpace/e-flux/TheArtList 深挖源并写入 sources.json
// 一次性追加,避免手写几十个 JSON
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

// ArtConnect p15-p35
for (let p = 15; p <= 35; p++) {
  add(`artconnect-opportunities-p${p}`, "ArtConnect(全球)", `Opportunities 第${p}页`,
    `https://www.artconnect.com/opportunities?page=${p}`, "artconnect.com",
    ["opencall", "residency", "award"],
    `2026-08-15 实探:第${p}页分页,13 详情链接`);
}

// CuratorSpace p11-p24
for (let p = 11; p <= 24; p++) {
  add(`curatorspace-opportunities-p${p}`, "CuratorSpace(英国/全球)", `Opportunities 第${p}页`,
    `https://www.curatorspace.com/opportunities?page=${p}`, "curatorspace.com",
    ["opencall", "residency", "award"],
    `2026-08-15 实探:第${p}页分页`);
}

// e-flux announcements p1-p6
for (let p = 1; p <= 6; p++) {
  const url = p === 1 ? "https://www.e-flux.com/announcements/" : `https://www.e-flux.com/announcements/?page=${p}`;
  add(`eflux-announcements-p${p}`, "e-flux(国际)", `Announcements 第${p}页`, url, "e-flux.com",
    ["opencall", "residency", "award", "exhibition"],
    `2026-08-15 实探:announcements 分页第${p}页,22 详情链接,详情页含申请信号`);
}

// TheArtList 更深分页(有内容的分页)
const tlExtra = [
  ["theartlist-exhibitions-p4", "exhibitions", 4, "展览征集 第4页", ["opencall", "exhibition"]],
  ["theartlist-art-photo-p4", "art-and-photo-calls", 4, "艺术与摄影征集 第4页", ["opencall", "award"]],
  ["theartlist-art-photo-p5", "art-and-photo-calls", 5, "艺术与摄影征集 第5页", ["opencall", "award"]],
  ["theartlist-exhibitions-p5", "exhibitions", 5, "展览征集 第5页", ["opencall", "exhibition"]],
];
for (const [id, cat, p, name, hints] of tlExtra) {
  add(id, "TheArtList(美国/全球)", name, `https://www.theartlist.com/category/${cat}?page=${p}`,
    "theartlist.com", hints, `2026-08-15 实探:分页第${p}页`);
}

data._source_count = data.sources.length;
await writeFile("./pipeline/sources.json", JSON.stringify(data, null, 2), "utf8");
console.log(`新增源 ${added.length} 个,现有源 ${data.sources.length}`);
console.log(added.join("\n"));
