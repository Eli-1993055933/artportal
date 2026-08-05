// applicability.mjs —— 「可申请性」双重闸门(v1.0.1)。
//
// 背景:提取提示词第 9 条早就要求"展讯新闻/公示→applicable:false",但免费弱模型(GLM-4-flash)
// 在大提取任务里经常不执行这条,导致"面向公众的展览开放资讯"被硬凑成机会入库(2026-08-04 实锤)。
// 修法遵循本项目既定纪律:凡靠提示词约束的地方,都要有确定性代码兜底。
//
//  ① hasApplySignal —— 纯正则硬闸(不花 AI):可申请机会的原文必然含"申请/征集"类动词(多语种);
//     一个都没有的页面(典型观展资讯:只有 开幕/展期/门票/预约参观)不可能是可申请机会,
//     verifyRecord 据此直接丢弃。这一条同时省掉这些页面的 AI 提取后处理成本。
//  ② judgeApplicability —— 窄二判(AI,GLM 能胜任的窄问题):弱模型做不好 40 字段大提取,
//     但「A 可申请机会 / B 观展资讯」的二选一判断可靠得多;evidence 必须是原文子串(程序校验),
//     只在"确信 B 且证据过验"时拦截,拿不准一律放行(宁可放行交后续人工/校勘,不误杀)。

const APPLY_SIGNALS = [
  // 中文
  "征集", "征稿", "投稿", "申请", "报名", "递交", "提交", "招募", "参赛", "应征", "甄选", "遴选", "申报",
  // 英文
  "open call", "call for", "apply", "application", "submission", "submit", "entries", "entry form",
  "register", "registration", "enroll", "enrol", "nomination", "nominate", "proposal",
  // 日 / 韩
  "応募", "募集", "公募", "공모", "지원",
  // 法 / 德 / 西 / 意 / 葡 / 荷(inscri 覆盖 inscription/inscripción/inscrição)
  "candidature", "postuler", "appel à", "bewerbung", "ausschreibung", "einreich",
  "convocatoria", "postulación", "bando", "candidatura", "inscri", "aanmeld", "inzending"
];
const APPLY_RE = new RegExp(APPLY_SIGNALS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

// 原文里是否出现过任意一个"申请/征集"信号词
export function hasApplySignal(text) { return APPLY_RE.test(String(text || "")); }

// 与 verify.mjs 同口径的空白归一子串校验(本地内联,避免与 extract.mjs/verify.mjs 组成循环依赖)
function normWS(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function inSource(evidence, sourceText) {
  const e = normWS(evidence);
  return !!e && normWS(sourceText).indexOf(e) !== -1;
}

const JUDGE_SYS =
  "你是艺术机会审核员。判断下面这段【机构官网原文】的主要内容属于哪一类:\n" +
  "A = 面向艺术家/创作者/学生的【可申请机会】:读者可以提交作品、方案,或报名参与征集/驻留/奖项/工作坊。\n" +
  "B = 面向公众的【观展/活动资讯】或一般公告:开幕、展期、购票、预约参观、讲座通知、获奖公示、招标采购、人事任命等,读者只能去看展/参加活动,不能作为创作者提交申请。\n" +
  '只输出一个 JSON:{"kind":"A"或"B","evidence":"原文里最能证明你判断的一句逐字原文"}\n' +
  "规则:evidence 必须是原文中一字不差的连续片段,程序会校验;拿不准就选 A(后续还有人工审核,宁可放行不可误杀)。";

// 窄二判。返回 { block, evidence? }:仅当模型判 B 且 evidence 通过原文子串校验才 block。
export async function judgeApplicability(sourceText, title) {
  const { llmExtract } = await import("./extract.mjs");   // 动态引入,避免与 extract.mjs 构成静态循环依赖
  const user = (title ? "标题:" + title + "\n" : "") + "【机构官网原文】\n" + String(sourceText || "").slice(0, 6000);
  const r = await llmExtract(JUDGE_SYS, user, 200);
  const d = (r && r.data) || {};
  if (d.kind === "B" && inSource(d.evidence, sourceText)) return { block: true, evidence: normWS(d.evidence) };
  return { block: false };
}
