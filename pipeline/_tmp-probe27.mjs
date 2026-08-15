// _tmp-probe27.mjs —— artdeadlines 结构探测
import { fetchSource } from "./lib/fetch.mjs";
import { htmlToText } from "./lib/fetch.mjs";

const urls = [
  ["ad-main", "https://www.artdeadlines.com/"],
  ["ad-opportunities", "https://www.artdeadlines.com/opportunities"],
  ["ad-calls", "https://www.artdeadlines.com/calls-for-artists"],
];

for (const [id, url] of urls) {
  const f = await fetchSource({ id, domain: "artdeadlines.com", url, type: "html" }, null);
  if (f.skipped) { console.log(`${id} | SKIPPED (${f.reason})`); continue; }
  const t = f.text || "";
  // 找链接
  const links = [...(f.rawHtml || "").matchAll(/href="([^"]+)"/g)].map(m => m[1]).filter(h => /artdeadlines\.com/.test(h) && !/\.(css|js|png|jpg|svg|ico)/i.test(h));
  const uniq = [...new Set(links)];
  console.log(`${id} | HTTP ${f.httpStatus ?? f.status} | 文本 ${t.length} | 链接 ${uniq.length}`);
  uniq.slice(0, 30).forEach(u => console.log("   ", u));
  console.log("--- 文本片段 ---");
  console.log(t.slice(0, 500));
  console.log("");
}
