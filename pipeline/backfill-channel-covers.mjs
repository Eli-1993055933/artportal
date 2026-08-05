// backfill-channel-covers.mjs —— 给资讯(news.json)/招聘(jobs.json)截取封面。
//
// 资讯截原文页(url)、招聘截申请/机构页(apply_url),用 mShots(见 lib/screenshot.mjs),
// 存 site/assets/covers/<sha1>.jpg(我们自己服务器,国内可直接加载),写回 item.cover。
// 无封面时前端已用"设计海报卡"兜底;这里截到就升级成真实页面截图。
//
// 用法: cd pipeline && node backfill-channel-covers.mjs

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { captureScreenshot, closeShotBrowser } from "./lib/screenshot.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dir, "..", "site");
const COVERS = join(SITE, "assets", "covers");
const CONC = Number(process.env.SHOT_CONC || 3);

const FILES = [
  { path: join(SITE, "data", "news.json"), key: "items", urlOf: o => o.url },
  { path: join(SITE, "data", "jobs.json"), key: "jobs",  urlOf: o => o.apply_url }
];
const fnameOf = id => createHash("sha1").update(id).digest("hex").slice(0, 16) + ".jpg";

await mkdir(COVERS, { recursive: true });
for (const F of FILES) {
  const data = JSON.parse(await readFile(F.path, "utf8"));
  const arr = data[F.key] || [];
  const todo = arr.filter(o => !o.cover && F.urlOf(o));
  console.log(`${F.key}: 需截封面 ${todo.length}/${arr.length} 条`);
  if (!todo.length) continue;

  let done = 0, got = 0;
  const results = new Map();
  const queue = todo.slice();
  async function worker() {
    while (queue.length) {
      const o = queue.shift();
      const file = fnameOf(o.id);
      let r = { ok: false };
      try { r = await captureScreenshot(F.urlOf(o), join(COVERS, file)); } catch (e) {}
      if (r.ok) { results.set(o.id, "assets/covers/" + file); got++; }
      done++;
      process.stderr.write(`\r  ${F.key} ${done}/${todo.length}(截到 ${got})`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  process.stderr.write("\n");

  // 重读合并写回(原子)
  const fresh = JSON.parse(await readFile(F.path, "utf8"));
  const byId = new Map((fresh[F.key] || []).map(o => [o.id, o]));
  for (const [id, cover] of results) { const o = byId.get(id); if (o && !o.cover) { o.cover = cover; o.cover_source = "screenshot"; } }
  await writeFile(F.path + ".tmp", JSON.stringify(fresh, null, 2), "utf8");
  await rename(F.path + ".tmp", F.path);
  console.log(`  ${F.key}: 截到 ${got} 张`);
}
console.log("完成");
await closeShotBrowser();   // puppeteer 模式必须收浏览器,否则进程不退出;mShots 模式空操作
