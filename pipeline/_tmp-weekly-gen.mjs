// _tmp-weekly-gen.mjs —— 手动触发当周 AI 艺术周报生成(复用周报管线)
// 用法:node _tmp-weekly-gen.mjs [--force]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateWeekly } from "./lib/weekly.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// 加载 pipeline/.env(__GLM/DEEPSEEK 密钥等)
try {
  const _env = readFileSync(join(__dir, ".env"), "utf8");
  for (const _l of _env.split(/\r?\n/)) {
    const _m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(_l);
    if (_m && !_l.trim().startsWith("#") && process.env[_m[1]] == null) process.env[_m[1]] = _m[2];
  }
} catch (e) { process.stderr.write("[tmp-weekly] 未找到 .env,跳过(" + e.message + ")\n"); }

process.stderr.write("[tmp-weekly] 开始生成周报…\n");
const r = await generateWeekly({ force: process.argv.includes("--force") });
if (r.empty) { process.stderr.write("[tmp-weekly] 空刊:近一周无内容\n"); process.exit(1); }
if (r.existed) { process.stderr.write("[tmp-weekly] 本周已出刊,跳过\n"); }
else process.stderr.write("[tmp-weekly] 已生成 " + r.report.id + "「" + r.report.title + "」(AI=" + r.report.ai_composed + ", format=" + (r.report.format || 1) + ")\n");
process.exit(0);