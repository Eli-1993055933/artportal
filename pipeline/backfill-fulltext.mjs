// backfill-fulltext.mjs —— 给没有双语原文存档的存量条目补档:
//   抓来源页 → 双语存档(lib/fulltext.mjs,原文侧直存+另一侧 DeepSeek 忠实翻译)→ 写回 fulltext 字段。
// 前端"详情"只对带 .json 存档的条目显示;补一条,线上多一条可展开的(经 sync-server 同步)。
//
// 用法: node --env-file=.env backfill-fulltext.mjs [--cap N] [--channel opportunities|news|jobs]
// 已接入 run-daily.bat(夜间补漏);首次全量跑一遍即可覆盖存量。

import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";
import { saveFulltext } from "./lib/fulltext.mjs";
import { unsafeHost } from "./lib/websearch.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dir, "..", "site");
const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const CAP = parseInt(getOpt("--cap") || "0", 10) || Infinity;   // 默认不限量
const onlyChannel = getOpt("--channel");
const CONC = 4;

const FILES = [
  { ch: "opportunities", path: join(SITE, "data", "opportunities.json"), key: "opportunities", urlOf: o => o.url || o.official_url },
  { ch: "news", path: join(SITE, "data", "news.json"), key: "items", urlOf: o => o.url },
  { ch: "jobs", path: join(SITE, "data", "jobs.json"), key: "jobs", urlOf: o => o.apply_url }
];

for (const F of FILES) {
  if (onlyChannel && F.ch !== onlyChannel) continue;
  const doc = JSON.parse(await readFile(F.path, "utf8"));
  const list = doc[F.key] || [];
  const todo = list.filter(o => o.id && F.urlOf(o) && !(o.fulltext && o.fulltext.endsWith(".json"))).slice(0, CAP);
  console.log(`[${F.ch}] 共 ${list.length} 条,待补档 ${todo.length} 条`);
  if (!todo.length) continue;

  let done = 0, ok = 0;
  const queue = todo.slice();
  async function worker() {
    while (queue.length) {
      const o = queue.shift();
      const url = F.urlOf(o);
      try {
        let host; try { host = new URL(url).host; } catch (e) { throw new Error("bad-url"); }
        if (unsafeHost(host)) throw new Error("unsafe-host");
        const f = await fetchSource({ url, domain: host, type: "html" });
        if (f.skipped || !f.text || f.text.length < 100) throw new Error(f.reason || "thin");
        const ft = await saveFulltext(o.id, f.text);
        if (ft) { o.fulltext = ft; ok++; }
      } catch (e) { /* 单条失败继续,下次再试 */ }
      done++;
      process.stderr.write(`\r  [${F.ch}] ${done}/${todo.length}(成功 ${ok})`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stderr.write("\n");

  // 重读合并写回(防跑批期间检索又入了新条目被快照覆盖)
  const fresh = JSON.parse(await readFile(F.path, "utf8"));
  const ftById = new Map(todo.filter(o => o.fulltext).map(o => [o.id, o.fulltext]));
  let applied = 0;
  for (const o of (fresh[F.key] || [])) {
    const ft = ftById.get(o.id);
    if (ft && !(o.fulltext && o.fulltext.endsWith(".json"))) { o.fulltext = ft; applied++; }
  }
  const tmp = F.path + ".tmp-ftbf-" + process.pid;
  await writeFile(tmp, JSON.stringify(fresh, null, 2), "utf8");
  await rename(tmp, F.path);
  console.log(`  [${F.ch}] 补档成功 ${ok} 条,写回 ${applied} 条`);
}
console.log("完成");
