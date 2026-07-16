// moderation.mjs —— 内容审核模块(路线图前置 B):大陆平台 UGC 的法定前置。
// 三层设计的前两层(第三层 = /admin 人工复核):
//   ① 敏感词库:硬类(涉政/色情)命中 → 直接拒;软类(导流/广告)命中 → 标记人工优先看。
//      内置基础词库,可在 pipeline/state/badwords.txt 扩充(一行一词;行首 ! 表硬类)。
//   ② DeepSeek 机审:分类 正常/广告导流/无关灌水/涉政敏感/色情低俗/人身攻击/虚假可疑。
// 结论 verdict:reject(明显违规,自动拒)/ review(可疑,人工优先)/ pass(机审干净)。
// 注意:投稿无论 pass 与否都必须人工通过才发布;机审只做预筛与标注,人说了才算。

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

async function aiModerate(text) {
  const sys = "你是内容审核员。用户在艺术平台投稿了一条『艺术机会』信息(展览征集/驻留/奖项/工作坊)。" +
    "判断这段内容属于哪一类,只输出一个 JSON,不要解释:\n" +
    '{"category":"正常|广告导流|无关灌水|涉政敏感|色情低俗|人身攻击|虚假可疑","reason":"一句话理由"}\n' +
    "判定要点:含联系方式导流/推销课程产品=广告导流;与艺术机会无关=无关灌水;" +
    "宣称高额回报、信息自相矛盾、机构不可考=虚假可疑;正常的艺术机会信息=正常。";
  const r = await llmExtract(sys, "【投稿内容】\n" + String(text).slice(0, 3000), 300);
  return {
    category: typeof r.data.category === "string" ? r.data.category.slice(0, 20) : "机审异常",
    reason: typeof r.data.reason === "string" ? r.data.reason.slice(0, 200) : ""
  };
}

// 主入口。返回 { verdict, hits, ai }
export async function moderateText(text) {
  const hits = await wordHits(text);
  if (hits.hard.length) return { verdict: "reject", hits, ai: null };
  let ai = null;
  try { ai = await aiModerate(text); }
  catch (e) { ai = { category: "机审失败", reason: String(e.message || e).slice(0, 100) }; }
  let verdict = "pass";
  if (hits.soft.length) verdict = "review";
  if (ai.category === "涉政敏感" || ai.category === "色情低俗") verdict = "reject";
  else if (ai.category !== "正常") verdict = "review";   // 含机审失败:宁可进人工队列
  return { verdict, hits, ai };
}
