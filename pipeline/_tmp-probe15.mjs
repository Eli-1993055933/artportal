// _tmp-probe15.mjs —— TheArtList 分类更深分页 + e-flux 详情页质量抽查
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

// TheArtList: 探测各分类 p2-p4 是否存在(非空)
const tlCats = {
  "art-and-photo-calls": "opencall",
  "calls-for-submissions": "opencall",
  "contests-and-juried-shows": "award",
  "exhibitions": "exhibition",
  "grants-scholarships": "grant",
  "residencies": "residency",
};
for (const [cat, hint] of Object.entries(tlCats)) {
  const p2url = `https://www.theartlist.com/category/${cat}?page=2`;
  const f = await fetchSource({ id: `tl-${cat}-p2`, domain: "theartlist.com", url: p2url, type: "html", org_zh: "TheArtList" }, null);
  if (f.skipped) { console.log(`tl-${cat}-p2 | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, p2url, "theartlist.com", { cap: 30 });
  const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
  console.log(`tl-${cat}-p2 | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length}`);
}

// e-flux: 抽查一个 announce 详情页,看是否含 apply/deadline 信号
const sample = "https://www.e-flux.com/announcements/6787850/kim-heecheonmoles";
const ef = await fetchSource({ id: "eflux-sample", domain: "e-flux.com", url: sample, type: "html", org_zh: "e-flux" }, null);
if (!ef.skipped) {
  const t = ef.text || "";
  console.log("e-flux 详情样本 | 文本", t.length, "| 含apply/deadline:", /apply|deadline|submission|open call|call for|eligible/i.test(t));
}

// e-flux 首页更多分页
for (let p = 3; p <= 5; p++) {
  const u = `https://www.e-flux.com/announcements/?page=${p}`;
  const f = await fetchSource({ id: `eflux-p${p}`, domain: "e-flux.com", url: u, type: "html", org_zh: "e-flux" }, null);
  if (f.skipped) { console.log(`eflux-p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, u, "e-flux.com", { cap: 30 });
  const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
  console.log(`eflux-p${p} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length}`);
}
console.log("探测完成");
