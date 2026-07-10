// trust.mjs —— 信任分级(需求第六步)。前端全靠这个。
//
//   verified  —— 人工核实过。【脚本永远不许自动写入这个值】,只能人工手改。本模块绝不产出 verified。
//   auto      —— 机器抓的。条件:来自官方机构域名 + 字段完整 + evidence 全部通过。自动上线,前端标"未经人工核实"。
//   pending   —— 其余全部。进 review-queue.json 等人工审,前端不显示。

// 判定一条经 verify 后的记录属于 auto 还是 pending。
// src 是 sources.json 里的信源条目(含 org_type)。
export function gradeTrust(rec, flags, src) {
  const reasons = [];

  // 可 auto 的来源:官方机构域名,或人工已核实并在 sources.json 标了 trust_auto:true 的信源
  // (如已核验过的 Open Call 聚合平台)。trust_auto 是人工对信源的信任决定,故符合"auto 需可信来源"的本意。
  const isTrustedSource = src && (src.org_type === "official" || src.trust_auto === true);
  if (!isTrustedSource) reasons.push("非可信来源(org_type=" + (src ? src.org_type : "?") + ",且未标 trust_auto)");

  // 字段完整:必须有截止(或明确常年)+ 有网址
  if (!flags.hasUrl) reasons.push("缺详情页网址");
  if (!flags.hasDeadline) reasons.push("缺截止日期且非常年");

  // evidence 全部通过(标题 + 各关键字段都没被作废)
  if (flags.anyEvidenceFail) reasons.push("有 evidence 未通过子串校验");

  const auto = isTrustedSource && flags.hasUrl && flags.hasDeadline && !flags.anyEvidenceFail;

  return {
    trust: auto ? "auto" : "pending",
    reasons                       // pending 的原因,写进 review-queue 便于人工审
  };
}
