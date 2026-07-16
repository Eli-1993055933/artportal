// extract.mjs —— 调用大模型把原文整理成结构化数据。多 provider:
//   有 DEEPSEEK_API_KEY  → 走 DeepSeek(OpenAI 兼容接口,大陆可直连、便宜,原生 fetch 无需依赖)
//   有 ANTHROPIC_API_KEY → 走 Anthropic(SDK 懒加载)
// 用 EXTRACT_MODEL 可覆盖模型名。
//
// 铁律:AI 只读原文、只整理格式。不联网、不补全、不用自身知识(约束写在 prompts/extract.txt)。
// 真正的硬约束不在这里,而在 verify.mjs——由程序拿 evidence 去原文比对。AI 说了不算。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const MAX_INPUT_CHARS = 24000;                    // 原文过长时截断,控制成本

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// 价格(美元/百万 token)—— 仅用于费用报告估算,正式以账单为准。
const PRICES = {
  deepseek: { in: 0.27, out: 1.10 },   // deepseek-chat 约值
  anthropic: { in: 3, out: 15 }        // Sonnet 约值
};

let PROMPT = null;
async function getPrompt() {
  if (PROMPT == null) PROMPT = await readFile(join(__dir, "..", "prompts", "extract.txt"), "utf8");
  return PROMPT;
}

export function estimateCost(usage) {
  if (!usage) return 0;
  const p = PRICES[usage.provider] || PRICES.deepseek;
  return (usage.input_tokens / 1e6) * p.in + (usage.output_tokens / 1e6) * p.out;
}

function buildUserContent(text, ctx) {
  return `【机构】${ctx.org_zh || ""}  【信源域名】${ctx.domain || ""}\n` +
         `【机构官网原文如下,只能使用这里的信息】\n\n${text}`;
}

// 统一入口(机会频道)。返回 { data, usage, raw }
export async function extract(sourceText, ctx) {
  const prompt = await getPrompt();
  const user = buildUserContent(sourceText.slice(0, MAX_INPUT_CHARS), ctx);
  return llmExtract(prompt, user);
}

// 底层出口:任意 system prompt + user 内容 → JSON 提取结果(资讯/招聘频道用自己的 prompt 走这里)。
// provider 选择、JSON 模式、usage 统计与机会频道完全同一套。
export async function llmExtract(system, user, maxTokens) {
  if (DEEPSEEK_KEY) return extractDeepSeek(system, user, maxTokens);
  if (ANTHROPIC_KEY) return extractAnthropic(system, user, maxTokens);
  throw new Error("缺少 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY(放进 pipeline/.env 或 GitHub Secrets)");
}

export { MAX_INPUT_CHARS };

// DeepSeek:OpenAI 兼容的 /chat/completions;JSON 模式(prompt 内含 “JSON” 字样,满足其要求)。
async function extractDeepSeek(system, user, maxTokens) {
  const model = process.env.EXTRACT_MODEL || "deepseek-chat";
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + DEEPSEEK_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      max_tokens: maxTokens || 1500,
      response_format: { type: "json_object" }
    }),
    // 无超时会让一次卡死的 LLM 调用拖住整个检索并发槽(BUDGET 只在候选之间检查)
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error("DeepSeek " + res.status + ": " + (await res.text()).slice(0, 300));
  const j = await res.json();
  const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  const usage = {
    provider: "deepseek",
    input_tokens: (j.usage && j.usage.prompt_tokens) || 0,
    output_tokens: (j.usage && j.usage.completion_tokens) || 0
  };
  return { data: parseJson(raw), usage, raw };
}

// Anthropic:SDK 懒加载(fetch-only/离线模式或用 DeepSeek 时无需安装 SDK)。
async function extractAnthropic(system, user, maxTokens) {
  const model = process.env.EXTRACT_MODEL || "claude-sonnet-5";
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const msg = await client.messages.create({
    model, max_tokens: maxTokens || 1500, system,
    messages: [{ role: "user", content: user }]
  });
  const raw = (msg.content || []).map(b => b.text || "").join("");
  const usage = {
    provider: "anthropic",
    input_tokens: (msg.usage && msg.usage.input_tokens) || 0,
    output_tokens: (msg.usage && msg.usage.output_tokens) || 0
  };
  return { data: parseJson(raw), usage, raw };
}

export function parseJson(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw));
  if (!m) throw new Error("模型输出中未找到 JSON");
  return JSON.parse(m[0]);
}
