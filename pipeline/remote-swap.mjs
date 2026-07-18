// remote-swap.mjs —— 在【服务器上】执行的数据替换器(sync-server 调用,v0.72.0)。
// 治的问题:夜间同步"下载快照→本地合并→上传替换"存在一个窗口——窗口内用户在线发布的
// 投稿(写进服务器数据文件)会被上传的合并结果整文件覆盖而静默丢失。
// 做法:替换前读一次【当前 live 文件】,把 live 有而合并稿没有、且不在墓碑里的条目
// 逐条回填进合并稿,再 tmp+rename 原子替换——丢失窗口从秒级 WAN 缩到毫秒级本机读写。
// 用法:node remote-swap.mjs <live路径> <merged临时路径> <listKey> <tombstones路径>

import { readFile, writeFile, rename } from "node:fs/promises";

const [livePath, mergedPath, listKey, tombPath] = process.argv.slice(2);
if (!livePath || !mergedPath || !listKey) { console.error("用法: node remote-swap.mjs <live> <merged> <listKey> [tombstones]"); process.exit(1); }

const merged = JSON.parse(await readFile(mergedPath, "utf8"));
let live = null;
try { live = JSON.parse(await readFile(livePath, "utf8")); } catch (e) {}
let tombs = {};
try {
  const t = JSON.parse(await readFile(tombPath, "utf8"));
  const chName = livePath.split("/").pop().replace(".json", "");
  tombs = t[chName] || {};
} catch (e) {}

let backfilled = 0;
if (live && Array.isArray(live[listKey])) {
  const have = new Set((merged[listKey] || []).map(o => o.id));
  for (const o of live[listKey]) {
    if (!have.has(o.id) && !tombs[o.id]) {     // 快照窗口内新出现(用户投稿/线上检索)且未被删除 → 回填
      merged[listKey].push(o);
      backfilled++;
    }
  }
  if (backfilled && merged.count != null) merged.count = merged[listKey].length;
}
const tmp = livePath + ".tmp-swap";
await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
await rename(tmp, livePath);
console.log(`[remote-swap] ${livePath.split("/").pop()} 已替换` + (backfilled ? `,回填窗口期新增 ${backfilled} 条` : ""));
