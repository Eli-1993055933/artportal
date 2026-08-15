// _tmp-addsources11.mjs —— artrabbit 高产机会源 + 其他新平台
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

// artrabbit 全部机会(63 详情) + 类型过滤
add({ id: "artrabbit-opps-all", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-全部",
  url: "https://www.artrabbit.com/artist-opportunities", domain: "artrabbit.com",
  hints: ["opencall", "residency", "award", "grant"],
  notes: "2026-08-15 实探:63 条详情全部为新" });
add({ id: "artrabbit-opps-residency", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-驻留",
  url: "https://www.artrabbit.com/artist-opportunities?type=Artist+in+Residence", domain: "artrabbit.com",
  hints: ["residency"], notes: "2026-08-15 实探:16 条驻留" });
add({ id: "artrabbit-opps-grant", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-资助",
  url: "https://www.artrabbit.com/artist-opportunities?type=Grant", domain: "artrabbit.com",
  hints: ["grant", "award"], notes: "2026-08-15 实探:9 条资助" });
add({ id: "artrabbit-opps-opencall", org_zh: "ArtRabbit(国际)", name_zh: "艺术家机会-开放征集",
  url: "https://www.artrabbit.com/artist-opportunities?type=Open+Call", domain: "artrabbit.com",
  hints: ["opencall"], notes: "2026-08-15 实探:5 条征集" });

writeFile(join(__dir, "sources.json"), JSON.stringify(doc, null, 2), "utf8");
console.log("新增源:", added, "| 总数:", sources.length);
