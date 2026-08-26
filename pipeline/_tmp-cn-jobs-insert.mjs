// _tmp-cn-jobs-insert.mjs —— 国内艺术招聘官网批量入库脚本(招聘频道)
// 输入:_tmp-cn-jobs.txt(每行一条人工核实的官方招聘详情页 URL)
// 处理:fetchSource → processChannelPage(jobs)→ 全套 evidence 子串校验 → upsertChannelRecords
// 复用 lib/channels.mjs 招聘频道的 verifyJobs + finalizeJobs,反幻觉红线与检索路径一致。
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource } from "./lib/fetch.mjs";
import { processChannelPage, upsertChannelRecords, readChannelDoc } from "./lib/channels.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// 加载 pipeline/.env(LLM key 等)
try {
  const _env = readFileSync(join(__dir, ".env"), "utf8");
  for (const _l of _env.split(/\r?\n/)) {
    const _m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(_l);
    if (_m && !_l.trim().startsWith("#") && process.env[_m[1]] == null) process.env[_m[1]] = _m[2];
  }
} catch (e) { process.stderr.write("[jobs-insert] 未找到 .env,跳过(" + e.message + ")\n"); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 抓正文,偶发 http-300/http-403/fetch-error 抖动时等 1.5s 重试至多 2 次
async function fetchRetry(u, host) {
  for (let i = 0; i < 3; i++) {
    const f = await fetchSource({ url: u, domain: host, type: "html" }, null, { timeoutMs: 10000 });
    if (!(f && f.skipped && /http-300|http-403|fetch-error/.test(f.reason || ""))) return f;
    await sleep(1500);
  }
  return null;
}

const URL_FILE = new URL("./_tmp-cn-jobs.txt", import.meta.url);
const URLS = readFileSync(URL_FILE, "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));

async function main() {
  if (!URLS.length) { console.error("URLS 为空,请填充 _tmp-cn-jobs.txt"); process.exit(1); }
  const doc = await readChannelDoc("jobs");
  const list = doc.jobs || [];
  const existIds = new Set(list.map(o => o.id));
  const existUrls = new Set(list.map(o => o.apply_url).filter(Boolean));
  const added = [];
  let dropped = 0, err = 0;

  async function processOne(url) {
    const u = url.split("#")[0];
    if (existUrls.has(u) || added.find(a => a.apply_url === u)) return "skip(已入库) " + u;
    let host; try { host = new URL(u).host; } catch (e) { err++; return "bad-url " + u; }
    try {
      const f = await fetchRetry(u, host);
      const len = (f && f.text) ? f.text.length : 0;
      if (!f || f.skipped || !f.text || len < 200) { dropped++; return `skip(页面薄|sk=${f && f.skipped}|rs=${f && f.reason}|len=${len}) ${u}`; }
      const r = await processChannelPage("jobs", { url: u, host, text: f.text, rawHtml: f.rawHtml }, "search");
      if (r.dropped) { dropped++; return "drop(" + (r.reason || "") + ") " + host; }
      const rec = r.record;
      if (existIds.has(rec.id)) return "skip(id 重复) " + rec.id;
      added.push(rec);
      return `✓ ${rec.title_zh || rec.title} | org=${rec.org || "?"} | city=${rec.city || "?"} | dl=${rec.deadline || "?"} | ${host}`;
    } catch (e) { err++; return "ERR " + host + " " + (e.message || e) + "\n" + ((e && e.stack || e).split("\n").slice(0, 5).join("\n")); }
  }

  const CONC = 4;
  let si = 0;
  const workers = [];
  for (let w = 0; w < CONC && si < URLS.length; w++) {
    workers.push((async () => {
      while (true) {
        const i = si++;
        if (i >= URLS.length) break;
        console.log(await processOne(URLS[i]));
      }
    })());
  }
  await Promise.all(workers);

  if (!added.length) { console.log("\n无新增"); return; }
  const saved = await upsertChannelRecords("jobs", added);
  console.log(`\n完成: 新增 ${saved.length}, 丢弃 ${dropped}, 错误 ${err}`);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
