// verify.mjs —— 纯程序校验(不用 AI)。这是整个系统的支点。
//
// 需求第三/四节:AI 对自己编的东西一样自信,只有程序拿原文比对才是硬约束。
//  1. evidence 子串校验:每个关键字段的 evidence 必须是原文子串,否则该字段作废(置 null)并记 hallucination.log。
//  2. 截止日期必须能被解析。
//  3. 详情页网址必须与信源同域名,否则整条丢弃。
//  4. 缺截止日期或缺网址的,不许自动上线(交由 trust 分级降级为 pending)。

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
