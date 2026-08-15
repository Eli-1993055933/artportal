// _tmp-probe18.mjs —— 深入 artjobs.com:找真实机会列表链接结构
import { fetchSource } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

// 抓 open-calls 页,看文本和真实详情链接
const f = await fetchSource({ id: "artjobs-oc", domain: "artjobs.com", url: "https://www.artjobs.com/open-calls", type: "html", org_zh: "artjobs" }, null);
if (f.skipped) { console.log("SKIPPED", f.reason); process.exit(0); }
console.log("=== 文本片段(前2000字) ===");
console.log((f.text||"").slice(0, 2000));
console.log("\n=== 全部站内链接 ===");
const all = [...new Set([...(f.rawHtml||"").matchAll(/href="([^"#?]*?)"/g)].map(m=>m[1]))].filter(u=>/artjobs\.com|^\//.test(u));
all.slice(0, 60).forEach(u=>console.log(u));
console.log("\n=== 详情链接(discover) ===");
const links = discoverDetailLinks(f.rawHtml, "https://www.artjobs.com/open-calls", "artjobs.com", { cap: 40 });
links.slice(0, 40).forEach(l=>console.log(l.url));
