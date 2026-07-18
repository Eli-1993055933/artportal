// weekly.mjs —— AI 艺术周报(路线图第 5 项,v0.65.0)。
//
// 反幻觉红线在周报里的落法:
//   - 周报的【条目】全部来自站内已校验入库的数据(opportunities/news/jobs.json),
//     标题/链接/日期/机构等事实字段由【程序】逐条回填,AI 碰不到、也改不了;
//   - DeepSeek 只做两件事:①从"编号候选清单"里挑选条目(输出编号);②写导语/各节小引
//     (编辑部口吻的过渡文字,提示词明令禁止提及候选之外的任何具体事实);
//   - AI 不可用/输出不合法 → 自动降级为纯程序模板(按规则选条 + 固定导语),周报照样出;
//   - 周报页与邮件都标注"AI 撰写导语·条目以原文为准",绝不冒充人工编辑。
//
// 产物:site/data/weekly/<YYYY-Wnn>.json(单期)+ site/data/weekly/index.json(目录)。
// 周期 id 按【北京时间】ISO 周(如 2026-W29),每周一期,重复生成默认跳过(force 重做)。

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isThirdParty } from "./aggregators.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dir, "..", "..", "site");
const WEEKLY_DIR = join(SITE, "data", "weekly");

// ---------- 北京时间 ISO 周 ----------
function beijingParts() {
  const d = new Date(Date.now() + 8 * 3600e3);   // 用 UTC 取数即得北京当地日期
  return d;
}
export function weekIdOf(d = beijingParts()) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (dt.getUTCDay() + 6) % 7;          // 周一=0
  dt.setUTCDate(dt.getUTCDate() - day + 3);      // 本周四所在年 = ISO 年
  const y = dt.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const week = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return y + "-W" + String(week).padStart(2, "0");
}
function todayISO() { return beijingParts().toISOString().slice(0, 10); }
function daysAgoISO(n) { return new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10); }

// ---------- 选材(纯程序,规则透明) ----------
async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch (e) { return fallback; }
}
// 机会:官网可达(与前端展示闸门同一标准)+ 未截止,近 7 天新增 或 21 天内截止(临近截止提醒)
function collectOpps(doc) {
  const today = todayISO(), since = daysAgoISO(7), soon = daysAgoISO(-21);
  const ok = [];
  for (const o of (doc.opportunities || [])) {
    const official = o.official_url || (o.url && !isThirdParty(o.url) ? o.url : null);
    if (!official) continue;                                   // 前端也不展示的,周报不推
    if (o.deadline && o.deadline < today) continue;            // 已截止不推
    const isNew = (o.updated_at || "") >= since || (o.last_seen || "") >= since;
    const isSoon = o.deadline && o.deadline <= soon;
    if (!isNew && !isSoon) continue;
    ok.push({
      oid: o.id, kind: "opp",
      title: o.title_zh || o.title_en || "",
      org: o.org_zh || "", city: o.city_zh || "", country: o.country_zh || "",
      category: o.category || "", deadline: o.deadline || null,
      summary: String(o.summary_zh || "").slice(0, 120)
    });
  }
  // 截止近的在前(无截止按更新日新在前),候选给 AI 最多 40 条
  ok.sort((a, b) => {
    if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return 0;
  });
  return ok.slice(0, 40);
}
// 资讯:近 10 天发布(拿不到发布日期用入库日),新在前,候选最多 30
function collectNews(doc) {
  const since = daysAgoISO(10);
  const ok = [];
  for (const n of (doc.items || [])) {
    const dt = n.published_at || n.added_at || "";
    if (dt < since) continue;
    ok.push({
      oid: n.id, kind: "news",
      title: n.title_zh || n.title || "",
      source: n.source || n.domain || "",
      published_at: n.published_at || null,
      url: n.url,
      summary: String(n.summary_zh || n.summary || "").slice(0, 120)
    });
  }
  ok.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
  return ok.slice(0, 30);
}
// 招聘:在招(无截止或未过期),近 14 天新增优先,候选最多 30
function collectJobs(doc) {
  const today = todayISO(), since = daysAgoISO(14);
  const fresh = [], open = [];
  for (const j of (doc.jobs || [])) {
    if (j.deadline && /^\d{4}-\d{2}-\d{2}$/.test(j.deadline) && j.deadline < today) continue;
    const item = {
      oid: j.id, kind: "job",
      title: j.title_zh || j.title || "",
      org: j.org_zh || j.org || "", location: j.location_zh || j.location || "",
      deadline: j.deadline || null, url: j.apply_url || j.url
    };
    if ((j.posted_at || j.added_at || "") >= since) fresh.push(item); else open.push(item);
  }
  return fresh.concat(open).slice(0, 30);
}

// ---------- DeepSeek:选条 + 导语(只准引用候选,绝不产出事实字段) ----------
async function composeWithAI(cand, weekId) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const numbered = (arr) => arr.map((x, i) =>
    "[" + i + "] " + x.title +
    (x.org ? "|" + x.org : "") + (x.source ? "|" + x.source : "") +
    (x.deadline ? "|截止" + x.deadline : "") + (x.summary ? "|" + x.summary : "")
  ).join("\n");
  const sys =
    "你是艺术平台 ArtPortal 的周报主编。下面给你三份【编号候选清单】(机会/资讯/招聘,均为平台已核实入库的真实条目)。" +
    "任务:①各清单挑选最值得读者关注的条目(机会≤12、资讯≤10、招聘≤8,不足就全选);②写周报标题、导语(120字内)、各节一句话小引(40字内)、结语(60字内)。\n" +
    "铁律:导语/小引/结语只能概括候选清单里出现过的信息与行业通识语气,【绝对禁止】编造清单之外的任何展览、人名、机构、数字、日期;不要写具体链接。\n" +
    "只输出一个 JSON:{\"title\":\"…\",\"intro\":\"…\",\"opps_note\":\"…\",\"news_note\":\"…\",\"jobs_note\":\"…\",\"outro\":\"…\",\"opps\":[编号],\"news\":[编号],\"jobs\":[编号]}";
  const user =
    "本期:" + weekId + "\n\n【机会候选】\n" + (numbered(cand.opps) || "(空)") +
    "\n\n【资讯候选】\n" + (numbered(cand.news) || "(空)") +
    "\n\n【招聘候选】\n" + (numbered(cand.jobs) || "(空)");
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.EXTRACT_MODEL || "deepseek-chat",
        temperature: 0.5, max_tokens: 1200, response_format: { type: "json_object" },
        messages: [{ role: "system", content: sys }, { role: "user", content: user }]
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return null;
    const out = JSON.parse(m[0]);
    // 选条只认合法编号;文本字段限长防跑飞
    const picks = (arr, pool, cap) => {
      const seen = new Set(), r = [];
      for (const n of (Array.isArray(arr) ? arr : [])) {
        const i = Number(n);
        if (Number.isInteger(i) && i >= 0 && i < pool.length && !seen.has(i)) { seen.add(i); r.push(pool[i]); }
        if (r.length >= cap) break;
      }
      return r;
    };
    const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
    return {
      title: s(out.title, 40), intro: s(out.intro, 300),
      opps_note: s(out.opps_note, 80), news_note: s(out.news_note, 80), jobs_note: s(out.jobs_note, 80),
      outro: s(out.outro, 150),
      opps: picks(out.opps, cand.opps, 12), news: picks(out.news, cand.news, 10), jobs: picks(out.jobs, cand.jobs, 8)
    };
  } catch (e) { return null; }
}

// AI 不可用时的纯程序降级:按规则取前 N,固定文案(如实、不装 AI)
function composeFallback(cand, weekId) {
  return {
    title: "ArtPortal 艺术周报 " + weekId,
    intro: "本周站内新收录与临近截止的真实艺术机会、资讯与招聘精选如下,均来自已核实的原始来源。",
    opps_note: "以下机会按截止日期由近到远排列。", news_note: "本周值得一读的艺术资讯。", jobs_note: "在招的艺术相关岗位。",
    outro: "以上条目均可在 ArtPortal 站内查看详情;申请与事实信息请以官网原文为准。",
    opps: cand.opps.slice(0, 12), news: cand.news.slice(0, 10), jobs: cand.jobs.slice(0, 8)
  };
}

// ---------- 生成 + 归档 ----------
async function atomicWrite(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file);
}
export async function readWeeklyIndex() {
  return readJson(join(WEEKLY_DIR, "index.json"), { list: [] });
}
export async function readWeekly(id) {
  if (!/^\d{4}-W\d{2}$/.test(id)) return null;
  return readJson(join(WEEKLY_DIR, id + ".json"), null);
}
export async function generateWeekly({ force = false } = {}) {
  const weekId = weekIdOf();
  const file = join(WEEKLY_DIR, weekId + ".json");
  if (!force) {
    const exist = await readJson(file, null);
    if (exist) return { report: exist, existed: true };
  }
  const [oppDoc, newsDoc, jobsDoc] = await Promise.all([
    readJson(join(SITE, "data", "opportunities.json"), { opportunities: [] }),
    readJson(join(SITE, "data", "news.json"), { items: [] }),
    readJson(join(SITE, "data", "jobs.json"), { jobs: [] })
  ]);
  const cand = { opps: collectOpps(oppDoc), news: collectNews(newsDoc), jobs: collectJobs(jobsDoc) };
  let c = await composeWithAI(cand, weekId);
  const ai = !!c;
  if (!c) c = composeFallback(cand, weekId);
  // 空刊保护:三节全空(数据长期没更新)就不出刊
  if (!c.opps.length && !c.news.length && !c.jobs.length) {
    return { report: null, empty: true };
  }
  const report = {
    id: weekId,
    title: c.title || ("ArtPortal 艺术周报 " + weekId),
    date: todayISO(),
    intro: c.intro,
    outro: c.outro,
    ai_composed: ai,          // true=AI 撰写导语与编排;false=程序模板
    sections: [
      { key: "opps", heading: "本周机会精选", note: c.opps_note, items: c.opps },
      { key: "news", heading: "艺术资讯", note: c.news_note, items: c.news },
      { key: "jobs", heading: "招聘速递", note: c.jobs_note, items: c.jobs }
    ].filter(s => s.items.length),
    generated_at: new Date().toISOString()
  };
  await mkdir(WEEKLY_DIR, { recursive: true });
  await atomicWrite(file, report);
  // 目录:一行一期(新在前),供前端资讯频道横条与归档列表用
  const idx = await readWeeklyIndex();
  const list = (idx.list || []).filter(x => x.id !== weekId);
  list.unshift({ id: weekId, title: report.title, date: report.date, counts: report.sections.map(s => s.items.length) });
  list.sort((a, b) => b.id.localeCompare(a.id));
  await atomicWrite(join(WEEKLY_DIR, "index.json"), { list: list.slice(0, 120) });
  return { report, existed: false };
}

// ---------- 邮件渲染(HTML 内联样式,兼容主流客户端;附纯文本版) ----------
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function itemLink(it, siteUrl) {
  // 机会 → 站内详情深链(前端已保证直达官网);资讯/招聘 → 原文/申请页
  if (it.kind === "opp") return siteUrl + "/#/o/" + encodeURIComponent(it.oid);
  return it.url || siteUrl;
}
function itemMeta(it) {
  const bits = [];
  if (it.kind === "opp") {
    if (it.org) bits.push(it.org);
    if (it.city || it.country) bits.push([it.city, it.country].filter(Boolean).join(" "));
    if (it.deadline) bits.push("截止 " + it.deadline);
  } else if (it.kind === "news") {
    if (it.source) bits.push(it.source);
    if (it.published_at) bits.push(it.published_at);
  } else {
    if (it.org) bits.push(it.org);
    if (it.location) bits.push(it.location);
    if (it.deadline) bits.push("截止 " + it.deadline);
  }
  return bits.join(" · ");
}
export function renderEmailHtml(report, { siteUrl, unsubUrl }) {
  const sec = (s) =>
    '<h2 style="font-size:16px;margin:26px 0 4px;color:#1b1a18">' + esc(s.heading) + "</h2>" +
    (s.note ? '<p style="font-size:13px;color:#6b6660;margin:0 0 10px">' + esc(s.note) + "</p>" : "") +
    s.items.map(it =>
      '<div style="margin:0 0 12px;padding:10px 12px;border:1px solid #e8e4dc;border-radius:8px">' +
        '<a href="' + esc(itemLink(it, siteUrl)) + '" style="font-size:14px;font-weight:600;color:#1b1a18;text-decoration:none">' + esc(it.title) + "</a>" +
        (itemMeta(it) ? '<div style="font-size:12px;color:#8a847c;margin-top:3px">' + esc(itemMeta(it)) + "</div>" : "") +
      "</div>"
    ).join("");
  return (
    '<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;background:#f7f6f2;color:#1b1a18">' +
      '<div style="font-size:12px;letter-spacing:.14em;color:#8a847c">ARTPORTAL</div>' +
      '<h1 style="font-size:20px;margin:8px 0 2px">' + esc(report.title) + "</h1>" +
      '<div style="font-size:12px;color:#8a847c">' + esc(report.date) + (report.ai_composed ? " · AI 撰写导语与编排,条目事实以原文为准" : "") + "</div>" +
      (report.intro ? '<p style="font-size:14px;line-height:1.7;margin:14px 0 0">' + esc(report.intro) + "</p>" : "") +
      report.sections.map(sec).join("") +
      (report.outro ? '<p style="font-size:13px;color:#6b6660;line-height:1.7;margin:22px 0 0">' + esc(report.outro) + "</p>" : "") +
      '<hr style="border:none;border-top:1px solid #e8e4dc;margin:24px 0 12px" />' +
      '<p style="font-size:11px;color:#8a847c;line-height:1.7">你收到本邮件是因为在 ArtPortal 注册时勾选了订阅周报。' +
        '<a href="' + esc(unsubUrl) + '" style="color:#8a847c">退订</a> · ' +
        '<a href="' + esc(siteUrl) + '" style="color:#8a847c">访问 ArtPortal</a></p>' +
    "</div>"
  );
}
export function renderEmailText(report, { siteUrl, unsubUrl }) {
  const lines = [report.title, report.date + (report.ai_composed ? " · AI 撰写导语与编排,条目事实以原文为准" : ""), ""];
  if (report.intro) lines.push(report.intro, "");
  for (const s of report.sections) {
    lines.push("== " + s.heading + " ==");
    if (s.note) lines.push(s.note);
    for (const it of s.items) {
      lines.push("· " + it.title + (itemMeta(it) ? "(" + itemMeta(it) + ")" : ""));
      lines.push("  " + itemLink(it, siteUrl));
    }
    lines.push("");
  }
  if (report.outro) lines.push(report.outro, "");
  lines.push("退订:" + unsubUrl);
  return lines.join("\n");
}
