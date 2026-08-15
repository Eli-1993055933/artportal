// _tmp-probe34.mjs —— 对比单数 type 页面是否重复 + 复数 types 分页
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

async function detailLinks(url, domain) {
  const f = await fetchSource({ id: "x", domain, url, type: "html" }, null);
  if (f.skipped) return null;
  const links = discoverDetailLinks(f.rawHtml, url, domain, { cap: 30 });
  return links.filter(l => /\/opportunity\//.test(l.url)).map(l => l.url);
}

// 对比单数 type
const a = await detailLinks("https://www.artconnect.com/opportunities?type=residency", "artconnect.com");
const b = await detailLinks("https://www.artconnect.com/opportunities?type=open_call", "artconnect.com");
console.log("type=residency:", a?.length, a?.slice(0,3));
console.log("type=open_call:", b?.length, b?.slice(0,3));
console.log("完全重复:", a && b && a.length===b.length && a.every((u,i)=>u===b[i]));

// 复数 types 分页
for (let p = 1; p <= 5; p++) {
  const url = `https://www.artconnect.com/opportunities?types=OPEN_CALL&page=${p}`;
  const f = await fetchSource({ id: `ac-oc-p${p}`, domain: "artconnect.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`types=OPEN_CALL p${p} | SKIPPED (${f.reason})`); continue; }
  const links = discoverDetailLinks(f.rawHtml, url, "artconnect.com", { cap: 30 });
  const detail = links.filter(l => /\/opportunity\//.test(l.url));
  console.log(`types=OPEN_CALL p${p} | 机会详情 ${detail.length}`);
}
