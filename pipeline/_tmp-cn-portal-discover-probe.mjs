// _tmp-cn-portal-discover-probe.mjs —— 探测门户源能否 discover 出同域详情链接(纯fetch,零LLM)
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource, htmlToText } from "./lib/fetch.mjs";
import { discoverDetailLinks } from "./lib/discover.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(__dir, "_tmp-cn-portal-srcs.txt"), "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
const out = [];
for (const line of lines) {
  const u0 = line.split("\t")[0].split("#")[0].trim();
  let host; try { host = new URL(u0).host; } catch (e) { continue; }
  const domain = host.replace(/^www\./, "");
  let f, ftLen = 0, skip = "";
  try {
    f = await fetchSource({ url: u0, domain: host, type: "html" }, null, { timeoutMs: 10000 });
    ftLen = (f && f.text) ? f.text.length : 0;
    skip = (f && f.skipped) ? f.reason : "ok";
  } catch (e) { skip = "err"; ftLen = 0; }
  let links = [];
  if (f && !f.skipped && f.rawHtml) {
    try { links = discoverDetailLinks(f.rawHtml, u0, domain, { cap: 15 }); } catch (e) { links = []; }
  }
  // 统计看起来像"征稿通知"标题的链接
  const opp = links.filter(l => /(征集|征稿|招募|驻留|双年展|三年展|展览|open|推优|申报|大赛)/.test(l.text || ""));
  console.log(`${domain}: list=${ftLen}(${skip}) | 详情链接=${links.length} | 征稿类=${opp.length}`);
  if (links.length >= 3) {
    out.push({ domain, url: u0, count: links.length });
    for (const l of links.slice(0, 5)) console.log(`    ~ ${l.text}  ${l.url}`);
  }
}
console.log("\n=== 可展开源(≥3详情) ===");
for (const o of out) console.log(`  ${o.domain}\t${o.url}\t${o.count}`);