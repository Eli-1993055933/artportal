// _tmp-addsources4.mjs —— 加 ArtConnect type 过滤源
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

const types = [
  ["residency", "驻留", ["residency"]],
  ["open_call", "公开征集", ["opencall"]],
  ["award", "奖项", ["award"]],
  ["grant", "资助", ["grant"]],
  ["exhibition", "展览", ["exhibition", "opencall"]],
  ["competition", "竞赛", ["award"]],
  ["biennale", "双年展", ["award", "exhibition"]],
  ["fellowship", "研究金", ["grant", "residency"]],
  ["artist-in-residence", "驻留艺术家", ["residency"]],
  ["call-for-artists", "艺术家征集", ["opencall"]],
  ["call-for-entry", "投稿征集", ["opencall"]],
];
for (const [t, name, hints] of types) {
  add(`artconnect-type-${t}-p1`, "ArtConnect(全球)", `按类型-${name} 第1页`,
    `https://www.artconnect.com/opportunities?type=${t}&page=1`, "artconnect.com", hints,
    `2026-08-15 实探:按类型过滤页,10 机会/页`);
  add(`artconnect-type-${t}-p2`, "ArtConnect(全球)", `按类型-${name} 第2页`,
    `https://www.artconnect.com/opportunities?type=${t}&page=2`, "artconnect.com", hints,
    `2026-08-15 实探:按类型过滤页,10 机会/页`);
}

data._source_count = data.sources.length;
await writeFile("./pipeline/sources.json", JSON.stringify(data, null, 2), "utf8");
console.log(`新增源 ${added.length} 个,现有源 ${data.sources.length}`);
console.log(added.join("\n"));
