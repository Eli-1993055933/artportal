// healthcheck.mjs —— 每日健康检查(需求第七步)。
//   · 对已上线每条网址发一次请求;连续 3 天打不开 → 自动隐藏(status=dead)。
//   · 截止日期已过 → 自动隐藏(status=expired),但不删除数据(留作推断每年开放规律)。
import { USER_AGENT } from "./fetch.mjs";

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

async function ping(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { method: "GET", signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
    return r.ok || (r.status >= 300 && r.status < 400);
  } catch (e) { return false; }
  finally { clearTimeout(t); }
}

// records: 现有上线数据(含 _fail_streak 内部计数,可选)
export async function healthCheck(records) {
  const today = todayISO();
  let hiddenExpired = 0, hiddenDead = 0, revived = 0;

  for (const o of records) {
    // 1) 过期隐藏(不删)
    if (o.deadline && o.deadline < today && o.status === "open") {
      o.status = "expired"; hiddenExpired++;
    }
    // 2) 存活探测(仅对仍展示的条目)
    if (o.status === "open" || o.status === "expired") {
      const alive = await ping(o.url);
      if (alive) {
        if ((o._fail_streak || 0) > 0) revived++;
        o._fail_streak = 0; o.last_seen = today;
      } else {
        o._fail_streak = (o._fail_streak || 0) + 1;
        if (o._fail_streak >= 3) { o.status = "dead"; hiddenDead++; }  // 连续 3 天打不开
      }
    }
  }
  return { hiddenExpired, hiddenDead, revived };
}
