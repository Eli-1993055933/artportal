// _tmp-probe13.mjs —— 探测 e-flux announcements 结构 + ArtConnect 更深分页
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

// e-flux announcements 详情链接 + 判断内容类型
const ef = { id: "eflux-ann", domain: "e-flux.com", url: "https://www.e-flux.com/announcements/", type: "html", org_zh: "e-flux" };
const efF = await fetchSource(ef, null);
console.log("e-flux | HTTP", efF.httpStatus ?? efF.status, "| 文本", (efF.text||"").length);
const eflinks = discoverDetailLinks(efF.rawHtml, "https://www.e-flux.com/announcements/", "e-flux.com", { cap: 30 });
console.log("e-flux 详情链接:", eflinks.length);
eflinks.slice(0, 10).forEach(l => console.log("  ", l.url));

// e-flux 是否有 ?page= 分页
const p2 = await fetchSource({ id: "eflux-p2", domain: "e-flux.com", url: "https://www.e-flux.com/announcements/?page=2", type: "html", org_zh: "e-flux" }, null);
console.log("e-flux ?page=2 |", p2.httpStatus ?? p2.status, "| 文本", (p2.text||"").length, p2.skipped ? `(${p2.reason})` : "");
if (!p2.skipped) {
  const l2 = discoverDetailLinks(p2.rawHtml, "https://www.e-flux.com/announcements/?page=2", "e-flux.com", { cap: 20 });
  console.log("e-flux ?page=2 详情:", l2.length);
}

// ArtConnect p21-p30 快速探测
for (let p = 21; p <= 30; p++) {
  const f = await fetchSource({ id: `ac-p${p}`, domain: "artconnect.com", url: `https://www.artconnect.com/opportunities?page=${p}`, type: "html", org_zh: "ArtConnect" }, null);
  if (f.skipped) { console.log(`artconnect-p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, "", "artconnect.com", { cap: 30 });
  const detail = links.filter(l => !/\.(css|js|png|ico|jpg|svg|xml)$/.test(l.url));
  console.log(`artconnect-p${p} | HTTP ${f.httpStatus ?? f.status} | 详情 ${detail.length}`);
  if (!detail.length) break;
}
console.log("探测完成");
