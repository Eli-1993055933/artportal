// qc.mjs —— 数据质检 agent「校勘」的巡检引擎(v0.74.0)。
//
// 职责:对三频道存量库做四类离线巡检,产出结构化发现,交由调用方(server.mjs)落库。
//   ① 死链检测:逐条探测详情页/申请页,连续 N 天打不开 → 建议判 dead(隐藏,不删)。
//   ② 过期归档:机会截止过久 / 招聘截止超 60 天 / 资讯发布超 2 年 → 建议归档进回收站(可恢复)。
//   ③ 重复条目:复用 dedupe 指纹口径,同指纹多条 → 保留最全者,其余建议归档。
//   ④ 存证抽查(反幻觉):对小样本活着的机会,重抓原文→AI 重提取→比对,截止漂移/已非可申请 → 转人工复核。
//
// 本模块【只巡检、只返回发现,不碰数据文件】——落库(改 status、归档写墓碑、写报告)全由调用方在写锁内做。
// 网络探测走注入的 gate(与用户检索共用并发闸,做好公民);死链探测与存证抽查【共用同一次抓取】,零额外成本。
//
// 存证抽查为何不用"存库值是否原文子串":存库的 title_zh/org_zh/deadline_note 大多是入库时 AI 处理/翻译过的中文
// (外文源根本不含),deadline_note 还常是合成摘要——子串法误报极高。唯一可靠法是重抓原文→AI 重提取→比对,
// 由调用方注入 evidenceAudit(record, sourceText, ctx)(复用入库同一条 extract+verifyRecord 管线);未注入则跳过。
//
// 反幻觉红线:与入库同一把尺子,疑似即人工,绝不 AI 编造、绝不擅自删。

import { isParseableDate } from "./verify.mjs";
import { fetchSource } from "./fetch.mjs";
import { fingerprint, completeness } from "./dedupe.mjs";

// 频道差异:链接字段 / 日期字段 / 归档规则。键名与 sync 墓碑、CH_FILES 一致。
export const CH_META = {
  opportunities: { urlField: "url", dateField: "deadline", kind: "opp" },
  news:          { urlField: "url", dateField: "published_at", kind: "news" },
  jobs:          { urlField: "apply_url", dateField: "deadline", kind: "jobs" }
};

function todayISO(d = new Date()) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
// 两个 YYYY-MM-DD 相差天数(a-b,正=a 更晚);任一不可解析返回 null。
function daysBetween(a, b) {
  if (!isParseableDate(a) || !isParseableDate(b)) return null;
  return Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);
}
function firstDate(o, fields) {
  for (const f of fields) if (o[f] && isParseableDate(String(o[f]).slice(0, 10))) return String(o[f]).slice(0, 10);
  return null;
}
function hostOf(u) { try { return new URL(u).host.replace(/^www\./, ""); } catch (e) { return ""; } }

// 简易并发闸:未注入 gate 时用本地限流;注入了就借用全局信号量(与用户检索互不挤占)。
async function mapLimit(items, limit, gate, worker) {
  const ret = new Array(items.length);
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      if (gate) await gate.acquire();
      try { ret[idx] = await worker(items[idx], idx); }
      finally { if (gate) gate.release(); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, run));
  return ret;
}

// 探测一次:活/死/说不清(robots 禁抓、限速跳过等不算死)。活的话附回原文 text,供存证抽查复用。
async function probe(url) {
  try {
    const r = await fetchSource({ url, type: "html" });
    if (r.skipped) {
      // robots 禁抓 → 说不清(不惩罚);http-4xx/5xx、fetch-error → 死
      if (r.reason === "robots-disallow") return { verdict: "unknown", reason: r.reason };
      return { verdict: "dead", reason: r.reason, status: r.status || null };
    }
    return { verdict: "alive", status: r.status, text: r.text || "", finalUrl: r.finalUrl || url };
  } catch (e) {
    return { verdict: "dead", reason: "probe-error:" + String(e.message || e).slice(0, 60) };
  }
}

/**
 * 巡检一个频道(不改数据文件,可发网络请求)。
 * @param channel  "opportunities" | "news" | "jobs"
 * @param records  该频道全部记录数组(调用方读文件传入)
 * @param opts     { today, probe, gate, concurrency, deadStreak, verifiedSafe, maxProbe,
 *                   archiveExpiredDays, newsMaxAgeDays, jobsExpireDays, jobsStaleDays,
 *                   evidenceAudit(fn), evidenceSample }
 * @returns 结构化发现(见 report 结构),含 mutations(按 id 的就地字段更新,调用方持久化)。
 */
export async function inspectChannel(channel, records, opts = {}) {
  const meta = CH_META[channel];
  if (!meta) throw new Error("unknown channel: " + channel);
  const today = opts.today || todayISO();
  const doProbe = opts.probe !== false;
  const deadStreak = opts.deadStreak || 3;
  const archiveExpiredDays = opts.archiveExpiredDays == null ? 365 : opts.archiveExpiredDays;
  const newsMaxAgeDays = opts.newsMaxAgeDays || 730;
  const jobsExpireDays = opts.jobsExpireDays || 60;
  const jobsStaleDays = opts.jobsStaleDays || 120;
  const verifiedSafe = opts.verifiedSafe !== false;   // 人工核实(verified)条目默认免于自动归档/判重淘汰
  const evidenceAudit = (meta.kind === "opp" && typeof opts.evidenceAudit === "function") ? opts.evidenceAudit : null;
  const evidenceSample = opts.evidenceSample == null ? 6 : opts.evidenceSample;

  const report = {
    channel, checked: records.length, probed: 0,
    deadCandidates: [], revived: [], newlyExpired: [],
    duplicates: [], archiveCandidates: [], evidenceFlags: [], evidenceAudited: 0,
    mutations: {}   // id -> { status?, _fail_streak?, last_seen?, updated_at?, _ev_audit? }
  };
  const mut = (id, patch) => { report.mutations[id] = Object.assign(report.mutations[id] || {}, patch); };
  const seenArchive = new Set();
  const pushArchive = (o, reason, extra) => {
    if (seenArchive.has(o.id)) return;
    if (verifiedSafe && o.trust === "verified") return;   // 人工核实过的绝不自动归档
    seenArchive.add(o.id);
    report.archiveCandidates.push(Object.assign({ id: o.id, title: o.title_zh || o.title || o.id, reason }, extra || {}));
  };

  // —— ② 过期(机会):deadline 已过且仍标 open → 建议置 expired(纯日期,无网络)——
  if (meta.kind === "opp") {
    for (const o of records) {
      if (o.deadline && isParseableDate(o.deadline) && o.deadline < today && o.status === "open") {
        report.newlyExpired.push({ id: o.id, deadline: o.deadline });
        mut(o.id, { status: "expired", updated_at: today });
      }
    }
  }

  // —— ③ 重复条目:同指纹聚簇,保留最全者,其余建议归档 ——
  {
    const byFp = new Map();
    for (const o of records) {
      const k = meta.kind === "opp"
        ? fingerprint(o)
        : (String(o.title_zh || o.title || "").toLowerCase().replace(/\s+/g, "") + "|" + (o[meta.urlField] || ""));
      if (!k || /^\|+$/.test(k)) continue;
      if (!byFp.has(k)) byFp.set(k, []);
      byFp.get(k).push(o);
    }
    for (const [k, group] of byFp) {
      if (group.length < 2) continue;
      const score = meta.kind === "opp" ? completeness : (o => Object.values(o).filter(v => v != null && v !== "").length);
      const keep = group.slice().sort((a, b) => score(b) - score(a))[0];
      const drop = group.filter(o => o !== keep);
      report.duplicates.push({ fp: k.slice(0, 24), keep: keep.id, drop: drop.map(o => o.id) });
      for (const o of drop) pushArchive(o, "duplicate", { of: keep.id });
    }
  }

  // —— 过期归档候选(招聘/资讯按既有裁剪规则;机会长期过期)——
  for (const o of records) {
    if (meta.kind === "opp") {
      if (o.deadline && isParseableDate(o.deadline) && o.deadline < today) {
        const stale = daysBetween(today, o.deadline);
        if (stale != null && stale > archiveExpiredDays) pushArchive(o, "long-expired", { deadline: o.deadline, daysStale: stale });
      }
    } else if (meta.kind === "jobs") {
      if (o.deadline && isParseableDate(o.deadline)) {
        const past = daysBetween(today, o.deadline);
        if (past != null && past > jobsExpireDays) pushArchive(o, "job-expired", { deadline: o.deadline, daysStale: past });
      } else {
        const added = firstDate(o, ["added_at", "posted_at", "updated_at", "verified_at"]);
        const age = added ? daysBetween(today, added) : null;
        if (age != null && age > jobsStaleDays) pushArchive(o, "job-stale", { since: added, daysStale: age });
      }
    } else if (meta.kind === "news") {
      const pub = firstDate(o, ["published_at", "added_at", "updated_at"]);
      const age = pub ? daysBetween(today, pub) : null;
      if (age != null && age > newsMaxAgeDays) pushArchive(o, "news-too-old", { published_at: pub, daysStale: age });
    }
  }

  // 存证抽查样本:活机会里挑"最久没抽查过"的前 N 条(_ev_audit 空/最旧优先),天然轮换、成本可控。
  const evSample = new Set();
  if (evidenceAudit && evidenceSample > 0) {
    records.filter(o => o[meta.urlField] && o.status !== "dead")
      .sort((a, b) => String(a._ev_audit || "").localeCompare(String(b._ev_audit || "")))
      .slice(0, evidenceSample)
      .forEach(o => evSample.add(o.id));
  }

  // —— ① 死链探测 + ④ 存证抽查(共用一次抓取)——
  if (doProbe) {
    let pool = records.filter(o => o[meta.urlField]);
    if (opts.maxProbe && pool.length > opts.maxProbe) pool = pool.slice(0, opts.maxProbe);  // 可选每轮上限
    await mapLimit(pool, opts.concurrency || 4, opts.gate, async (o) => {
      const url = o[meta.urlField];
      const pr = await probe(url);
      report.probed++;
      if (pr.verdict === "unknown") return;          // 说不清:不动 streak
      if (pr.verdict === "dead") {
        const streak = (o._fail_streak || 0) + 1;
        mut(o.id, { _fail_streak: streak });
        if (streak >= deadStreak && o.status !== "dead") {
          report.deadCandidates.push({ id: o.id, url, streak, reason: pr.reason, title: o.title_zh || o.title || o.id });
          if (meta.kind === "opp") mut(o.id, { status: "dead", updated_at: today });   // 机会有 status → 隐藏;频道无 status → 仅标记
        }
        return;
      }
      // alive:清零 streak、更新 last_seen;若之前判 dead 且机会 → 复活(按 deadline 回 open/expired)
      const patch = { _fail_streak: 0, last_seen: today };
      if (meta.kind === "opp" && o.status === "dead") {
        patch.status = (o.deadline && isParseableDate(o.deadline) && o.deadline < today) ? "expired" : "open";
        patch.updated_at = today;
        report.revived.push({ id: o.id });
      }
      mut(o.id, patch);
      // ④ 存证抽查(仅样本内、活着、原文够长):重抓原文已在手,直接交注入的 evidenceAudit 复核
      if (evidenceAudit && evSample.has(o.id) && pr.text && pr.text.length > 200) {
        report.evidenceAudited++;
        mut(o.id, { _ev_audit: today });             // 抽查过就打时间戳,轮换到下一批
        try {
          const flag = await evidenceAudit(o, pr.text, { url, domain: hostOf(url), finalUrl: pr.finalUrl });
          if (flag && flag.reason) report.evidenceFlags.push({ id: o.id, url, title: o.title_zh || o.title || o.id, reason: flag.reason });
        } catch (e) { /* 抽查失败不误报 */ }
      }
    });
  }

  return report;
}
