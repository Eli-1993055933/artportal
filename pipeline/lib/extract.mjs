// extract.mjs —— 调用 Claude 把原文整理成结构化数据。
//
// 铁律:AI 只读原文、只整理格式。不联网、不补全、不用自身知识(约束写在 prompts/extract.txt)。
// 真正的硬约束不在这里,而在 verify.mjs——由程序拿 evidence 去原文比对。AI 说了不算。
//
// 需要环境变量 ANTHROPIC_API_KEY(GitHub Secrets 注入)。本地演示可用 offlineExtract 注入结果。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
// 提取用模型:结构化提取用 Sonnet 又快又省(可用 EXTRACT_MODEL 环境变量覆盖)。
// 真正的准确性靠 verify.mjs 的 evidence 子串校验兜底,而非模型档次。
const MODEL = process.env.EXTRACT_MODEL || "claude-sonnet-5";
const MAX_INPUT_CHARS = 24000;                    // 原文过长时截断,控制成本

let PROMPT = null;
async function getPrompt() {
  if (PROMPT == null) PROMPT = await readFile(join(__dir, "..", "prompts", "extract.txt"), "utf8");
  return PROMPT;
}

// 价格(美元/百万 token)—— 用于费用报告。若价格调整只改这里。
const PRICE = { in: 3, out: 15 }; // Sonnet 约值,占位;正式以账单为准

export function estimateCost(usage) {
  if (!usage) return 0;
  return (usage.input_tokens / 1e6) * PRICE.in + (usage.output_tokens / 1e6) * PRICE.out;
}

// 真·提取:调用 Anthropic API。返回 { data, usage, raw }
export async function extract(sourceText, ctx) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("缺少 ANTHROPIC_API_KEY(正式运行需在 GitHub Secrets 配置)");
  const { default: Anthropic } = await import("@anthropic-ai/sdk"); // 懒加载:fetch-only/离线模式无需安装 SDK
  const client = new Anthropic({ apiKey });
  const prompt = await getPrompt();
  const text = sourceText.slice(0, MAX_INPUT_CHARS);

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: prompt,
    messages: [{
      role: "user",
      content:
        `【机构】${ctx.org_zh || ""}  【信源域名】${ctx.domain || ""}\n` +
        `【机构官网原文如下,只能使用这里的信息】\n\n${text}`
    }]
  });
  const raw = (msg.content || []).map(b => b.text || "").join("");
  return { data: parseJson(raw), usage: msg.usage, raw };
}

export function parseJson(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw));
  if (!m) throw new Error("模型输出中未找到 JSON");
  return JSON.parse(m[0]);
}
