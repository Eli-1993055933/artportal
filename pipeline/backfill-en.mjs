// backfill-en.mjs —— 给已入库的机会条目批量补英文字段(供前端中英切换)。
//
// 红线:只做「忠实翻译」已校验入库的中文内容,绝不新增/猜测信息。
// 机器翻译的条目打 en_mt=true,详情页在 EN 模式如实标注 machine-translated。
//
// 补的字段(缺才补,已有的不覆盖):
//   title_en, summary_en, org_en, city_en, country_en, deadline_note_en,
//   eligibility.age_limit_en, eligibility.nationality_en, disciplines_en(与原数组等长对齐)
//
// 用法: cd pipeline && set -a && . ./.env && set +a && node backfill-en.mjs
// 幂等:重复运行只处理仍缺英文字段的条目(每日管道/检索新增数据后重跑即可)。

import { readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { reportAgent } from "./lib/agent-report.mjs";
import { llmExtract } from "./lib/extract.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
// GLM 免费档为主(2026-08-02 定调长期主力),DeepSeek/Anthropic 由 llmExtract 按需兜底,见 lib/extract.mjs。
if (!process.env.MOD_API_KEY && !process.env.DEEPSEEK_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error("缺 MOD_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY(先 source .env)"); process.exit(1);
}

const BATCH = 6;        // 每次 API 调用翻译的条数(太大易被 max_tokens 截断)
const CONCURRENCY = 5;  // 并发调用数

// 源文指纹:翻译时把源文哈希存进 o.en_src[field],之后源文一改指纹对不上 → 自动重译,
// 过期翻译不会永远挂着(比如人工改了 verified 条目的学科/简介)。
export function srcSig(s) {
  let h = 5381; const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// 一条记录还缺哪些翻译 → 组装待翻译载荷;全齐且源文没变则返回 null
const hasCJK = s => /[㐀-鿿]/.test(String(s));
function needsOf(o) {
  const src = {};
  const es = o.en_src || {};
  // 需要翻译 = 有源文 且 源文里真有中文可译(数字/英文原样回退显示,不送翻)
  // 且(还没有英文 或 有指纹且源文已变)。没有指纹的已有英文(源站原文/人工翻译)绝不动。
  const need = (f, enVal, srcVal) => !!srcVal && hasCJK(srcVal) && (!enVal || (es[f] != null && es[f] !== srcSig(srcVal)));
  if (need("title", o.title_en, o.title_zh)) src.title = o.title_zh;
  if (need("summary", o.summary_en, o.summary_zh)) src.summary = o.summary_zh;
  if (need("org", o.org_en, o.org_zh)) src.org = o.org_zh;
  if (need("city", o.city_en, o.city_zh)) src.city = o.city_zh;
  if (need("country", o.country_en, o.country_zh)) src.country = o.country_zh;
  if (need("deadline_note", o.deadline_note_en, o.deadline_note)) src.deadline_note = o.deadline_note;
  const e = o.eligibility || {};
  if (need("age_limit", e.age_limit_en, e.age_limit)) src.age_limit = e.age_limit;
  if (need("nationality", e.nationality_en, e.nationality)) src.nationality = e.nationality;
  const discStr = (Array.isArray(o.disciplines) && o.disciplines.length) ? JSON.stringify(o.disciplines) : null;
  if (need("disciplines", o.disciplines_en, discStr)) src.disciplines = o.disciplines;
  return Object.keys(src).length ? src : null;
}

async function translateBatch(items) {
  const payload = items.map(({ id, src }) => ({ id, ...src }));
  const sys =
    "你是专业中译英译者,翻译艺术机会(展览征集/驻留/奖项/工作坊)条目字段。规则:" +
    "1) 忠实翻译,绝不增删信息、绝不猜测补全;" +
    "2) 机构/展览如有通行官方英文名就用官方英文名,不确定就直译;地名用通行英文写法(如 北京→Beijing);" +
    "3) disciplines 是数组,输出 disciplines_en 必须与其等长、逐项对应;已是英文的项原样保留;" +
    "4) 输出 JSON 对象:{\"items\":[{\"id\":...,\"title_en\"?,\"summary_en\"?,\"org_en\"?,\"city_en\"?,\"country_en\"?,\"deadline_note_en\"?,\"age_limit_en\"?,\"nationality_en\"?,\"disciplines_en\"?}]}," +
    "每条只输出输入里给了源文的对应字段,id 原样返回。";
  // 忠实翻译要低随机性;高温会放大 id 改写/串位概率——llmExtract 内部固定 temperature:0,足够低。
  const { data: parsed } = await llmExtract(sys, JSON.stringify(payload, null, 0), 4000);
  // 顶层结构兼容:{items:[...]} / 直接数组 / 其他键名包着的数组
  let out = Array.isArray(parsed) ? parsed
          : Array.isArray(parsed.items) ? parsed.items
          : Object.values(parsed).find(Array.isArray);
  if (!Array.isArray(out)) throw new Error("响应里找不到数组,键:" + Object.keys(parsed).join(","));
  return out;
}

// 校验 + 回写一条翻译结果;返回是否写入了任何字段。
// 机翻来源按【字段级】记录在 en_mt_fields(前端据此精确标注,不连带误标人工/源站英文)。
function applyResult(o, r, src) {
  const wrote = [];
  const put = (cond, field, apply) => { if (cond) { apply(); wrote.push(field); } };
  const s = v => typeof v === "string" && v.trim() ? v.trim() : null;
  put(src.title && s(r.title_en), "title", () => o.title_en = s(r.title_en));
  put(src.summary && s(r.summary_en), "summary", () => o.summary_en = s(r.summary_en));
  put(src.org && s(r.org_en), "org", () => o.org_en = s(r.org_en));
  put(src.city && s(r.city_en), "city", () => o.city_en = s(r.city_en));
  put(src.country && s(r.country_en), "country", () => o.country_en = s(r.country_en));
  put(src.deadline_note && s(r.deadline_note_en), "deadline_note", () => o.deadline_note_en = s(r.deadline_note_en));
  if (src.age_limit || src.nationality) o.eligibility = o.eligibility || {};
  put(src.age_limit && s(r.age_limit_en), "age_limit", () => o.eligibility.age_limit_en = s(r.age_limit_en));
  put(src.nationality && s(r.nationality_en), "nationality", () => o.eligibility.nationality_en = s(r.nationality_en));
  // disciplines:必须等长数组、逐项非空,否则整个放弃(宁缺毋错位)
  if (src.disciplines && Array.isArray(r.disciplines_en) &&
      r.disciplines_en.length === src.disciplines.length &&
      r.disciplines_en.every(x => typeof x === "string" && x.trim())) {
    o.disciplines_en = r.disciplines_en.map(x => x.trim());
    wrote.push("disciplines");
  }
  if (wrote.length) {
    o.en_mt_fields = Array.from(new Set([...(o.en_mt_fields || []), ...wrote]));
    delete o.en_mt;   // 旧的整条级布尔标记废弃
    // 记录每个机翻字段的源文指纹(源文以后变了 → needsOf 判定重译)
    o.en_src = o.en_src || {};
    for (const f of wrote) {
      const v = f === "disciplines" ? JSON.stringify(src.disciplines) : src[f];
      o.en_src[f] = srcSig(v);
    }
  }
  return wrote;
}

const raw = await readFile(DATA, "utf8");
const data = JSON.parse(raw);
const arr = data.opportunities;
if (!Array.isArray(arr)) { console.error("数据结构不对:缺 opportunities 数组"); process.exit(1); }

const todo = arr.map(o => ({ id: o.id, o, src: needsOf(o) })).filter(x => x.src);
console.log(`共 ${arr.length} 条,需补英文 ${todo.length} 条`);
if (!todo.length) process.exit(0);

// 动数据前先备份;带时间戳,重跑不覆盖之前的回滚点
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const BAK = DATA + ".bak-en-" + stamp;
await copyFile(DATA, BAK);

const batches = [];
for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));

let done = 0, ok = 0, failedIds = [];
async function worker() {
  while (batches.length) {
    const batch = batches.shift();
    let results = null;
    for (let attempt = 1; attempt <= 2 && !results; attempt++) {
      try { results = await translateBatch(batch); }
      catch (e) { if (attempt === 2) console.error("批次失败:", e.message); }
    }
    // 批级 id 校验:返回的 id 必须无重复;有重复 → 整批弃用(防串位错写,反误导红线)
    const reqIds = new Set(batch.map(b => b.id));
    const respIds = (results || []).map(r => r && r.id).filter(Boolean);
    const hasDup = new Set(respIds).size !== respIds.length;
    const matchedCount = respIds.filter(id => reqIds.has(id)).length;
    let pairFor;   // item,index → 翻译结果 or null
    if (hasDup) {
      pairFor = () => null;
    } else if (results && results.length === batch.length && matchedCount === 0) {
      // 等长且 id 全对不上 = 模型整体改写了 id(含中文 id 时偶发)→ 按序配对兜底
      pairFor = (item, i) => results[i];
    } else {
      const byId = new Map((results || []).map(r => [r && r.id, r]));
      pairFor = (item) => byId.get(item.id) || null;   // 部分对不上 → 只收匹配的,其余记失败
    }
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      const r = pairFor(item, i);
      const wrote = r ? applyResult(item.o, r, item.src) : [];
      if (wrote.length) { item.wrote = wrote; ok++; }
      else failedIds.push(item.id);
    }
    done += batch.length;
    process.stderr.write(`\r进度 ${done}/${todo.length} (成功 ${ok})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
process.stderr.write("\n");

// 回写:重读磁盘最新数据,把本次翻译出的字段按 id 合并进去(翻译期间每日管道/检索服务可能
// 写过库,不能拿几分钟前的内存快照整体覆盖),再写临时文件 + rename 原子替换(防残缺 JSON)。
const KEY_OF = { title: "title_en", summary: "summary_en", org: "org_en", city: "city_en",
                 country: "country_en", deadline_note: "deadline_note_en", disciplines: "disciplines_en" };
const fresh = JSON.parse(await readFile(DATA, "utf8"));
const freshById = new Map(fresh.opportunities.map(o => [o.id, o]));
let merged = 0;
for (const item of todo) {
  if (!item.wrote) continue;                    // 本次没翻出东西的条目不动
  const f = freshById.get(item.o.id);
  if (!f) continue;                             // 窗口期被删的条目:放弃其翻译
  for (const field of item.wrote) {
    if (field === "age_limit" || field === "nationality") {
      f.eligibility = f.eligibility || {};
      f.eligibility[field + "_en"] = item.o.eligibility[field + "_en"];
    } else {
      f[KEY_OF[field]] = item.o[KEY_OF[field]];
    }
  }
  f.en_mt_fields = Array.from(new Set([...(f.en_mt_fields || []), ...item.wrote]));
  f.en_src = { ...(f.en_src || {}) };
  for (const field of item.wrote) f.en_src[field] = item.o.en_src[field];
  delete f.en_mt;
  merged++;
}
await writeFile(DATA + ".tmp", JSON.stringify(fresh, null, 2), "utf8");
await rename(DATA + ".tmp", DATA);
console.log(`完成:补齐 ${ok} 条(合并回库 ${merged} 条);失败 ${failedIds.length} 条${failedIds.length ? "(重跑本脚本即可续补):" + failedIds.slice(0, 10).join(",") : ""}`);
console.log(`备份在 ${BAK}`);
await reportAgent("translator", true, `双语回填:补齐 ${ok} 条,失败 ${failedIds.length} 条`, { ok, failed: failedIds.length });
