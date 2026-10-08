// _tmp-backfill-deadline.mjs —— 从 deadline_note 回填 deadline(2026-10-08 用户批准的路线图增量杠杆①)
// 反幻觉:只把【备注里已有的日期】结构化,并重抓原文用【子串复核】通过后才采纳;过期条目置 expired。
// 用法:node _tmp-backfill-deadline.mjs            (dry-run,只报告)
//       node _tmp-backfill-deadline.mjs --apply    (写回 opportunities.json)
import { readFileSync } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource } from "./lib/fetch.mjs";
import { parseDeadlineFromNote, verifyDeadlineInSource } from "./lib/verify.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const _e = readFileSync(join(__dir, ".env"), "utf8");
  for (const _l of _e.split(/\r?\n/)) {
    const _m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(_l);
    if (_m && !_l.trim().startsWith("#") && process.env[_m[1]] == null) process.env[_m[1]] = _m[2];
  }
} catch (e) {}
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const APPLY = process.argv.includes("--apply");
const todayISO = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

async function main() {
  const doc = JSON.parse(await readFile(DATA, "utf8"));
  const today = todayISO();
  const cand = doc.opportunities.filter(o => o.deadline == null && String(o.deadline_note || "").trim());
  const parsed = [];
  for (const o of cand) {
    const iso = parseDeadlineFromNote(o.deadline_note);
    if (iso) parsed.push({ o, iso });
  }
  console.log("无截止且有备注:", cand.length, "| 备注可解析出日期:", parsed.length);

  const adopted = [], rejected = [], fetchFail = [];
  let i = 0;
  async function worker() {
    while (i < parsed.length) {
      const { o, iso } = parsed[i++];
      let f;
      try { f = await fetchSource({ url: o.url, domain: o.domain || "", type: "html" }, null, { timeoutMs: 15000 }); }
      catch (e) { fetchFail.push([o.id, iso, "fetch-error"]); continue; }
      if (!f || f.skipped || !f.text) { fetchFail.push([o.id, iso, (f && f.reason) || "empty"]); continue; }
      if (!verifyDeadlineInSource(iso, f.text)) { rejected.push([o.id, iso, (o.title_zh || "").slice(0, 26)]); continue; }
      adopted.push([o.id, iso, (o.title_zh || "").slice(0, 30), iso < today ? "past" : "future"]);
      if (APPLY) {
        o.deadline = iso;
        o._deadline_src = "note+原文验证";
        if (iso < today && o.status === "open") o.status = "expired";
        o.updated_at = today;
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));

  console.log("\n=== 采纳", adopted.length, "条 ===");
  adopted.forEach(r => console.log("  ✓", r[3], r[1], "|", r[2]));
  console.log("\n=== 原文未复核通过(丢弃)", rejected.length, "条 ===");
  rejected.forEach(r => console.log("  ✗", r[1], "|", r[2]));
  console.log("\n=== 抓取失败(丢弃)", fetchFail.length, "条 ===");
  fetchFail.forEach(r => console.log("  ?", r[1], "|", r[2]));

  if (APPLY && adopted.length) {
    doc.generated_at = today;
    const tmp = DATA + ".tmp-" + process.pid;
    await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
    await rename(tmp, DATA);
    console.log("\n已写回 opportunities.json");
  } else {
    console.log("\n(未写回;加 --apply 生效)");
  }
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });