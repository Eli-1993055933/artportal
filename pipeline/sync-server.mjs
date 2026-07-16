// sync-server.mjs —— 数据双轨终结者:本机与服务器的数据【按条合并】双向同步,谁的数据都不丢。
//
// 解决的问题:本机每晚抓取写本机文件,线上访客检索写服务器文件,两份各自增长;
// 旧部署方式是整文件覆盖,会把服务器独有数据(访客检索入库、将来的评论/投稿)冲掉。
//
// 同步策略(对三个频道文件 opportunities/news/jobs 各自执行):
//   1. 从服务器拉当前数据 → 2. 与本地按 id 逐条合并:
//      · 只在一边存在 → 保留
//      · 两边都有 → 人工核实(verified)优先;其次比 updated_at/added_at 新者胜;平手偏本地
//        (本地每晚有翻译/封面增强)
//      · 合并后按 url 再去一次重(不同 id 同 url 只留一条)
//   3. 合并结果同时写回【本地】和【服务器】(两边收敛到同一份;服务器先备份再替换)
//   4. 封面增量上传:只传服务器缺的截图文件
//
// 安全阀:任何一边文件拉取/解析失败 → 该频道跳过,绝不拿空数据覆盖;
//        合并结果条数 < max(两边) 时拒绝写(合并只可能增不可能减)。
//
// 用法: node sync-server.mjs            全量同步(三频道数据 + 封面)
//       node sync-server.mjs --dry      只算不写,打印将发生什么
// 已接入 run-daily.bat 末尾:每晚抓完自动同步上线,无需人工部署数据。

import { readFile, writeFile, rename, mkdir, readdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dir, "..", "site");
const TMP = join(__dir, "state", "sync-tmp");
const HOST = process.env.SYNC_HOST || "admin@60.205.212.195";
const RBASE = "/home/admin/artportal";
const DRY = process.argv.includes("--dry");

const CHANNELS = [
  { file: "opportunities.json", key: "opportunities", urlOf: o => o.url },
  { file: "news.json", key: "items", urlOf: o => o.url },
  { file: "jobs.json", key: "jobs", urlOf: o => o.apply_url }
];

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
function ssh(cmd) { return execFileSync("ssh", [...SSH_OPTS, HOST, cmd], { encoding: "utf8", timeout: 120000 }); }
function scpDown(remote, local) { execFileSync("scp", [...SSH_OPTS, HOST + ":" + remote, local], { timeout: 300000 }); }
function scpUp(local, remote) { execFileSync("scp", [...SSH_OPTS, local, HOST + ":" + remote], { timeout: 600000 }); }

// —— 合并核心(纯函数,可单测)——
export function mergeLists(localList, remoteList, urlOf) {
  const byId = new Map();
  for (const r of remoteList) byId.set(r.id, r);
  let fromLocal = 0, fromRemote = remoteList.length, replaced = 0;
  for (const l of localList) {
    const r = byId.get(l.id);
    if (!r) { byId.set(l.id, l); fromLocal++; continue; }
    const win = pickWinner(l, r);
    if (win === l) { byId.set(l.id, l); replaced++; }
  }
  // url 去重:不同 id 同 url 只留先入的一条(保序:服务器在前、本地新增在后)
  const seenUrl = new Set(), out = [];
  let urlDropped = 0;
  for (const o of byId.values()) {
    const u = urlOf(o);
    if (u && seenUrl.has(u)) { urlDropped++; continue; }
    if (u) seenUrl.add(u);
    out.push(o);
  }
  return { list: out, stats: { fromRemote, addedFromLocal: fromLocal, localWonOnConflict: replaced, urlDropped } };
}
function pickWinner(l, r) {
  let win, lose;
  // 人工核实的记录绝不被自动记录顶掉
  if (r.trust === "verified" && l.trust !== "verified") { win = r; lose = l; }
  else if (l.trust === "verified" && r.trust !== "verified") { win = l; lose = r; }
  else {
    const key = o => String(o.updated_at || o.added_at || o.last_seen || "");
    win = key(r) > key(l) ? r : l;   // 新者胜;平手偏本地(本地有夜间增强)
    lose = win === r ? l : r;
  }
  // 单侧独有的增强字段(封面)嫁接给胜者,不因合并丢失
  if (!win.cover && lose.cover) { win.cover = lose.cover; win.cover_source = lose.cover_source; }
  return win;
}

async function readJsonStrict(path) {
  const raw = await readFile(path, "utf8");           // 失败就抛:绝不拿空数据参与合并
  const d = JSON.parse(raw);
  return d;
}

async function syncChannel(ch) {
  const localPath = join(SITE, "data", ch.file);
  const remoteTmp = join(TMP, "remote-" + ch.file);
  // 1) 拉服务器当前版本
  scpDown(`${RBASE}/site/data/${ch.file}`, remoteTmp);
  const localDoc = await readJsonStrict(localPath);
  const remoteDoc = await readJsonStrict(remoteTmp);
  const localList = localDoc[ch.key] || [];
  const remoteList = remoteDoc[ch.key] || [];
  // 2) 合并
  const { list, stats } = mergeLists(localList, remoteList, ch.urlOf);
  const floor = Math.max(localList.length, remoteList.length) - stats.urlDropped;
  if (list.length < floor) throw new Error(`${ch.file} 合并结果 ${list.length} < 下限 ${floor},拒绝写入`);
  console.log(`[${ch.file}] 本地 ${localList.length} + 服务器 ${remoteList.length} → 合并 ${list.length}` +
    `(服务器独有保留,本地新增 ${stats.addedFromLocal},冲突本地胜 ${stats.localWonOnConflict},同URL去重 ${stats.urlDropped})`);
  if (DRY) return;
  // 3) 写两边(本地原子写;服务器先备份再替换)
  const merged = { ...localDoc, generated_at: todayISO(), count: list.length };
  merged[ch.key] = list;
  const body = JSON.stringify(merged, null, 2);
  const localTmp = localPath + ".tmp-sync";
  await writeFile(localTmp, body, "utf8");
  await rename(localTmp, localPath);
  const upTmp = join(TMP, "merged-" + ch.file);
  await writeFile(upTmp, body, "utf8");
  scpUp(upTmp, `/tmp/merged-${ch.file}`);
  ssh(`cp ${RBASE}/site/data/${ch.file} ${RBASE}/site/data/${ch.file}.bak && mv /tmp/merged-${ch.file} ${RBASE}/site/data/${ch.file}`);
}

// 目录增量上传:只传服务器没有的文件(封面截图、原文存档共用)
async function syncDir(relDir, ext, label) {
  const dir = join(SITE, "..", relDir);
  let localFiles;
  try { localFiles = (await readdir(dir)).filter(f => f.endsWith(ext)); } catch (e) { return console.log(`[${label}] 本地无目录,跳过`); }
  const remoteSet = new Set(ssh(`ls ${RBASE}/${relDir} 2>/dev/null || true`).split("\n").map(s => s.trim()).filter(Boolean));
  const missing = localFiles.filter(f => !remoteSet.has(f));
  console.log(`[${label}] 本地 ${localFiles.length} 个,服务器缺 ${missing.length} 个`);
  if (!missing.length || DRY) return;
  const listFile = join(TMP, label + "-list.txt");
  await writeFile(listFile, missing.map(f => relDir + "/" + f).join("\n"), "utf8");
  const tarFile = join(TMP, label + ".tar.gz");
  // tar 一律用 cwd+相对路径:GNU tar 会把 Windows 盘符 "D:" 当远程主机(Cannot connect to D:)
  execFileSync("tar", ["czf", "pipeline/state/sync-tmp/" + label + ".tar.gz", "-T", "pipeline/state/sync-tmp/" + label + "-list.txt"],
    { cwd: join(SITE, ".."), timeout: 300000 });
  scpUp(tarFile, `/tmp/${label}-sync.tar.gz`);
  ssh(`cd ${RBASE} && tar xzf /tmp/${label}-sync.tar.gz && rm /tmp/${label}-sync.tar.gz`);
  console.log(`[${label}] 已补传 ${missing.length} 个`);
}
const syncCovers = () => syncDir("site/assets/covers", ".jpg", "covers");

async function main() {
  await mkdir(TMP, { recursive: true });
  const failed = [];
  for (const ch of CHANNELS) {
    try { await syncChannel(ch); }
    catch (e) { failed.push(ch.file + ": " + (e.message || e)); console.error(`[${ch.file}] 同步失败:`, e.message || e); }
  }
  try { await syncCovers(); }
  catch (e) { failed.push("covers: " + (e.message || e)); console.error("[covers] 同步失败:", e.message || e); }
  await rm(TMP, { recursive: true, force: true });
  if (failed.length) { console.error(`\n[sync] 有 ${failed.length} 项失败(其余已完成):`, failed.join(" | ")); process.exit(1); }
  console.log(DRY ? "\n[sync] dry-run 完成,未写任何文件" : "\n[sync] 双向同步完成:本地与服务器已收敛到同一份数据");
}

// 仅直接运行时执行(mergeLists 可被单测 import)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  main().catch(e => { console.error("[sync] 异常:", e); process.exit(1); });
}
