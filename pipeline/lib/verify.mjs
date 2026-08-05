// verify.mjs —— 纯程序校验(不用 AI)。这是整个系统的支点。
//
// 需求第三/四节:AI 对自己编的东西一样自信,只有程序拿原文比对才是硬约束。
//  1. evidence 子串校验:每个关键字段的 evidence 必须是原文子串,否则该字段作废(置 null)并记 hallucination.log。
//  2. 截止日期必须能被解析。
//  3. 详情页网址必须与信源同域名,否则整条丢弃。
//  4. 缺截止日期或缺网址的,不许自动上线(交由 trust 分级降级为 pending)。

import { hasApplySignal } from "./applicability.mjs";

// 空白归一:压缩所有空白为单空格,便于容忍 HTML 抽取造成的空白差异。不改字符本身。
function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }

// evidence 是否为原文子串
export function evidenceInSource(evidence, sourceText) {
  const e = norm(evidence);
  if (!e) return false;
  return norm(sourceText).indexOf(e) !== -1;
}

// 日期能否解析为合法 YYYY-MM-DD
export function isParseableDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// 同域名(允许子域):详情页 host 的可注册域是否等于信源域
function sameDomain(url, sourceDomain) {
  try {
    const host = new URL(url).host.toLowerCase();
    const base = String(sourceDomain || "").toLowerCase().replace(/^www\./, "");
    return host === base || host.endsWith("." + base) || host.replace(/^www\./, "") === base;
  } catch (e) { return false; }
}

// 关键字段与其 evidence 的映射
const FIELD_EVIDENCE = [
  { field: "deadline", ev: "deadline" },
  { field: "apply_fee", ev: "apply_fee" },
  { field: "participation_fee", ev: "participation_fee" },
  { field: "funding", ev: "funding" },
  { field: "eligibility", ev: "eligibility" }
];

// 校验一条提取结果。
// 返回 { record, dropped, dropReason, nulled:[{field,evidence}], flags }
export function verifyRecord(extracted, ctx) {
  const nulled = [];
  const ev = extracted.evidence || {};
  const rec = JSON.parse(JSON.stringify(extracted));

  // 0) 不是可申请机会 → 丢弃
  if (extracted.applicable === false) {
    return { dropped: true, dropReason: "not-applicable:" + (extracted.reason || ""), nulled, record: null };
  }

  // 0.5) 【v1.0.1 硬闸】原文连一个"申请/征集"动词都没有 → 不可能是可申请机会。
  // 提示词第 9 条(展讯新闻→applicable:false)弱模型经常不执行,观展资讯被硬凑成机会;
  // 这条纯程序规则不依赖 AI 自觉,对典型观展页(只有 开幕/展期/门票/预约)一刀切拦截。
  if (ctx.sourceText && !hasApplySignal(ctx.sourceText)) {
    return { dropped: true, dropReason: "not-applicable:no-apply-signal(原文无任何申请/征集动词,疑为观展资讯)", nulled, record: null };
  }

  // 1) 标题 evidence 必须过(标题是身份,过不了整条存疑)
  const titleOk = evidenceInSource(ev.title, ctx.sourceText);

  // 2) 逐字段 evidence 子串校验;不过 → 该字段作废
  for (const { field, ev: evKey } of FIELD_EVIDENCE) {
    const hasValue = fieldHasValue(rec[field]);
    if (!hasValue) continue;                       // 字段本就是 null/未提,无需 evidence
    const ok = evidenceInSource(ev[evKey], ctx.sourceText);
    if (!ok) {
      nulled.push({ field, evidence: ev[evKey] || "", value: rec[field] });
      rec[field] = nullifyField(field);            // 作废
    }
  }

  // 3) deadline 必须可解析(null 合法 = 常年);不可解析 → 置 null
  if (rec.deadline != null && !isParseableDate(rec.deadline)) {
    nulled.push({ field: "deadline", evidence: ev.deadline || "", value: rec.deadline, reason: "unparseable-date" });
    rec.deadline = null;
  }

  // 3.5) 【新增 v0.98.0】截止日期已过 → 整条丢弃,绝不入库。
  // 招聘频道早有这道闸(channels.mjs 的 job-expired),机会频道一直没有——以前每日抓的是机构官网
  // 最新公告页,过期条目少见;区域经理做定向检索后会翻出归档老页面(实测抓到 2017/2019 年的征集),
  // 让用户点开一个 7 年前的截止日期,比少一条更伤可信度。存量老数据由「校勘」按既有规则归档,这里只管入口。
  // 已入库条目的到期不受影响(本函数只在【新提取】时调用);ctx.today 可注入便于测试。
  if (rec.deadline != null) {
    const today = ctx && ctx.today ? String(ctx.today) : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const grace = Math.max(0, Number(process.env.OPP_EXPIRED_GRACE_DAYS || 0));
    const cutoff = grace ? new Date(Date.parse(today + "T00:00:00Z") - grace * 86400e3).toISOString().slice(0, 10) : today;
    if (String(rec.deadline).slice(0, 10) < cutoff) {
      return { dropped: true, dropReason: "expired:" + rec.deadline, nulled, record: null };
    }
  }

  // 4) 详情页 URL 必须与信源同域名,否则整条丢弃
  const url = rec.url || ctx.url;
  if (!sameDomain(url, ctx.domain)) {
    return { dropped: true, dropReason: "cross-domain-url:" + url, nulled, record: null };
  }
  rec.url = url;
  rec.source_url = ctx.source_url || ctx.url;
  rec.domain = ctx.domain;

  // 结论标记(供 trust 分级用)
  const flags = {
    titleEvidenceOk: titleOk,
    hasDeadline: rec.deadline != null || (rec.deadline_note && /常年|长期|滚动|rolling|ongoing/i.test(rec.deadline_note)),
    hasUrl: !!rec.url,
    anyEvidenceFail: nulled.length > 0 || !titleOk
  };

  return { dropped: false, record: rec, nulled, flags };
}

function fieldHasValue(v) {
  if (v == null) return false;
  if (typeof v === "object") {
    // fee/funding/eligibility 这类对象:只要有非 null 的实质值就算"有值"
    return Object.keys(v).some(k => v[k] !== null && v[k] !== "" && !(k === "currency"));
  }
  if (Array.isArray(v)) return v.length > 0;
  return String(v).trim() !== "";
}

function nullifyField(field) {
  if (field === "deadline") return null;
  if (field === "apply_fee") return { free: null, amount: null, currency: null };
  if (field === "participation_fee") return { required: null, amount: null, currency: null };
  if (field === "funding") return { stipend: null, housing: null, travel: null };
  if (field === "eligibility") return { students_ok: null, age_limit: null, nationality: null };
  return null;
}

export { sameDomain, norm };
