// regions.mjs —— 区域经理编队(v0.98.0,路线图第 18 项 L3)
//
// 用户诉求:在全球艺术兴盛的地方各设一个"区域经理",轮流每天为站点抓取信息,
// 既摊平能耗、又让站点每天都有新内容进来。
//
// 本模块只管【调度与成绩单】,不碰抓取本身——抓取仍走 server.mjs 里那条唯一的
// 反幻觉管线(搜索→抓原文→evidence 逐字校验→真实才入库),红线一条不动。
//
// 三条设计要点(与用户原案的差异,见 regions.json 的 note):
//   ① 中国基本盘 kind=resident 天天上班,不参与轮值——主力用户是中国艺术院校毕业生,
//      "周一中国、周二亚洲"会让他们最关心的内容 6 天不更新。
//   ② 轮值按【日序号取模】,不按星期几:星期只有 7 天,装不下 10 个国际大区。
//   ③ 上班时间按【当地】时区的上午:机构刚发完通知、当地站点就近,且负载天然摊到 24 小时
//      (真正的"降低能耗"是摊平,不是凌晨一次性灌)。

import { readFile, writeFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const REGIONS_PATH = join(ROOT, "regions.json");
const REPORT_PATH = join(ROOT, "state", "regions-report.json");

let cfg = null;

// ---------- 加载与校验 ----------
// 配置坏了宁可整块停摆(返回 null,调度端跳过),也绝不"猜一个默认值"继续跑——
// 猜出来的地区会把不相干的内容抓进库,那是内容质量问题,比不抓更糟。
export async function loadRegions(force = false) {
  if (cfg && !force) return cfg;
  const raw = JSON.parse(await readFile(REGIONS_PATH, "utf8"));
  const ms = Array.isArray(raw.managers) ? raw.managers : [];
  const seen = new Set();
  const ok = [];
  for (const m of ms) {
    if (!m || typeof m.id !== "string" || !m.id) continue;
    if (seen.has(m.id)) continue;                                     // id 必须唯一
    if (!Array.isArray(m.queries) || !m.queries.length) continue;     // 没词池的经理没意义
    if (!["resident", "cn", "intl"].includes(m.kind)) continue;
    if (!Number.isFinite(m.tz) || !Number.isFinite(m.hour)) continue;
    if (m.hour < 0 || m.hour > 23) continue;
    seen.add(m.id);
    ok.push({
      id: m.id, zh: m.zh || m.id, en: m.en || m.id, kind: m.kind,
      slot: Number.isFinite(m.slot) ? m.slot : 0,
      tz: m.tz, hour: m.hour,
      gl: String(m.gl || "cn").toLowerCase(), hl: String(m.hl || "zh-cn"),
      terms: Array.isArray(m.terms) ? m.terms.filter(Boolean).map(String) : [],
      queries: m.queries.filter(Boolean).map(String)
    });
  }
  const desk = (raw.desk && Array.isArray(raw.desk.shifts)) ? raw.desk.shifts.filter(
    s => s && (s.channel === "news" || s.channel === "jobs") && Number.isFinite(s.utc_hour)
  ) : [];
  cfg = { version: raw.version || 1, updated: raw.updated || null, managers: ok, desk };
  return cfg;
}

// ---------- 轮值 ----------
// 日序号:按北京时间日切(全站其余定时任务都用北京日,保持一致)
export function dayIndex(now = new Date()) {
  return Math.floor((now.getTime() + 8 * 3600e3) / 86400000);
}
// 某组(cn / intl)今天当值的那一位
export function onDutyOf(kind, managers, now = new Date()) {
  const g = managers.filter(m => m.kind === kind).sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  if (!g.length) return null;
  return g[dayIndex(now) % g.length];
}
// 经理的上班时刻换算成 UTC 整点(当地 hour - 当地时区偏移)
export function utcHourOf(m) { return ((Math.round(m.hour - m.tz) % 24) + 24) % 24; }

// 今天该上班的全部经理(常驻 + 各组当值一位)
export function dutyRoster(managers, now = new Date()) {
  const out = managers.filter(m => m.kind === "resident");
  for (const kind of ["cn", "intl"]) {
    const d = onDutyOf(kind, managers, now);
    if (d) out.push(d);
  }
  return out;
}
// 此刻(UTC 整点)应当上班的经理:今天当值 且 到了他的上班点
export function dueNow(managers, now = new Date()) {
  const h = now.getUTCHours();
  return dutyRoster(managers, now).filter(m => utcHourOf(m) === h);
}

// 给前端/巡视台用:每位经理的当值状态与下次上班日
export function rosterView(managers, now = new Date()) {
  const today = dayIndex(now);
  return managers.map(m => {
    let onDuty = m.kind === "resident";
    let nextInDays = 0;
    if (!onDuty) {
      const g = managers.filter(x => x.kind === m.kind).sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
      const idx = g.findIndex(x => x.id === m.id);
      const cur = today % g.length;
      onDuty = idx === cur;
      nextInDays = onDuty ? 0 : ((idx - cur) + g.length) % g.length;
    }
    return {
      id: m.id, zh: m.zh, en: m.en, kind: m.kind, tz: m.tz, hour: m.hour,
      utc_hour: utcHourOf(m), gl: m.gl, queries: m.queries.length,
      on_duty: onDuty, next_in_days: nextInDays
    };
  });
}

// ---------- 取词 ----------
// 每班取 n 条不重复的词。取词用【日序号 + 经理 id】做确定性起点再顺序取,
// 不用 Math.random:同一天重启进程不会重复抓同几条,长期又能把词池均匀走完。
export function pickQueries(m, n, now = new Date()) {
  const pool = m.queries;
  if (!pool.length) return [];
  let seed = dayIndex(now);
  for (const ch of m.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const start = seed % pool.length;
  const out = [];
  for (let i = 0; i < Math.min(n, pool.length); i++) out.push(pool[(start + i) % pool.length]);
  return out;
}

// ---------- 成绩单 ----------
// 记录每位经理的产出,用于:①巡视台工牌显示 ②后续按入库率调配额(高产加码、低产降频保底)。
let report = null;
export async function loadReport() {
  if (report) return report;
  try { report = JSON.parse(await readFile(REPORT_PATH, "utf8")); }
  catch (e) { report = { updated: null, managers: {} }; }
  if (!report.managers) report.managers = {};
  return report;
}
export async function recordShift(id, { q, probed, added, ok = true, error = null, took_ms = 0 }) {
  const r = await loadReport();
  const m = r.managers[id] || (r.managers[id] = { shifts: 0, probed: 0, added: 0, fails: 0, recent: [] });
  m.shifts++;
  m.probed += Number(probed || 0);
  m.added += Number(added || 0);
  if (!ok) m.fails++;
  m.last_at = new Date().toISOString();
  m.last_q = q || null;
  m.last_added = Number(added || 0);
  m.recent.unshift({ at: m.last_at, q: q || null, probed: Number(probed || 0), added: Number(added || 0), ok, error: error ? String(error).slice(0, 120) : null, took_ms });
  if (m.recent.length > 12) m.recent.length = 12;
  r.updated = m.last_at;
  try {
    const tmp = REPORT_PATH + ".tmp-" + process.pid;
    await writeFile(tmp, JSON.stringify(r, null, 2), "utf8");
    await rename(tmp, REPORT_PATH);                    // 原子写,与 run.mjs/server 同写不撕裂
  } catch (e) { /* 成绩单写失败不影响抓取本身 */ }
  return m;
}
export async function reportView() {
  const r = await loadReport();
  return r.managers || {};
}
