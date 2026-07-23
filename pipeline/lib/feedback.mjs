// feedback.mjs —— 反馈/举报处理 agent「信箱」(v0.83.0,路线图第 15 项):
// 每日一巡:①给新进反馈做 AI 初判(分类/是否紧急/一句话摘要,便于站长扫一眼定先后);
// ②聚合被举报且仍公开的评论/作品,给出处置建议(删除/保留/人工细看);
// ③写 state/feedback-report.json 供 /admin「反馈信箱」展示,agentLog 打卡巡视台。
// AI 走免费审核通道优先(moderation.freeModerate,MOD_API_KEY),回落 DeepSeek;
// 两边都不可用就只做纯程序聚合(计数照报,初判留空,绝不编造)。

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freeModerate } from "./moderation.mjs";
import { llmExtract } from "./extract.mjs";
import * as db from "./db.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(__dir, "..", "state", "feedback-report.json");

// 统一的小 JSON 问答:免费模型优先 → DeepSeek 回落 → 都挂返回 null(调用方按"AI 不可用"处理)
async function askJSON(sys, user) {
  if (process.env.MOD_API_KEY) {
    try { return await freeModerate(sys, user); } catch (e) {}
  }
  try { const r = await llmExtract(sys, user, 300); return r.data; } catch (e) {}
  return null;
}

const FB_SYS =
  "你是艺术平台的反馈信箱管理员。下面是一条用户反馈,判定它并只输出 JSON,不要解释:\n" +
  '{"category":"bug|建议|求助|内容纠错|合作|垃圾","urgent":true或false,"note":"一句话摘要"}\n' +
  "判定要点:影响使用的故障=bug;用户遇到困难需要回复=求助(urgent=true);" +
  "指出站内信息有误=内容纠错;商务/机构合作意向=合作;广告或无意义灌水=垃圾。";

const REP_SYS =
  "你是艺术平台的内容裁决助手。下面是一条被用户举报的内容,判断如何处置,只输出 JSON:\n" +
  '{"advice":"删除|保留|人工细看","reason":"一句话理由"}\n' +
  "判定要点:明显违规(辱骂/广告导流/色情/涉政)=删除;正常内容被误报=保留;拿不准=人工细看。";

export async function feedbackAgentTick() {
  const t0 = Date.now();
  const out = { at: new Date().toISOString(), aiOn: true, judged: 0, urgent: 0, advices: [] };

  // ① 新反馈 AI 初判(只处理还没判过的,幂等)
  const pending = await db.feedbackPendingAI(30);
  for (const f of pending) {
    const ai = await askJSON(FB_SYS, "【反馈类型】" + f.type + "\n【内容】\n" + String(f.content).slice(0, 800));
    if (!ai) { out.aiOn = false; break; }   // AI 不可用:留空下轮再判,不硬编
    const rec = {
      category: typeof ai.category === "string" ? ai.category.slice(0, 12) : "待人工",
      urgent: ai.urgent === true,
      note: typeof ai.note === "string" ? ai.note.slice(0, 80) : ""
    };
    await db.setFeedbackAI(f.id, rec);
    out.judged++; if (rec.urgent) out.urgent++;
  }

  // ② 被举报内容处置建议(每轮最多 10 条,按举报数倒序)
  const rep = await db.reportedContent();
  out.reported = { comments: rep.comments.length, works: rep.works.length };
  if (out.aiOn) {
    const targets = [
      ...rep.comments.slice(0, 6).map(c => ({ kind: "comment", id: c.id, text: c.content, reports: c.reports })),
      ...rep.works.slice(0, 4).map(w => ({ kind: "work", id: w.id, text: w.title, reports: w.reports }))
    ];
    for (const t of targets) {
      const ai = await askJSON(REP_SYS, "【被举报" + (t.kind === "work" ? "作品标题" : "评论") + "(举报 " + t.reports + " 次)】\n" + String(t.text).slice(0, 500));
      if (!ai) { out.aiOn = false; break; }
      out.advices.push({ kind: t.kind, id: t.id,
        advice: typeof ai.advice === "string" ? ai.advice.slice(0, 8) : "人工细看",
        reason: typeof ai.reason === "string" ? ai.reason.slice(0, 60) : "" });
    }
  }

  out.newCount = await db.feedbackNewCount();
  out.took_ms = Date.now() - t0;
  try {
    mkdirSync(join(__dir, "..", "state"), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(out, null, 2), "utf8");
  } catch (e) {}
  return out;
}
