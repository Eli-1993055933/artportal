// _tmp-resolve-backfill.mjs —— 一次性存量回填:给现有"转载/可信平台入口"的机会补官方官网。
// 走 lib/resolve-official.mjs 四关卡溯源;搜索共享全站预算(who="resolve-official"),
// 且本批设 searchedCap(默认 80)内层限额,配额/预算耗尽即停,剩余留待下一批。
//
// 只处理需要溯源的条目(出站是第三方/可信平台、且没有真官网),已有真官网的跳过。
// 反幻觉:official_url 只写验证过的候选,定位不到就如实保留(via_repost/source_platform 标注),绝不硬造。
// 用法: node --env-file=.env _tmp-resolve-backfill.mjs [--cap <搜索次数>] [--only <id,id>] [--dry]
import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolve, needsResolve, classifySource } from "./lib/resolve-official.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const DRY = args.includes("--dry");
const SEARCH_CAP = Math.max(1, parseInt(getOpt("--cap") || "400", 10) || 400);
const onlyIds = (getOpt("--only") || "").split(",").map(s => s.trim()).filter(Boolean);

const data = JSON.parse(await readFile(DATA, "utf8"));
const pool = data.opportunities.filter(o => !onlyIds.length || onlyIds.includes(o.id));
const todo = pool.filter(needsResolve);

const initial = data.opportunities.length;
console.log(`总 ${initial} 条,需溯源 ${todo.length} 条(本批搜索预算 ${SEARCH_CAP},${DRY ? "干跑不写盘" : "会写盘"})`);
if (!todo.length) process.exit(0);

let searched = 0, resolved = 0, notFound = 0;
function hostOfUrl(u) { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } }

// 并发池:每 worker 串行取一条处理,多条并行 → 显著加速存量回填。
// 预算按条预扣(reserve=PER_ITEM 次搜索上限/条),全局 searched 共享控制 cap;超日配额由 websearch 账本兜底。
const CONCURRENCY = Math.max(1, parseInt(process.env.RESOLVE_CONC || "4", 10) || 4);
const PER_ITEM = 12; // 每条最多使用搜索次数(单条候选通常 2 次内定位)

function processRecord(o) {
  const item = { title: o.title_zh || o.title_en || "", org: o.org_zh || o.org_en || null };
  const src = { domain: hostOfUrl(o.url || ""), name_zh: o.org_zh, org_zh: o.org_zh };
  return resolve(item, src, { budget: Math.min(PER_ITEM, Math.max(1, SEARCH_CAP - searched)), maxProbe: 6 })
    .then(r => {
      searched += (r.searched || 0);
      if (r.official_url) {
        o.official_url = r.official_url;
        o.official_located = r.official_located;
        if (r.via_repost) o.via_repost = true;
        if (r.source_platform) o.source_platform = r.source_platform;
        resolved++;
        process.stderr.write(`\n  ✓ ${(o.title_zh || o.title_en || o.id).slice(0, 30)} → ${r.official_located} ${r.official_url}`);
      } else {
        if (r.via_repost) o.via_repost = true;
        if (r.source_platform) o.source_platform = r.source_platform;
        if (!o.official_url) o.official_url = null;
        notFound++;
        process.stderr.write(`\n  · ${(o.title_zh || o.title_en || o.id).slice(0, 30)} 未定位(${r.official_located || r.classify})`);
      }
    })
    .catch(() => {}); // 单条失败不中断整批
}

async function worker() {
  while (true) {
    if (searched >= SEARCH_CAP) break;
    const o = todo[cursor++];
    if (!o) break;
    await processRecord(o);
  }
}
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
process.stderr.write("\n");
console.log(`已定位 ${resolved} / 未定位 ${notFound} / 搜索用了 ${searched} 次;剩余 ${todo.length - resolved - notFound} 条留待下批`);

if (DRY) { console.log(`\n[--dry] 本轮可溯源:已定位 ${resolved} 条 / 未定位 ${notFound} 条,未写盘。`); process.exit(0); }

// 原子回写(带时间戳备份)
const backup = join(__dir, "..", "site", "data", "opportunities.json.bak-resolve-" + Date.now());
await copyFile(DATA, backup);
await writeFile(DATA + ".tmp", JSON.stringify(data, null, 2), "utf8");
await rename(DATA + ".tmp", DATA);
console.log(`\n完成:已定位 ${resolved} / 未定位 ${notFound} / 搜索用了 ${searched} 次。备份:${backup}`);