// backfill-screenshots.mjs —— 给"没有封面图"的机会,强制截取其官网页面作为封面。
//
// 目标页:该项目的主办方官网具体页(official_url;上一轮已定位好),截图比首页更贴合。
// 截好存到 site/assets/covers/<hash>.jpg(存我们自己站点,中国用户直接加载),写回 o.cover。
// 在本机跑(北京服务器访问截图服务被 403);跑完把 covers 目录 + 数据一起部署到服务器。
//
// 幂等:只处理还没有任何封面的条目;截到就写 o.cover,下次跳过。截不到就留空,前端退回"设计海报卡"、夜间重试。

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { captureScreenshot } from "./lib/screenshot.mjs";
import { isThirdParty } from "./lib/aggregators.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dir, "..", "site");
const DATA = join(SITE, "data", "opportunities.json");
const COVERS = join(SITE, "assets", "covers");
const CONC = Number(process.env.SHOT_CONC || 3);        // 并发(mShots 免费服务,别太猛)
const MAX = Number(process.env.SHOT_MAX || 300);

// 截图目标:优先主办方官网(非第三方),其次原始 url
function target(o) {
  if (o.official_url && !isThirdParty(o.official_url)) return o.official_url;
  if (o.url && !isThirdParty(o.url)) return o.url;
  return null;
}
// 需要截图 = 完全没有封面 且 有可截的官网页
function needs(o) { return !o.cover && !!target(o); }
const fnameOf = id => createHash("sha1").update(id).digest("hex").slice(0, 16) + ".jpg";

await mkdir(COVERS, { recursive: true });
const data = JSON.parse(await readFile(DATA, "utf8"));
const todo = data.opportunities.filter(needs).slice(0, MAX);
console.log(`共 ${data.opportunities.length} 条,需截图封面 ${todo.length} 条(本次上限 ${MAX},并发 ${CONC})`);
if (!todo.length) process.exit(0);

let done = 0, got = 0;
const results = new Map();     // id -> "assets/covers/xxx.jpg"
const queue = todo.slice();
async function worker() {
  while (queue.length) {
    const o = queue.shift();
    const url = target(o);
    const file = fnameOf(o.id);
    let r = { ok: false };
    try { r = await captureScreenshot(url, join(COVERS, file)); } catch (e) {}
    if (r.ok) { results.set(o.id, "assets/covers/" + file); got++; }
    done++;
    process.stderr.write(`\r进度 ${done}/${todo.length}(截到 ${got})`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
process.stderr.write("\n");

// 回写:重读最新数据,按 id 合并 cover(截图期间检索/翻译可能写过库),原子替换
const fresh = JSON.parse(await readFile(DATA, "utf8"));
const byId = new Map(fresh.opportunities.map(o => [o.id, o]));
let merged = 0;
for (const [id, cover] of results) {
  const o = byId.get(id);
  if (!o || o.cover) continue;          // 期间已被别的途径补了封面就不覆盖
  o.cover = cover;
  o.cover_source = "screenshot";
  merged++;
}
await writeFile(DATA + ".tmp", JSON.stringify(fresh, null, 2), "utf8");
await rename(DATA + ".tmp", DATA);
console.log(`完成:截到 ${got} 张,写回 ${merged} 条。其余留待下次重试(前端先用设计海报卡兜底)。`);
