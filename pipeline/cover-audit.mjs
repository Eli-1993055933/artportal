// cover-audit.mjs —— 封面审核 agent(用户 2026-07-18 要求:封面绝不雷同、绝不错放)。
//
// 背景 bug:聚合平台(CuratorSpace 等)页面的 og:image 是站点通用海报(如"ROAR"那张),
// 被回填成了多个不同项目的封面——图与项目毫无关系,且大面积雷同。
//
// 审计规则(三频道每晚跑,幂等,无问题秒退):
//   ① 同一图 URL 被 >1 条目共用 → 判为"站点通用图",整组作废(含第一个用它的:通用图不属于任何项目);
//   ② 本地截图文件内容相同(md5)→ 同上;
//   ③ 封面 URL 含第三方聚合域名(curatorspace 的 S3 bucket 等)→ 单条也作废。
// 修复(逐条,宁缺毋滥):
//   1) 机会频道若没有可用官网页 → locateOfficial(按标题+主办方 serper 检索 + DeepSeek 核实)重定位一次;
//   2) 抓目标页(官网具体页)og:image:须【非第三方域名 + 非通用图特征 + 全站唯一】才采用;
//   3) 不行 → mShots 截图目标页(本机跑,服务器访问 mShots 被 403);截图内容 md5 仍须全站唯一;
//   4) 都不行 → 封面置空(前端"设计海报卡"兜底)——找不到宁愿不放,绝不错放。
// 改动条目 bump updated_at,夜间 sync-server 按"新者胜"同步到服务器;封面文件由 sync 增量补传。
// 用法:node cover-audit.mjs [--dry]

import { readFile, writeFile, rename, mkdir, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchSource } from "./lib/fetch.mjs";
import { extractCover, looksGeneric } from "./lib/cover.mjs";
import { captureScreenshot } from "./lib/screenshot.mjs";
import { isThirdParty, THIRD_PARTY } from "./lib/aggregators.mjs";
import { locateOfficial } from "./lib/locate-official.mjs";
import { reportAgent } from "./lib/agent-report.mjs";
const T0 = Date.now();

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dir, "..", "site");
const COVERS = join(SITE, "assets", "covers");
const DRY = process.argv.includes("--dry");
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

const FILES = [
  { path: join(SITE, "data", "opportunities.json"), key: "opportunities", kind: "opp" },
  { path: join(SITE, "data", "news.json"), key: "items", kind: "news" },
  { path: join(SITE, "data", "jobs.json"), key: "jobs", kind: "job" }
];

// 封面 URL 是否沾第三方聚合(域名命中,或 URL 字符串携带聚合域名——覆盖 s3.…/curatorspace.com/… 这类桶路径)
function coverIsThirdParty(u) {
  if (!u || u.startsWith("assets/")) return false;
  if (isThirdParty(u)) return true;
  const s = String(u).toLowerCase();
  return THIRD_PARTY.some(t => s.includes(t));
}
async function md5File(p) {
  try { return createHash("md5").update(await readFile(p)).digest("hex"); } catch (e) { return null; }
}
const shotName = id => createHash("sha1").update(id).digest("hex").slice(0, 16) + ".jpg";

// —— 1. 读全部数据,建全局封面登记簿(URL 集合 + 本地文件 md5 集合) ——
const docs = [];
for (const f of FILES) {
  try { docs.push({ ...f, doc: JSON.parse(await readFile(f.path, "utf8")) }); }
  catch (e) { console.log("跳过(读不到):", f.path); }
}
const allItems = [];
for (const d of docs) for (const o of (d.doc[d.key] || [])) allItems.push({ o, kind: d.kind, d });

const urlUse = new Map();     // cover 值 -> [items]
const md5Use = new Map();     // 本地文件 md5 -> [items]
for (const it of allItems) {
  const c = it.o.cover;
  if (!c) continue;
  (urlUse.get(c) || urlUse.set(c, []).get(c)).push(it);
  if (c.startsWith("assets/covers/")) {
    const h = await md5File(join(SITE, c.replace("assets/covers/", "assets/covers/")));
    it.md5 = h;
    if (h) (md5Use.get(h) || md5Use.set(h, []).get(h)).push(it);
  }
}

// —— 2. 判定坏封面 ——
const bad = new Set();
const reasons = new Map();
for (const [u, items] of urlUse) if (items.length > 1) for (const it of items) { bad.add(it); reasons.set(it, "URL 共用×" + items.length); }
for (const [h, items] of md5Use) if (items.length > 1) for (const it of items) { if (!bad.has(it)) { bad.add(it); reasons.set(it, "截图内容相同×" + items.length); } }
for (const it of allItems) {
  if (it.o.cover && coverIsThirdParty(it.o.cover) && !bad.has(it)) { bad.add(it); reasons.set(it, "封面图来自第三方聚合"); }
}
console.log(`封面审计:共 ${allItems.length} 条,有封面 ${[...urlUse.values()].flat().length} 条,坏封面 ${bad.size} 条`);
if (!bad.size) {
  console.log("✓ 无雷同/错放封面,收工");
  await reportAgent("cover-auditor", true, "巡检完毕:无雷同/错放封面", { checked: allItems.length }, Date.now() - T0);
  process.exit(0);
}
for (const it of bad) console.log("  ✗", it.kind, String(it.o.id).slice(0, 56), "|", reasons.get(it));
if (DRY) { console.log("(--dry 只报告,未改动)"); process.exit(0); }

// 修复期间的全局唯一闸:现存好封面的 URL 与 md5(坏的排除在外,腾出重截空间)
const usedUrls = new Set([...urlUse.keys()].filter(u => !(urlUse.get(u) || []).every(it => bad.has(it))));
const usedMd5 = new Set();
for (const [h, items] of md5Use) if (!items.every(it => bad.has(it))) usedMd5.add(h);

// —— 3. 逐条修复 ——
function targetPage(it) {
  const o = it.o;
  if (it.kind === "opp") {
    if (o.official_url && !isThirdParty(o.official_url)) return o.official_url;
    if (o.url && !isThirdParty(o.url)) return o.url;
    return null;
  }
  const u = it.kind === "job" ? (o.apply_url || o.url) : o.url;
  return u && !isThirdParty(u) ? u : null;
}
async function validateImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { "User-Agent": "ArtPortalBot/0.1 (+cover audit)" } });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const len = parseInt(res.headers.get("content-length") || "0", 10);
    try { res.body && res.body.cancel(); } catch (e) {}
    return res.ok && ct.startsWith("image/") && !(len && len < 3000);
  } catch (e) { return false; }
}

await mkdir(COVERS, { recursive: true });
let fixedOg = 0, fixedShot = 0, relocated = 0, emptied = 0;
for (const it of bad) {
  const o = it.o;
  const oldCover = o.cover;
  o.cover = null;
  delete o.cover_source;
  delete o.cover_generic;
  o.updated_at = today;                        // sync"新者胜":审计结果覆盖服务器旧封面
  o.cover_audit = today + " 审核撤换(" + reasons.get(it) + ")";
  let page = targetPage(it);
  // 3.1 机会且无官网页:按标题+主办方重新联网定位一次官网(找不到就算了,绝不硬凑)
  if (!page && it.kind === "opp") {
    try {
      const loc = await locateOfficial({ title: o.title_zh || o.title_en || "", org: o.org_zh || "", city: o.city_zh || "", country: o.country_zh || "" }, {});
      if (loc && loc.url && !isThirdParty(loc.url)) {
        o.official_url = loc.url;
        o.official_located = today + " cover-audit";
        page = loc.url;
        relocated++;
        console.log("  ↳ 重定位到官网:", o.id.slice(0, 40), "→", loc.url.slice(0, 60));
      }
    } catch (e) {}
  }
  if (!page) { emptied++; console.log("  ∅ 无可用官网页,封面置空(设计海报卡兜底):", String(o.id).slice(0, 50)); continue; }
  // 3.2 官网页 og:image(非第三方 + 非通用 + 全站唯一)
  let done = false;
  try {
    const f = await fetchSource({ url: page, domain: new URL(page).host, type: "html" });
    if (!f.skipped && f.rawHtml) {
      const og = extractCover(f.rawHtml, page);
      if (og && !coverIsThirdParty(og) && !looksGeneric(og, o.domain) && !usedUrls.has(og) && await validateImage(og)) {
        o.cover = og;
        o.cover_source = new URL(page).host.replace(/^www\./, "");
        usedUrls.add(og);
        fixedOg++; done = true;
        console.log("  ✓ og 封面:", String(o.id).slice(0, 50));
      }
    }
  } catch (e) {}
  // 3.3 mShots 截图官网具体页(内容 md5 全站唯一才收;聚合站模板同图会被拒)
  if (!done) {
    const file = shotName(o.id);
    try {
      const r = await captureScreenshot(page, join(COVERS, file));
      if (r && r.ok) {
        const h = await md5File(join(COVERS, file));
        if (h && !usedMd5.has(h)) {
          o.cover = "assets/covers/" + file;
          o.cover_source = "screenshot";
          usedMd5.add(h);
          fixedShot++; done = true;
          console.log("  ✓ 截图封面:", String(o.id).slice(0, 50));
        } else {
          await unlink(join(COVERS, file)).catch(() => {});   // 截出来还是同一张(站点通用模板)→ 不要
        }
      }
    } catch (e) {}
  }
  if (!done) { emptied++; console.log("  ∅ 未找到可信封面,置空:", String(o.id).slice(0, 50)); }
  if (oldCover && oldCover.startsWith("assets/covers/") && o.cover !== oldCover) {
    // 旧本地截图文件若已无人引用,清掉(所有引用者都在坏名单里且没再用它)
    const stillUsed = allItems.some(x => x.o.cover === oldCover);
    if (!stillUsed) await unlink(join(SITE, oldCover)).catch(() => {});
  }
}

// —— 4. 原子写回 ——
for (const d of docs) {
  const tmp = d.path + ".tmp-audit";
  await writeFile(tmp, JSON.stringify(d.doc, null, 2), "utf8");
  await rename(tmp, d.path);
}
console.log(`\n===== 封面审计完成 =====`);
console.log(`撤换 ${bad.size} 条:og 重取 ${fixedOg} · 官网截图 ${fixedShot} · 重定位官网 ${relocated} · 置空(宁缺毋滥) ${emptied}`);
console.log(`数据已写回;夜间 sync-server 会把结果同步到服务器(封面文件增量补传)。`);
await reportAgent("cover-auditor", true, `撤换 ${bad.size} 条雷同/错放封面:og 重取 ${fixedOg} · 截图 ${fixedShot} · 重定位 ${relocated} · 置空 ${emptied}`,
  { bad: bad.size, og: fixedOg, shot: fixedShot, relocated, emptied }, Date.now() - T0);
const { closeShotBrowser } = await import("./lib/screenshot.mjs");
await closeShotBrowser();   // puppeteer 模式必须收浏览器,否则进程不退出;mShots 模式空操作
