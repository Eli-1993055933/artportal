// report.mjs —— 每次跑完输出一份报告(需求第四节末):
// 新增几条 / 更新几条 / 待审几条 / 失败信源几个 / 疑似编造几处 / 这次花了多少钱。
export function buildReport(stats) {
  const lines = [];
  lines.push("========== ArtPortal 数据管道运行报告 ==========");
  lines.push("时间: " + stats.at);
  lines.push("信源: 共 " + stats.sourcesTotal + " 个,成功 " + stats.sourcesOk + ",跳过/失败 " + stats.sourcesFailed.length +
    (stats.tierSkipped ? ",低产出降频跳过 " + stats.tierSkipped : ""));
  lines.push("哈希/条件请求未变跳过(省钱): " + stats.unchanged + " 个");
  lines.push("调用 AI 提取: " + stats.extracted + " 次");
  lines.push("");
  lines.push("新增上线(auto): " + stats.added);
  lines.push("更新: " + stats.updated);
  lines.push("待人工审(pending): " + stats.pending);
  lines.push("整条丢弃(非机会/跨域): " + stats.dropped);
  lines.push("疑似编造(evidence 未过被作废的字段): " + stats.hallucinations + " 处");
  if (stats.hidden) lines.push("健康检查隐藏: 过期 " + stats.hidden.hiddenExpired + " · 失联 " + stats.hidden.hiddenDead);
  lines.push("");
  lines.push("本次费用: 约 $" + stats.cost.toFixed(4) + " (input " + stats.tokensIn + " / output " + stats.tokensOut + " tokens)");
  if (stats.sourcesFailed.length) {
    lines.push("");
    lines.push("失败/跳过信源明细:");
    for (const f of stats.sourcesFailed) lines.push("  - " + f.id + ": " + f.reason);
  }
  lines.push("===============================================");
  return lines.join("\n");
}
