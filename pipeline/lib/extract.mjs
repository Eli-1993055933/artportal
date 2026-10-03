// extract.mjs —— 调用大模型把原文整理成结构化数据。多 provider:
//   有 DEEPSEEK_API_KEY  → 走 DeepSeek(OpenAI 兼容接口,大陆可直连、便宜,原生 fetch 无需依赖)
//   有 ANTHROPIC_API_KEY → 走 Anthropic(SDK 懒加载)
//   免费云通道           → 智谱 GLM-4-Flash / 讯飞星火 Lite / 阿里百炼 qwen-flash / 硅基流动,
//                          多家互为备份(见 FREE_PROVIDERS,只启用 .env 里配了 key 的那几家)
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
  // 免费云通道各家(均按 0 计)。注意:若把某家的 *_MODEL 指向了付费模型,费用报告会低估,以官方账单为准。
  "glm-free": { in: 0, out: 0 },       // 智谱 GLM-4-Flash
  "spark-lite": { in: 0, out: 0 },     // 讯飞星火 Lite
  "qwen-free": { in: 0, out: 0 },      // 阿里百炼 qwen-flash
  "siliconflow": { in: 0, out: 0 }     // 硅基流动
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
// 2026-08-23 改:DeepSeek(付费、稳、大陆直连)优先 → 免费通道兜底 → Anthropic。
//   此前(2026-08-02 起)免费档为主,DeepSeek 仅作失败备份;但信源并发6×提取并发4=24 路峰值时 GLM
//   免费档高频 429(实测一轮 1767 次 429、被拖 4.45h、丢候选),故升级 DeepSeek 为主力、免费档兜底。
// 2026-10-03 改:免费那一路从"GLM 单点"扩成"多家免费云顺序故障转移"(见 FREE_PROVIDERS),
//   所以 2026-08-23 那种单家 429 风暴不再是致命伤——换一家即可。
export async function llmExtract(system, user, maxTokens) {
  const hasFree = freeProviders().length > 0;
  if (DEEPSEEK_KEY) {
    try { return await extractDeepSeek(system, user, maxTokens); }
    catch (e) {
      if (ANTHROPIC_KEY) {
        try { return await extractAnthropic(system, user, maxTokens); } catch (e2) {}
      }
      if (hasFree) {
        try { return await extractGlmFree(system, user, maxTokens); } catch (e3) {}
      }
      throw e;
    }
  }
  if (hasFree) {
    try { return await extractGlmFree(system, user, maxTokens); }
    catch (e) {
      if (ANTHROPIC_KEY) {
        try { return await extractAnthropic(system, user, maxTokens); } catch (e2) {}
      }
      throw e;
    }
  }
  if (ANTHROPIC_KEY) return extractAnthropic(system, user, maxTokens);
  throw new Error("缺少任何大模型 key:DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / 免费通道任一家" +
    "(MOD_API_KEY 智谱、XFYUN_API_KEY 讯飞、DASHSCOPE_API_KEY 百炼、SILICONFLOW_API_KEY 硅基流动)");
}

// —— 免费云通道:多家 OpenAI 兼容服务互为备份(2026-10-03)——
// 起因:此前免费通道只有智谱 GLM-4-Flash 一家,是**单点**——那家限流/欠费/改政策/关停,
//   整条免费链就断(2026-08-23 一轮曾吃到 1767 次 429)。现改为"注册表 + 顺序故障转移"。
// 怎么用:只尝试 .env 里**配了 key** 的那几家,按下面数组顺序挨个试;前一家失败(429/5xx/
//   超时/欠费)立刻换下一家,不用改代码就能加源——在 .env 里补一个 key 即自动加入。
// 四家都是 OpenAI 兼容的 /chat/completions,所以共用 callOpenAICompat,不再一家一个函数。
// 各家的 *_API_URL / *_MODEL 均可覆盖默认值(私有部署、换模型都行)。
// ⚠ 各家的"免费"口径以其官网当期政策为准。本项目只实测过智谱 GLM-4-Flash,其余三家为待启用项。
const FREE_PROVIDERS = [
  {
    id: "glm-free", name: "智谱 GLM-4-Flash", keyEnv: "MOD_API_KEY",
    url: () => process.env.MOD_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    model: () => process.env.MOD_MODEL || "glm-4-flash"
  },
  {
    id: "spark-lite", name: "讯飞星火 Lite", keyEnv: "XFYUN_API_KEY",
    url: () => process.env.XFYUN_API_URL || "https://spark-api-open.xf-yun.com/v1/chat/completions",
    model: () => process.env.XFYUN_MODEL || "lite"
  },
  {
    id: "qwen-free", name: "阿里百炼 qwen-flash", keyEnv: "DASHSCOPE_API_KEY",
    url: () => process.env.DASHSCOPE_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    model: () => process.env.DASHSCOPE_MODEL || "qwen-flash"
  },
  {
    id: "siliconflow", name: "硅基流动", keyEnv: "SILICONFLOW_API_KEY",
    url: () => process.env.SILICONFLOW_API_URL || "https://api.siliconflow.cn/v1/chat/completions",
    model: () => process.env.SILICONFLOW_MODEL || "Qwen/Qwen2.5-7B-Instruct"
  }
];

// 当前可用的免费源(key 已配置的)。顺序即尝试顺序。
export function freeProviders() {
  return FREE_PROVIDERS.filter(p => process.env[p.keyEnv]);
}

// 是否有任何可用的大模型 key(免费通道任一家,或 DeepSeek / Anthropic)。
// 各入口脚本的前置检查统一用它,免得"只在 .env 配了讯飞/百炼"时被误判成没有 key 而拒绝启动。
export function hasAnyLlmKey() {
  return freeProviders().length > 0 || !!DEEPSEEK_KEY || !!ANTHROPIC_KEY;
}

// 免费通道入口。函数名保留 extractGlmFree:server.mjs / channels.mjs / leads.mjs /
// locate-official.mjs / weekly.mjs 共 8 处直接 import 它,改名会牵动一片;语义已扩为
// "任意免费源"(不再只是 GLM),llmExtract 的兜底线也走这里。
// 顺序故障转移:链上每家试一次;整条链走完皆败 → 歇 1.2 秒再走第二轮(429 多为瞬时),
//   两轮皆败才抛错。因有备份可换,不再对单家做 5 次指数退避(那会把一次 429 拖成 7.5 秒,
//   白白堵住后面的提取)。
export async function extractGlmFree(system, user, maxTokens) {
  const avail = freeProviders();
  if (!avail.length) {
    throw new Error("免费通道不可用:请在 pipeline/.env 配 MOD_API_KEY(智谱)/ XFYUN_API_KEY(讯飞)/ " +
      "DASHSCOPE_API_KEY(百炼)/ SILICONFLOW_API_KEY(硅基流动) 中的任意一个");
  }
  let lastErr = null;
  const tried = [];
  for (let pass = 0; pass < 2; pass++) {
    for (const p of avail) {
      try { return await callOpenAICompat(p, system, user, maxTokens); }
      catch (e) {
        lastErr = e;
        if (pass === 0) tried.push(p.name + "(" + briefErr(e) + ")");
      }
    }
    if (pass === 0) await sleep(1200);
  }
  throw new Error("免费通道全线失败:" + tried.join(" / ") + (lastErr ? " | 末次:" + briefErr(lastErr) : ""));
}

function briefErr(e) {
  return String((e && e.message) || e).replace(/\s+/g, " ").slice(0, 80);
}

// 通用 OpenAI 兼容 /chat/completions 调用。
// 输出可能包 markdown 代码块(部分免费档不支持 response_format),剥掉再解析 JSON。
// usage.provider 记成该源 id,便于费用报告按源归集。
export async function callOpenAICompat(p, system, user, maxTokens) {
  const res = await fetch(p.url(), {
    method: "POST",
    headers: { "Authorization": "Bearer " + process.env[p.keyEnv], "Content-Type": "application/json" },
    body: JSON.stringify({
      model: p.model(),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      max_tokens: maxTokens || 1500
    }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error(p.name + " " + res.status + ": " + (await res.text()).slice(0, 200));
  const j = await res.json();
  let raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  raw = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  return {
    data: parseJson(raw),
    usage: {
      provider: p.id,
      input_tokens: (j.usage && j.usage.prompt_tokens) || 0,
      output_tokens: (j.usage && j.usage.completion_tokens) || 0
    },
    raw
  };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
