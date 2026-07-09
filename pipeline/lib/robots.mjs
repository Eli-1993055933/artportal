// robots.mjs —— 读取并解析 robots.txt,判断某路径是否允许我们抓取。
//
// 合规铁律(需求第二/四节):抓取前必须读 robots.txt 并遵守,禁止即跳过。
// 我们的 UA 如实署名(见 fetch.mjs),不伪装浏览器绕过。
// 若目标站在 robots 里用 `User-agent: *  Disallow: /` 覆盖了我们,则整站跳过。
// 注意:部分海外站(e-flux/ISCP/Rijksakademie/TransArtists 等)按名封禁 ClaudeBot/GPTBot
// 等 AI 爬虫。我们的 UA token 是 ArtPortalBot——只有当规则显式匹配 ArtPortalBot 或 * 时才对我们生效。

export const UA_TOKEN = "ArtPortalBot";

// 解析 robots.txt 文本 → 适用于 uaToken 的规则组 { allow:[], disallow:[] }
export function parseRobots(text, uaToken) {
  const lines = String(text || "").split(/\r?\n/);
  const groups = []; // { agents:[], allow:[], disallow:[] }
  let cur = null;
  let lastWasAgent = false;

  for (let raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      if (!cur) { cur = { agents: ["*"], allow: [], disallow: [] }; groups.push(cur); }
      (field === "allow" ? cur.allow : cur.disallow).push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  // 选最匹配的组:优先精确匹配我们的 token,否则 *
  const ua = uaToken.toLowerCase();
  let chosen = groups.find(g => g.agents.some(a => a !== "*" && ua.indexOf(a) !== -1));
  if (!chosen) chosen = groups.find(g => g.agents.includes("*"));
  return chosen || { agents: ["*"], allow: [], disallow: [] };
}

// path 是否被允许。规则:匹配到的最长(more specific)指令胜出;Allow 与 Disallow 等长时 Allow 胜。
export function isAllowed(rules, path) {
  const match = (patterns) => {
    let best = -1;
    for (const p of patterns) {
      if (p === "") continue;
      // 简化的通配:支持前缀与 * 通配、$ 结尾
      const rx = robotPatternToRegex(p);
      const m = rx.exec(path);
      if (m && m.index === 0) best = Math.max(best, p.replace(/\*/g, "").length);
    }
    return best;
  };
  const dis = match(rules.disallow);
  const alw = match(rules.allow);
  if (dis === -1) return true;        // 没有 Disallow 命中 → 允许
  return alw >= dis;                  // Allow 至少和 Disallow 一样具体 → 允许
}

function robotPatternToRegex(pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re);
}
