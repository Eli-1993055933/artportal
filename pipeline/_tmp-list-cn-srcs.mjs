// _tmp-list-cn-srcs.mjs —— 列出国内可收割的征稿/赛事类官方源
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dir = dirname(fileURLToPath(import.meta.url));
const src = JSON.parse(readFileSync(join(__dir, "sources.json"), "utf8"));
const list = src.sources || [];
const loud = /opencall|award|grant|competition|biennale|fellowship|residency|评比|展览|征稿/i;
for (const s of list) {
  if (s.reachable === false) continue;
  if (!String(s.domain || "").endsWith(".cn")) continue;
  const cat = Array.isArray(s.category_hint) ? s.category_hint.join(",") : "";
  if (!loud.test(cat)) continue;
  console.log(`${s.id}\t${s.domain}\t${cat}\t${s.url}`);
}