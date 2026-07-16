// backfill-channel-i18n.mjs —— 给资讯(news.json)/招聘(jobs.json)的标题、摘要补中英双语。
//
// 现状:每条只有单一语言的 title(英文文章→英文标题,中文→中文)和中文 summary。
// 目标:补 title_zh/title_en、summary_zh/summary_en,让前端能随界面语言切换。
// 忠实翻译,不增删信息(与 backfill-en 同理念)。
//
// 用法: cd pipeline && set -a && . ./.env && set +a && node backfill-channel-i18n.mjs

import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error("缺 DEEPSEEK_API_KEY"); process.exit(1); }

const FILES = [
  { path: join(__dir, "..", "site", "data", "news.json"), key: "items" },
  { path: join(__dir, "..", "site", "data", "jobs.json"), key: "jobs" }
];
const BATCH = 6, CONCURRENCY = 4;

function needs(o) { return o.title && (!o.title_zh || !o.title_en || (o.summary && (!o.summary_zh || !o.summary_en))); }

async function translateBatch(items) {
  const payload = items.map(o => ({ id: o.id, title: o.title, summary: o.summary || "" }));
  const body = {
    model: "deepseek-chat", temperature: 0.3, max_tokens: 4000,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content:
        "你是专业中英双语译者。给你艺术资讯/招聘条目的 title 和 summary(可能中文或英文)。" +
        "为每条输出中文版与英文版,忠实翻译、不增删信息。已是某语言的原文保留原文,另一语言给准确译文。" +
        "机构/媒体/人名有通行译名就用,否则保留原文。输出 JSON:" +
        '{"items":[{"id":...,"title_zh":...,"title_en":...,"summary_zh":...,"summary_en":...}]},id 原样返回。' },
      { role: "user", content: JSON.stringify(payload) }
    ]
  };
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST", headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000)
  });
  if (!res.ok) throw new Error("deepseek " + res.status);
  const j = await res.json();
  if (j.choices?.[0]?.finish_reason === "length") throw new Error("截断");
  const parsed = JSON.parse(j.choices?.[0]?.message?.content || "{}");
  return Array.isArray(parsed.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
}
const s = v => typeof v === "string" && v.trim() ? v.trim() : null;

for (const F of FILES) {
  const data = JSON.parse(await readFile(F.path, "utf8"));
  const arr = data[F.key] || [];
  const todo = arr.filter(needs);
  console.log(`${F.key}: 共 ${arr.length} 条,需补双语 ${todo.length} 条`);
  if (!todo.length) continue;

  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  let ok = 0;
  const translated = new Map();   // id -> 译文;翻译期间不动原文件
  const queue = batches.slice();
  async function worker() {
    while (queue.length) {
      const batch = queue.shift();
      let results = null;
      for (let a = 1; a <= 2 && !results; a++) { try { results = await translateBatch(batch); } catch (e) { if (a === 2) console.error("批次失败:", e.message); } }
      const byId = new Map((results || []).map(r => [r && r.id, r]));
      const byIdx = (results && results.length === batch.length) ? results : null;
      for (let i = 0; i < batch.length; i++) {
        const o = batch[i], r = byId.get(o.id) || (byIdx ? byIdx[i] : null);
        if (!r) continue;
        translated.set(o.id, r);
        ok++;
      }
      process.stderr.write(`\r  ${F.key} 进度 ${ok}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write("\n");

  // 翻译要跑好几分钟,期间 server.mjs 的检索可能已往文件里追加了新记录——
  // 绝不能拿旧快照整体写回(会把窗口期的新增全部抹掉)。重读最新文件,按 id 合并、只补缺字段。
  const fresh = JSON.parse(await readFile(F.path, "utf8"));
  let applied = 0;
  for (const o of (fresh[F.key] || [])) {
    const r = translated.get(o.id);
    if (!r) continue;
    if (!o.title_zh && s(r.title_zh)) o.title_zh = s(r.title_zh);
    if (!o.title_en && s(r.title_en)) o.title_en = s(r.title_en);
    if (o.summary) {
      if (!o.summary_zh && s(r.summary_zh)) o.summary_zh = s(r.summary_zh);
      if (!o.summary_en && s(r.summary_en)) o.summary_en = s(r.summary_en);
    }
    applied++;
  }
  const tmp = F.path + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(tmp, JSON.stringify(fresh, null, 2), "utf8");
  await rename(tmp, F.path);
  console.log(`  ${F.key}: 译得 ${ok} 条,合并写回 ${applied} 条`);
}
console.log("完成");
