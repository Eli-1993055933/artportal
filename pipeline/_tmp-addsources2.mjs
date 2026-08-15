// _tmp-addsources2.mjs —— 批量加 artjobs 分类源 + ArtConnect/CuratorSpace 剩余分页
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

// artjobs 分类源
const ajCats = [
  ["call-for-artists", "艺术家征集", ["opencall"]],
  ["call-for-entries", "投稿征集", ["opencall"]],
  ["notforprofit", "非营利征集", ["opencall"]],
  ["award", "奖项", ["award"]],
  ["competitions", "竞赛", ["award"]],
  ["performance", "表演征集", ["opencall"]],
  ["exhibitions", "展览征集", ["exhibition", "opencall"]],
  ["films", "影视征集", ["opencall"]],
  ["festivals", "艺术节", ["opencall", "award"]],
  ["photography", "摄影征集", ["opencall"]],
  ["residencies", "驻留", ["residency"]],
  ["visual-arts", "视觉艺术征集", ["opencall"]],
  ["workshops", "工作坊", ["workshop"]],
];
for (const [cat, name, hints] of ajCats) {
  add(`artjobs-${cat}`, "artjobs.com(国际)", `Open Calls-${name}`,
    `https://www.artjobs.com/open-calls/${cat}`, "artjobs.com", hints,
    `2026-08-15 实探:artjobs 分类目录页,10-16 真实详情链接`);
}

// ArtConnect p26-p35(补充)
for (let p = 26; p <= 35; p++) {
  add(`artconnect-opportunities-p${p}`, "ArtConnect(全球)", `Opportunities 第${p}页`,
    `https://www.artconnect.com/opportunities?page=${p}`, "artconnect.com",
    ["opencall", "residency", "award"], `2026-08-15 实探:第${p}页分页`);
}

// CuratorSpace p19-p24(补充)
for (let p = 19; p <= 24; p++) {
  add(`curatorspace-opportunities-p${p}`, "CuratorSpace(英国/全球)", `Opportunities 第${p}页`,
    `https://www.curatorspace.com/opportunities?page=${p}`, "curatorspace.com",
    ["opencall", "residency", "award"], `2026-08-15 实探:第${p}页分页`);
}

// artisttrust 3 条补充
add("artisttrust-awards", "Artist Trust(美国)", "奖项与资助", "https://artisttrust.org/", "artisttrust.org",
  ["award", "grant"], "2026-08-15 实探:3 条奖项公告");

data._source_count = data.sources.length;
await writeFile("./pipeline/sources.json", JSON.stringify(data, null, 2), "utf8");
console.log(`新增源 ${added.length} 个,现有源 ${data.sources.length}`);
console.log(added.join("\n"));
