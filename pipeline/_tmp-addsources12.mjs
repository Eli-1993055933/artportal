// _tmp-addsources12.mjs —— artrabbit 全类型机会源
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(await readFile(join(__dir, "sources.json"), "utf8"));
const sources = doc.sources;
const existing = new Set(sources.map(s => s.id));
let added = 0;

function add({ id, org_zh, name_zh, url, domain, hints, notes }) {
  if (existing.has(id)) return;
  sources.push({
    id, org_zh, name_zh, url, domain,
    type: "html", rss: null, org_type: "independent",
    category_hint: hints, reachable: true, robots: "none", confirmed: false,
    notes, trust_auto: true
  });
  existing.add(id);
  added++;
}

add({ id: "artrabbit-opps-p2", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-第2页",
  url: "https://www.artrabbit.com/artist-opportunities?page=2", domain: "artrabbit.com",
  hints: ["opencall", "residency", "award", "grant"], notes: "2026-08-15 实探:63 详情,31 新" });
add({ id: "artrabbit-opps-exhibition", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-展览",
  url: "https://www.artrabbit.com/artist-opportunities?type=Exhibition+Opportunity", domain: "artrabbit.com",
  hints: ["exhibition", "opencall"], notes: "2026-08-15 实探:18 详情,9 新" });
add({ id: "artrabbit-opps-prize", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-奖项",
  url: "https://www.artrabbit.com/artist-opportunities?type=Prize", domain: "artrabbit.com",
  hints: ["award", "prize"], notes: "2026-08-15 实探:12 详情,5 新" });
add({ id: "artrabbit-opps-competition", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-竞赛",
  url: "https://www.artrabbit.com/artist-opportunities?type=Competition", domain: "artrabbit.com",
  hints: ["competition", "award"], notes: "2026-08-15 实探:10 详情,4 新" });
add({ id: "artrabbit-opps-fellowship", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-奖学金",
  url: "https://www.artrabbit.com/artist-opportunities?type=Fellowship", domain: "artrabbit.com",
  hints: ["fellowship", "grant"], notes: "2026-08-15 实探:7 详情,3 新" });
add({ id: "artrabbit-opps-workshop", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-工作坊",
  url: "https://www.artrabbit.com/artist-opportunities?type=Workshops", domain: "artrabbit.com",
  hints: ["workshop"], notes: "2026-08-15 实探:5 详情,1 新" });

writeFile(join(__dir, "sources.json"), JSON.stringify(doc, null, 2), "utf8");
console.log("新增源:", added, "| 总数:", sources.length);
