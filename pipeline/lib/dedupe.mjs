// dedupe.mjs —— 去重(需求第五步):标题+机构+截止日期 做指纹,重复的合并,保留信息更完整的那条。
//
// v1.14.0 多口径升级:单指纹(标题+机构+截止)过度依赖 AI 翻译的中文标题,翻译不稳→同项目两次翻译不同→漏重。
// 现用多口径,【任一命中即判重】:
//   ① URL 归一化(最强,零误伤——同 URL 必重复):去追踪参数/去 hash/去尾斜杠/去 www.
//   ② 标题强归一化(去括号/年份/第X届/open call 等泛词):同项目的不同表述归一后相同
//   ③ 原指纹(标题+机构+截止)兜底
import { createHash } from "node:crypto";

function fp(o) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[\s　·:：()（）《》"'”“·-]/g, "");
  return createHash("md5").update(norm(o.title_zh) + "|" + norm(o.org_zh) + "|" + (o.deadline || "rolling")).digest("hex");
}
// 对外暴露指纹与完整度打分,供数据质检 agent(lib/qc.mjs)对存量库做重复条目巡检时复用同一口径。
export { fp as fingerprint };

// —— v1.14.0 多口径指纹 ——

// URL 归一化:去 hash、去追踪参数(utm_*/fbclid/gclid/ref/spm 等)、去尾斜杠、去 www.。返回 "" 表示无法归一。
export function normUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|gclsrc|ref|referrer|referral|source|mc_cid|mc_eid|spm|from|from_id|origin)$/i.test(k)) {
        x.searchParams.delete(k);
      }
    }
    const host = x.hostname.replace(/^www\./, "").toLowerCase();
    const path = x.pathname.replace(/\/+$/, "").toLowerCase();
    const q = x.search; // 保留非追踪查询参数(如 ?form=1 可能是不同申请入口)
    return (x.protocol + "//" + host + path + q).toLowerCase();
  } catch (e) { return ""; }
}

// 标题强归一化:只去通用尾缀词(open call / 报名 / 征集 / 征稿 等,不区分届次)与标点空白。
// 【保留】年份、"第X届"、括号内容(如"（春季）/（秋季）")——不同届/不同批次是不同项目,绝不因归一化被误并成重复。
// 仅"完全同名"的条目在此口径聚簇(配合 clusterKeys 里附带的 deadline 年月,同届重复才命中)。
export function normTitleKey(s) {
  s = String(s || "").toLowerCase()
    .replace(/\b(open call|call for entries|call for submission|call for artists|applications?|submissions?|apply|now accepting|artist|artists|residency program|programme)\b/g, " ")
    .replace(/(报名|征集|征稿|招募|申请|开放报名|活动通知|征稿启事|征稿通知|作品征集|征稿活动|报名启动|征集中|开始报名)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");                       // 只留字母数字
  return s.trim();
}

// 多口径聚簇键:返回该记录参与聚簇的所有 key(空 key 被跳过)。任一 key 相同即视为同一实体候选。
// 标题 key 附带 deadline 年月(无日期用 none)——同标题但截止差半年以上 = 不同届,不聚簇。
export function clusterKeys(o) {
  const keys = new Set();
  const u = normUrl(o.url || "");
  if (u && u.length > 8) keys.add("u:" + u);
  const t = normTitleKey(o.title_zh || o.title_en || o.title || "");
  const dm = o.deadline ? String(o.deadline).slice(0, 7) : "none";
  if (t && t.length >= 4) keys.add("t:" + t + "@" + dm);
  const f = fp(o);
  keys.add("f:" + f);
  return [...keys];
}

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

// 多口径去重:按 clusterKeys 聚簇,命中即合并,保留更完整者。供每日管道(run.mjs)入库前使用。
export function dedupe(records) {
  const owner = new Map();  // key -> 当前保留的记录
  const kept = new Set();   // 去重后的记录集合
  let merged = 0;
  for (const r of records) {
    const keys = clusterKeys(r);
    let hit = null;
    for (const k of keys) { if (owner.has(k)) { hit = owner.get(k); break; } }
    if (hit) {
      merged++;
      if (completeness(r) > completeness(hit)) {   // 新记录更全 → 顶替
        for (const k of keys) owner.set(k, r);
        kept.delete(hit); kept.add(r);
      }
    } else {
      for (const k of keys) owner.set(k, r);
      kept.add(r);
    }
  }
  return { list: Array.from(kept), merged };
}
