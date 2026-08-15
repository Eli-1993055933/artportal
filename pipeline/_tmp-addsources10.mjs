// _tmp-addsources10.mjs —— 新平台源补充
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

// theocp.live 归档(实探 34 新详情)
add({
  id: "theocp-archive", org_zh: "The Open Call Platform(OCP)", name_zh: "开放征集归档",
  url: "https://theocp.live/open-calls/archive", domain: "theocp.live",
  hints: ["opencall", "residency", "award", "grant"],
  notes: "2026-08-15 实探:34 条详情,全部为新"
});
add({
  id: "theocp-archive-photo", org_zh: "The Open Call Platform(OCP)", name_zh: "开放征集归档-摄影",
  url: "https://theocp.live/open-calls/archive?category=Photography", domain: "theocp.live",
  hints: ["opencall", "exhibition"],
  notes: "2026-08-15 实探:34 条详情(与归档页有重叠)"
});

// rivet.es 征集
add({
  id: "rivet-calls", org_zh: "Rivet(西班牙)", name_zh: "开放征集列表",
  url: "https://rivet.es/calls/", domain: "rivet.es",
  hints: ["opencall", "residency", "award"],
  notes: "2026-08-15 实探:约 4 条当前征集"
});

// artenda 驻留目录
add({
  id: "artenda-residency", org_zh: "Artenda(欧洲)", name_zh: "驻留机会",
  url: "https://artenda.net/art-open-call-opportunity/residency", domain: "artenda.net",
  hints: ["residency"],
  notes: "2026-08-15 实探:驻留目录页"
});

writeFile(join(__dir, "sources.json"), JSON.stringify(doc, null, 2), "utf8");
console.log("新增源:", added, "| 总数:", sources.length);
