// dedupe.mjs —— 去重(需求第五步):标题+机构+截止日期 做指纹,重复的合并,保留信息更完整的那条。
import { createHash } from "node:crypto";

function fp(o) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s　·:：()（）《》"'”“·-]/g, "");
  return createHash("md5").update(norm(o.title_zh) + "|" + norm(o.org_zh) + "|" + (o.deadline || "rolling")).digest("hex");
}
// 对外暴露指纹与完整度打分,供数据质检 agent(lib/qc.mjs)对存量库做重复条目巡检时复用同一口径。
export { fp as fingerprint };

// 完整度打分:非 null 的实质字段越多越完整
export function completeness(o) {
  let n = 0;
  const bump = (v) => { if (v !== null && v !== undefined && v !== "") n++; };
  bump(o.title_en); bump(o.city_zh); bump(o.country_zh); bump(o.deadline);
  if (o.apply_fee) bump(o.apply_fee.free);
  if (o.participation_fee) bump(o.participation_fee.required);
  if (o.funding) { bump(o.funding.stipend); bump(o.funding.housing); bump(o.funding.travel); }
  if (o.eligibility) { bump(o.eligibility.students_ok); bump(o.eligibility.age_limit); bump(o.eligibility.nationality); }
  if (o.disciplines) n += o.disciplines.length;
  bump(o.summary_zh);
  if (o.trust === "verified") n += 100; // 人工核实过的永远优先保留
  return n;
}

export function dedupe(records) {
  const byFp = new Map();
  let merged = 0;
  for (const r of records) {
    const k = fp(r);
    if (!byFp.has(k)) { byFp.set(k, r); continue; }
    merged++;
    const prev = byFp.get(k);
    byFp.set(k, completeness(r) > completeness(prev) ? r : prev);
  }
  return { list: Array.from(byFp.values()), merged };
}
