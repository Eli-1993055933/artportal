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

// v1.15.0 国内常年征集放宽(2026-10-07 用户确认):
// 国内大量官方征集为"常年/滚动",原文根本不写截止日期,旧规则一律不收 → 国内产量极低。
// 经确认:【仅国内来源】的无截止条目按"常年征集"收录,由调用方判定 cn 后调用本函数补标注。
// 反幻觉:不虚构任何日期;note 明确写"原文未提及截止时间",只声明收录口径,并提示以官网为准。
export const ROLLING_NOTE = "原文未提及截止时间，按常年征集收录（以官网为准）";
export function markRolling(record) {
  if (!record || record.deadline != null) return record;
  const note = String(record.deadline_note || "").trim();
  if (/常年|长期|滚动|rolling|ongoing|长期有效|全年|随时/i.test(note)) {
    // 已是滚动口径:若除通用套话外无实质信息,归一为标准文案(防反复追加造成重复)
    const stripped = note.replace(/原文未提及截止时间[，,]?/g, "")
      .replace(/按常年征集收录(（以官网为准）|\(以官网为准\))/g, "")
      .replace(/[；;、,\s]/g, "");
    if (!stripped) record.deadline_note = ROLLING_NOTE;
    return record;
  }
  if (!note || /原文未提及截止时间/.test(note)) { record.deadline_note = ROLLING_NOTE; return record; }
  record.deadline_note = note + "；" + ROLLING_NOTE;
  return record;
}

// v1.15.0 无截止条目的陈旧判定(配合「常年放宽」):
// 原文没给可解析截止、又没滚动用语时,标题/备注里的年份与日期是唯一线索。
// 返回 "future"(含今年或更晚的年份/日期,可留) | "stale"(只出现过今年以前的年份/日期,判陈旧) | "rolling"(无任何线索,按常年)。
export function classifyNoDeadline(record, today) {
  const note = String((record && record.deadline_note) || "");
  if (/常年|长期|滚动|rolling|ongoing|长期有效|全年|随时/i.test(note)) return "rolling";   // 明确滚动口径,不判旧
  const t = String((record && (record.title_zh || record.title_en)) || "") + " " + note;
  const td = String(today || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10));
  const cur = Number(td.slice(0, 4));
  const dates = [];
  const re = /(20\d{2})\s*[-年./]\s*(\d{1,2})\s*[-月./]\s*(\d{1,2})/g;
  let m;
  while ((m = re.exec(t))) dates.push(m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0"));
  if (dates.length) return dates.some(d => d >= td) ? "future" : "stale";
  // 无年份的「M月D日」:与今年的同一日比较,已过 → 判旧(如「6月26日截止」在 10 月被抓到)
  const mds = [...t.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)].map(x => [Number(x[1]), Number(x[2])]);
  if (mds.length) {
    const tmd = [Number(td.slice(5, 7)), Number(td.slice(8, 10))];
    const cmp = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
    return mds.some(x => cmp(x, tmd) >= 0) ? "future" : "stale";
  }
  const years = (t.match(/20\d{2}/g) || []).map(Number);
  if (years.length) return Math.max(...years) >= cur ? "future" : "stale";
  return "rolling";
}

// v1.16.0 从 deadline_note 回填 deadline(2026-10-08 用户批准,路线图增量杠杆①):
// 存量不少条目 deadline=null,但备注(AI 摘录原文所得)里其实写明了截止日期,
// 如「征稿截止时间：2026年8月31日」。本函数只把【备注里已有的日期】结构化成 ISO,
// 【绝不推断、绝不编造】;是否采纳由调用方再用 verifyDeadlineInSource() 拿原文复核。
export function parseDeadlineFromNote(note) {
  const t = String(note || "");
  if (!t) return null;
  // ① 长期/滚动/分期类:绝不能设成"某一天截止",否则会把长期有效条目错误判为已截止并隐藏。
  if (/长期有效|常态化|常年|随时|滚动|每年\s*[一二三四五六七八九十\d]+\s*次|每季度|每半年|分批征集|分批次/i.test(t)) return null;
  // ② 必须处在「征集/截止」语境;否则多半是展览/活动时间(如「展览时间：8月17日—9月6日」),不解析。
  if (!/(截止|截至|截稿|投稿|征稿|征集|申报|报名|申请|提交|上传|寄送|报送|收件|deadline|due|apply|submit|closes?|ends?)/i.test(t)) return null;
  // 兼容:2026年8月31日 / 2026-08-31 / 2026/8/31 / 8月31日(无年 → 继承前文最近年份)
  const re = /(?:(20\d{2})\s*[-年.\/]\s*)?(\d{1,2})\s*[-月.\/]\s*(\d{1,2})\s*日?/g;
  const hits = [];
  let m;
  while ((m = re.exec(t))) {
    let y = m[1] ? Number(m[1]) : null;
    if (!y) {
      const before = t.slice(0, m.index).match(/20\d{2}/g);
      y = before ? Number(before[before.length - 1]) : new Date(Date.now() + 8 * 3600e3).getUTCFullYear();
    }
    const mo = Number(m[2]), da = Number(m[3]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) continue;
    hits.push({ iso: y + "-" + String(mo).padStart(2, "0") + "-" + String(da).padStart(2, "0"), idx: m.index });
  }
  if (!hits.length) return null;
  // 截止语境优先:取「截止/截至/延至/即日起至/起止时间/deadline/due/by…」之后最近的日期
  const cutRe = /(截止|截至|延至|延长至|顺延至|报名至|征稿至|申请至|提交至|上传至|即日起至|起止时间|deadline|due|closes|before|by)/gi;
  let cut = -1;
  while ((m = cutRe.exec(t))) if (m.index > cut) cut = m.index;
  if (cut >= 0) {
    const after = hits.filter(h => h.idx >= cut);
    if (after.length) return after[after.length - 1].iso;
  }
  return hits[hits.length - 1].iso;   // 兜底:中文「起止…至X」把截止放最后,取最后一个日期
}

// 反幻觉复核:解析出的日期必须在原文里出现(容忍空白/常见分隔符;中英文月份名皆可)。
export function verifyDeadlineInSource(iso, sourceText) {
  const s = String(sourceText || "");
  if (!s || !/^20\d{2}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, mo, da] = iso.split("-").map(Number);
  const sep = "[\\s]*(?:年|[-/.])[\\s]*";
  const cn = new RegExp(y + sep + "0?" + mo + "[\\s]*(?:月|[-/.])[\\s]*0?" + da + "[\\s]*日?");
  if (cn.test(s)) return true;
  const MN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = MN[mo - 1];
  const en = new RegExp("(?:" + mon + "[a-z]*\\.?\\s*0?" + da + "\\s*,?\\s*" + y + "|0?" + da + "\\s*" + mon + "[a-z]*\\.?\\s*,?\\s*" + y + ")", "i");
  return en.test(s);
}

export { sameDomain, norm };
