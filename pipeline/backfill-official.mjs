// backfill-official.mjs —— 给"前往官网"仍指向第三方(聚合/新闻/门户)的机会,定位主办方真官网。
//
// 每晚随管道跑(run-daily.bat):新入库的第三方链接条目会被逐步补上 official_url。
// 复用 lib/locate-official.mjs(serper 搜索 + 抓取 + DeepSeek 核实),严守反幻觉:只写核实过的真 URL。
//
// 幂等:只处理"出站是第三方且尚无 official_url"的条目;找不到就留着下次再试。
// 一次性大批量回填由多智能体工作流完成,这里主要覆盖日常增量。

import { readFile, writeFile, rename } from "node:fs/promises";
import { reportAgent } from "./lib/agent-report.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { locateOfficial } from "./lib/locate-official.mjs";
import { isThirdParty } from "./lib/aggregators.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const CONCURRENCY = 4;
const MAX = Number(process.env.LOCATE_MAX || 40);   // 单次最多处理多少条(控时;夜间增量足够)

const outbound = o => o.official_url || o.url || null;
function needs(o) {
  if (o.official_url && !isThirdParty(o.official_url)) return false;   // 已有真官网
  const ob = outbound(o);
  return ob && isThirdParty(ob);                                       // 出站是第三方 → 需要定位
}

const data = JSON.parse(await readFile(DATA, "utf8"));
const todo = data.opportunities.filter(needs).slice(0, MAX);
console.log(`共 ${data.opportunities.length} 条,需定位官网 ${todo.length} 条(本次上限 ${MAX})`);
if (!todo.length) process.exit(0);

let done = 0, found = 0;
const results = new Map();
const queue = todo.slice();
async function worker() {
  while (queue.length) {
    const o = queue.shift();
    let r = null;
    try { r = await locateOfficial({ title: o.title_zh || o.title_en, org: o.org_zh || o.org_en, city: o.city_zh, country: o.country_zh }); }
    catch (e) {}
    if (r && r.url && !isThirdParty(r.url)) { results.set(o.id, r); found++; }
    done++;
    process.stderr.write(`\r进度 ${done}/${todo.length}(定位到 ${found})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stderr.write("\n");

// 回写:重读最新数据,按 id 合并 official_url(翻译/检索可能在此期间写过库),原子替换
const fresh = JSON.parse(await readFile(DATA, "utf8"));
const byId = new Map(fresh.opportunities.map(o => [o.id, o]));
let merged = 0;
for (const [id, r] of results) {
  const o = byId.get(id);
  if (!o) continue;
  o.official_url = r.url;
  o.official_located = r.level;   // "specific" | "org":诚实标注定位精度
  merged++;
}
await writeFile(DATA + ".tmp", JSON.stringify(fresh, null, 2), "utf8");
await rename(DATA + ".tmp", DATA);
console.log(`完成:定位到 ${found} 条,写回 ${merged} 条。其余留待下次重试。`);
await reportAgent("locator", true, `官网定位:定位到 ${found} 条,写回 ${merged} 条`, { found, merged });
