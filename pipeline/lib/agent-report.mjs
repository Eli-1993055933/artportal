// agent-report.mjs —— 本机管道脚本 → 服务器「Agent 巡视台」打卡(v0.72.0)。
// 每个 agent 干完活调用一次 reportAgent,后台 /admin「Agent 编队」即可像巡视工位一样看到:
// 谁在岗、上次干了什么、产出多少、有没有失败。
// 鉴权:.env 的 AGENT_KEY(本机与服务器同值);未配置或网络不通时静默跳过,绝不影响管道本身。
// 服务器内部的 agent(自动检索/周刊/群发)不走这里,直接写 db.agentLog。

export async function reportAgent(agent, ok, summary, metrics, took_ms) {
  const key = process.env.AGENT_KEY;
  if (!key) return;
  const base = (process.env.AGENT_REPORT_URL || "http://60.205.212.195").replace(/\/+$/, "");
  try {
    await fetch(base + "/api/agent/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, agent, ok: !!ok, summary: summary || "", metrics: metrics || null, took_ms: took_ms || null }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (e) { /* 打卡失败不影响正事 */ }
}
