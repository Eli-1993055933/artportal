// moderation.mjs —— 内容审核模块(路线图前置 B):大陆平台 UGC 的法定前置。
// 三层设计的前两层(第三层 = /admin 人工复核):
//   ① 敏感词库:硬类(涉政/色情)命中 → 直接拒;软类(导流/广告)命中 → 标记人工优先看。
//      内置基础词库,可在 pipeline/state/badwords.txt 扩充(一行一词;行首 ! 表硬类)。
//   ② DeepSeek 机审:分类 正常/广告导流/无关灌水/涉政敏感/色情低俗/人身攻击/虚假可疑。
// 结论 verdict:reject(明显违规)/ review(可疑)/ pass(机审干净)。
// 审核策略(2026-07-17 起,用户拍板):pass → 自动通过并发布;review/reject → 留在
// 待审队列交人工。后台对全部内容(含自动通过的)可见、可拒/可下架,审计日志全程留痕。

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { llmExtract } from "./extract.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));

// 基础词库(刻意精简:硬类宁缺勿滥防误伤,软类抓典型导流/广告模式)
const HARD = ["法轮功", "六四事件", "反共", "台独", "港独", "疆独", "藏独", "裸聊", "约炮", "招嫖", "卖淫", "翻墙软件"];
const SOFT = ["加微信", "加vx", "加v信", "扫码进群", "加qq群", "代写", "代考", "办证", "开发票", "贷款", "博彩", "棋牌", "稳赚", "刷单", "返利", "点击链接领取"];
const SOFT_RE = [/微信[号:：]?\s*[a-zA-Z0-9_-]{5,}/, /QQ[号:：]?\s*\d{6,}/i, /(免费领|限时优惠|月入\s*\d+)/];

let extra = null;   // state/badwords.txt 扩充词(懒加载)
async function loadExtra() {
  if (extra) return extra;
  extra = { hard: [], soft: [] };
  try {
    const raw = await readFile(join(__dir, "..", "state", "badwords.txt"), "utf8");
    for (const line of raw.split("\n")) {
      const w = line.trim();
      if (!w || w.startsWith("#")) continue;
      if (w.startsWith("!")) extra.hard.push(w.slice(1));
      else extra.soft.push(w);
    }
  } catch (e) {}
  return extra;
}

export async function wordHits(text) {
  const ex = await loadExtra();
  const t = String(text || "");
  const hard = [...HARD, ...ex.hard].filter(w => t.includes(w));
  const soft = [...SOFT, ...ex.soft].filter(w => t.includes(w));
  for (const re of SOFT_RE) { const m = re.exec(t); if (m) soft.push(m[0].slice(0, 20)); }
  return { hard, soft };
}

// 机审提示词按【场景】区分——用错场景会大量误判(如拿"投稿"标准审短评论,
// 正常感想会被判"无关灌水"全进人工队列,AI 先审形同虚设)。
const AI_SYS = {
  submission:
    "你是内容审核员。用户在艺术平台投稿了一条『艺术机会』信息(展览征集/驻留/奖项/工作坊)。" +
    "判断这段内容属于哪一类,只输出一个 JSON,不要解释:\n" +
    '{"category":"正常|广告导流|无关灌水|涉政敏感|色情低俗|人身攻击|虚假可疑","reason":"一句话理由"}\n' +
    "判定要点:含联系方式导流/推销课程产品=广告导流;与艺术机会无关=无关灌水;" +
    "宣称高额回报、信息自相矛盾、机构不可考=虚假可疑;正常的艺术机会信息=正常。",
  comment:
    "你是内容审核员。用户在艺术平台的某条内容(展览/资讯/招聘/艺术作品)下发了一条评论。" +
    "判断这条评论属于哪一类,只输出一个 JSON,不要解释:\n" +
    '{"category":"正常|广告导流|涉政敏感|色情低俗|人身攻击|垃圾刷屏","reason":"一句话理由"}\n' +
    "判定要点:日常感想/提问/夸赞/吐槽/闲聊都算【正常】(评论本来就是随口聊,宽松对待);" +
    "含联系方式或买卖招揽=广告导流;辱骂攻击具体的人=人身攻击;纯乱码或复读机式刷屏=垃圾刷屏。",
  work:
    "你是内容审核员。艺术家在平台上传作品,这是作品的标题与介绍文字。" +
    "判断属于哪一类,只输出一个 JSON,不要解释:\n" +
    '{"category":"正常|广告导流|涉政敏感|色情低俗|人身攻击","reason":"一句话理由"}\n' +
    "判定要点:正常的作品名/媒介/尺寸/创作自述都算【正常】;含联系方式或卖课卖货招揽=广告导流。",
  profile:
    "你是内容审核员。用户在艺术平台填写了个人资料(简介/创作领域/所在地)。" +
    "判断属于哪一类,只输出一个 JSON,不要解释:\n" +
    '{"category":"正常|广告导流|涉政敏感|色情低俗|人身攻击","reason":"一句话理由"}\n' +
    "判定要点:正常的自我介绍都算【正常】;含联系方式导流或推销=广告导流。"
};
// —— 免费审核模型优先(v0.82.3,用户要求降成本):.env 配 MOD_API_KEY 即启用 ——
// 默认接智谱 GLM-4-Flash(API 长期免费、国内直连、OpenAI 兼容格式);
// MOD_API_URL / MOD_MODEL 可换任何 OpenAI 兼容服务(百炼 qwen-flash、硅基流动免费模型等)。
// 免费模型失败自动回落 DeepSeek;两边都挂才算机审失败(转人工,fail-closed 兜底不变)。
export async function freeModerate(sys, user) {
  const res = await fetch(process.env.MOD_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.MOD_API_KEY },
    body: JSON.stringify({
      model: process.env.MOD_MODEL || "glm-4-flash",
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.1,
      max_tokens: 300
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error("mod-api " + res.status);
  const j = await res.json();
  const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  const m = content.match(/\{[\s\S]*\}/);   // 免费模型可能包 markdown 代码块,剥出 JSON 再解析
  if (!m) throw new Error("mod-api no-json");
  return JSON.parse(m[0]);
}
async function aiModerate(text, kind) {
  const sys = AI_SYS[kind] || AI_SYS.submission;
  const user = "【待审内容】\n" + String(text).slice(0, 3000);
  let data = null;
  if (process.env.MOD_API_KEY) {
    try { data = await freeModerate(sys, user); } catch (e) { data = null; }   // 免费模型挂了回落 DeepSeek
  }
  if (!data) { const r = await llmExtract(sys, user, 300); data = r.data; }
  return {
    category: typeof data.category === "string" ? data.category.slice(0, 20) : "机审异常",
    reason: typeof data.reason === "string" ? data.reason.slice(0, 200) : ""
  };
}

// 主入口。kind = submission(默认) | comment | work | profile。返回 { verdict, hits, ai }
export async function moderateText(text, kind) {
  const hits = await wordHits(text);
  if (hits.hard.length) return { verdict: "reject", hits, ai: null };
  let ai = null;
  try { ai = await aiModerate(text, kind); }
  catch (e) { ai = { category: "机审失败", reason: String(e.message || e).slice(0, 100) }; }
  let verdict = "pass";
  if (hits.soft.length) verdict = "review";
  if (ai.category === "涉政敏感" || ai.category === "色情低俗") verdict = "reject";
  else if (ai.category !== "正常") verdict = "review";   // 含机审失败:宁可进人工队列
  return { verdict, hits, ai };
}
