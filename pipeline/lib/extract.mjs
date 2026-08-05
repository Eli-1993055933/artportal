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
import { hasApplySignal, judgeApplicability } from "./applicability.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const MAX_INPUT_CHARS = 24000;                    // 原文过长时截断,控制成本

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// 价格(美元/百万 token)—— 仅用于费用报告估算,正式以账单为准。
const PRICES = {
  deepseek: { in: 0.27, out: 1.10 },   // deepseek-chat 约值
  anthropic: { in: 3, out: 15 },       // Sonnet 约值
  "glm-free": { in: 0, out: 0 }        // 智谱 GLM-4-Flash(免费兜底)
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
  const r = await llmExtract(prompt, user);
  // 窄二判(v1.0.1):大提取里"展讯新闻→applicable:false"这条弱模型常不执行,改用它能胜任的
  // A/B 二选一把关。只对含申请动词的页面加判(无动词的 verifyRecord 硬闸直接拦,不花这次调用);
  // 只在"确信 B 且 evidence 过原文子串校验"时拦截,拿不准放行。二判失败绝不拦路。
  try {
    if (r && r.data && r.data.applicable !== false && hasApplySignal(sourceText)) {
      const v2 = await judgeApplicability(sourceText, r.data.title_zh || "");
      if (v2 && v2.block) r.data = { applicable: false, reason: "二判观展资讯:" + (v2.evidence || "").slice(0, 60) };
    }
  } catch (e) { /* 二判挂了不影响主流程 */ }
  return r;
}

// 底层出口:任意 system prompt + user 内容 → JSON 提取结果(资讯/招聘频道用自己的 prompt 走这里)。
// provider 选择、JSON 模式、usage 统计与机会频道完全同一套。
// GLM 免费档为主(2026-08-02 定调长期主力,DeepSeek 不再充值);DeepSeek/Anthropic 仅作 GLM 失败时的备份。
export async function llmExtract(system, user, maxTokens) {
  if (process.env.MOD_API_KEY) {
    try { return await extractGlmFree(system, user, maxTokens); }
    catch (e) {
      // GLM 故障/限流 → 有余额的 DeepSeek 顶上;反幻觉不受影响——evidence 是否原文子串由 verify.mjs 程序说了算。
      if (DEEPSEEK_KEY) {
        try { return await extractDeepSeek(system, user, maxTokens); } catch (e2) {}
      }
      if (ANTHROPIC_KEY) {
        try { return await extractAnthropic(system, user, maxTokens); } catch (e3) {}
      }
      throw e;
    }
  }
  if (DEEPSEEK_KEY) return extractDeepSeek(system, user, maxTokens);
  if (ANTHROPIC_KEY) return extractAnthropic(system, user, maxTokens);
  throw new Error("缺少 MOD_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY(放进 pipeline/.env 或 GitHub Secrets)");
}

// 免费提取(智谱 GLM-4-Flash,OpenAI 兼容,长期免费):llmExtract 的兜底线,也可被各调用点直接用作主线。
// 不传 response_format(flash 各版支持不一),输出可能包 markdown 代码块,剥掉再解析。
export async function extractGlmFree(system, user, maxTokens) {
  const key = process.env.MOD_API_KEY;
  if (!key) throw new Error("缺少 MOD_API_KEY");
  const res = await fetch(process.env.MOD_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MOD_MODEL || "glm-4-flash",
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      max_tokens: maxTokens || 1500
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error("GLM " + res.status + ": " + (await res.text()).slice(0, 300));
  const j = await res.json();
  let raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  raw = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const usage = {
    provider: "glm-free",
    input_tokens: (j.usage && j.usage.prompt_tokens) || 0,
    output_tokens: (j.usage && j.usage.completion_tokens) || 0
  };
  return { data: parseJson(raw), usage, raw };
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
