// channels.mjs —— 资讯(news)/招聘(jobs)频道的检索与入库逻辑,与机会频道**完全同规格**:
//   AI 理解需求 → 全网搜索 → 抓原文 → DeepSeek 提取(带逐字 evidence)→ 程序子串校验
//   → 地点相关性过滤 → 写库(串行锁)。绝不编造,找不到就是找不到。
//
// 被两处复用:
//   · server.mjs 的 /api/search?channel=news|jobs(用户触发检索)
//   · run-channels.mjs(每日自动抓取信源)
//
// 反幻觉红线与机会频道一致:evidence 必须是原文子串(verify.mjs 同一套函数),
// 标题 evidence 不过整条丢弃;日期/薪资等字段 evidence 不过则该字段作废置 null。

import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { evidenceInSource, isParseableDate } from "./verify.mjs";
import { llmExtract, extractGlmFree, MAX_INPUT_CHARS } from "./extract.mjs";
import { extractCover, looksGeneric } from "./cover.mjs";
import { fetchSource } from "./fetch.mjs";
import { searchWeb, BLOCK, unsafeHost } from "./websearch.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SITE_DATA = join(__dir, "..", "..", "site", "data");

function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function slug(s) { return String(s).toLowerCase().replace(/[^\w一-龥]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item"; }
// 与种子数据同风格的 6 位 base36 短哈希(按 URL 定,保证同一页面不重复入库)
function hash6(s) {
  const hex = createHash("sha1").update(String(s), "utf8").digest("hex");
  return parseInt(hex.slice(0, 10), 16).toString(36).slice(0, 6).padStart(6, "0");
}
const str = v => (typeof v === "string" && v.trim()) ? v.trim() : null;
function daysAgo(iso) {
  const t = Date.parse(iso + "T00:00:00");
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

// 从 URL 路径提取日期(许多新闻站 URL 自带发布日期,如 /20181023/n857192.html、/2026-07/15/)。
// 这是程序对确定性结构的解析,不是 AI 推测;用于:①原文提不到日期时兜底 ②拦掉陈年旧文。
// 严格边界(评审修正):必须年月日齐全才算(绝不默认补日=编造);未来日期不采信(展期/预告页的
// 路径日期不是发布日),返回 null。
export function urlDateISO(u) {
  const s = String(u);
  const mk = (y, mo, d) => {
    const iso = y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    if (!isParseableDate(iso)) return null;
    if (iso > todayISO()) return null;        // 未来日期:不是发布日,拒绝
    return iso;
  };
  let m = /\/(20\d{2})(\d{2})(\d{2})\//.exec(s);                       // /20260715/
  if (m) return mk(m[1], m[2], m[3]);
  m = /\/(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})\//.exec(s);             // /2026/07/15/ 或 /2026-07/15/
  if (m) return mk(m[1], m[2], m[3]);
  return null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// —— 频道提取 prompt(懒加载)——
const PROMPTS = new Map();
async function getChannelPrompt(file) {
  if (!PROMPTS.has(file)) PROMPTS.set(file, await readFile(join(__dir, "..", "prompts", file), "utf8"));
  return PROMPTS.get(file);
}

// ---------------------------------------------------------------------------
// 校验(纯程序,不用 AI)—— 与 verify.mjs 的机会校验同一支点:evidence 子串比对。
// 多智能体评审补强:不只验"证据在原文里",还验"字段值与证据一致"——
//   · 值级子串:prompt 要求"逐字/照抄"的字段(title/org/salary/city/country/source),
//     值本身也必须是原文子串,否则作废;标题不过整条丢弃。编造值配真证据过不了这道闸。
//   · 日期一致性:归一化的 YYYY-MM-DD 无法直接子串比对,改验 evidence 里出现同样的日/月
//     (含英文月名),且 evidence 若含 4 位年份则必须相同(不含年份=允许按原文推断年)。
// ---------------------------------------------------------------------------

const MON_EN = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function dateMatchesEvidence(iso, evidence) {
  if (!evidence) return false;
  const ev = String(evidence);
  const [y, mo, d] = String(iso).split("-").map(Number);
  if (ev.includes(iso) || ev.includes(String(iso).replace(/-/g, ""))) return true;
  const nums = (ev.match(/\d+/g) || []).map(Number);
  const dayOk = nums.includes(d);
  const monthOk = nums.includes(mo) || new RegExp("\\b" + MON_EN[mo - 1].slice(0, 3), "i").test(ev);
  const years = nums.filter(n => n >= 2000 && n <= 2099);
  const yearOk = years.length === 0 || years.includes(y);
  return dayOk && monthOk && yearOk;
}
// 值级校验:字段值本身必须在原文逐字出现,不过则作废置 null(标题除外,由调用方整条丢弃)
function nullifyNonVerbatim(rec, fields, ctx, nulled) {
  for (const f of fields) {
    if (str(rec[f]) && !evidenceInSource(rec[f], ctx.sourceText)) {
      nulled.push({ field: f, evidence: "(值本身不在原文)", value: rec[f] });
      rec[f] = null;
    }
  }
}

// 资讯:标题(值+证据)不过 → 整条丢弃;发布日期 证据/一致性 不过 → 置 null;过旧的不收。
function verifyNews(data, ctx) {
  const nulled = [];
  if (data.applicable === false) return { dropped: true, dropReason: "not-applicable:" + (data.reason || ""), nulled };
  const rec = JSON.parse(JSON.stringify(data));
  if (!str(rec.title)) return { dropped: true, dropReason: "no-title", nulled };
  const ev = rec.evidence || {};
  if (!evidenceInSource(ev.title, ctx.sourceText)) {
    return { dropped: true, dropReason: "title-evidence-fail:" + String(ev.title || "").slice(0, 40), nulled };
  }
  if (!evidenceInSource(rec.title, ctx.sourceText)) {
    return { dropped: true, dropReason: "title-not-verbatim:" + String(rec.title).slice(0, 40), nulled };
  }
  nullifyNonVerbatim(rec, ["source"], ctx, nulled);   // 媒体名值级校验,作废则由域名兜底
  if (rec.published_at != null) {
    if (!isParseableDate(rec.published_at) || !evidenceInSource(ev.published_at, ctx.sourceText) ||
        !dateMatchesEvidence(rec.published_at, ev.published_at)) {
      nulled.push({ field: "published_at", evidence: ev.published_at || "", value: rec.published_at });
      rec.published_at = null;
    }
  }
  // 资讯要"新":发布日期明确超过 maxAgeDays 的旧文不收(避免把陈年旧闻当资讯)
  const age = rec.published_at ? daysAgo(rec.published_at) : null;
  if (age != null && age > CHANNELS.news.maxAgeDays) {
    return { dropped: true, dropReason: "too-old:" + rec.published_at, nulled };
  }
  return { dropped: false, record: rec, nulled };
}

// 招聘:职位名(值+证据)不过 → 整条丢弃;org/salary/city/country 值级校验、
// deadline 证据+日期一致性、employment_type 证据校验(枚举分类,无法逐字)→ 不过则字段作废;
// 截止已过的职位不收(对求职者无用)。
function verifyJobs(data, ctx) {
  const nulled = [];
  if (data.applicable === false) return { dropped: true, dropReason: "not-applicable:" + (data.reason || ""), nulled };
  const rec = JSON.parse(JSON.stringify(data));
  if (!str(rec.title)) return { dropped: true, dropReason: "no-title", nulled };
  const ev = rec.evidence || {};
  if (!evidenceInSource(ev.title, ctx.sourceText)) {
    return { dropped: true, dropReason: "title-evidence-fail:" + String(ev.title || "").slice(0, 40), nulled };
  }
  if (!evidenceInSource(rec.title, ctx.sourceText)) {
    return { dropped: true, dropReason: "title-not-verbatim:" + String(rec.title).slice(0, 40), nulled };
  }
  for (const f of ["org", "salary", "employment_type"]) {
    if (str(rec[f]) && !evidenceInSource(ev[f], ctx.sourceText)) {
      nulled.push({ field: f, evidence: ev[f] || "", value: rec[f] });
      rec[f] = null;
    }
  }
  // 值级校验:org/salary 按 prompt 应照抄原文;city/country 用作地点过滤与事实展示,同样必须在原文出现
  nullifyNonVerbatim(rec, ["org", "salary", "city", "country"], ctx, nulled);
  if (rec.deadline != null) {
    if (!isParseableDate(rec.deadline) || !evidenceInSource(ev.deadline, ctx.sourceText) ||
        !dateMatchesEvidence(rec.deadline, ev.deadline)) {
      nulled.push({ field: "deadline", evidence: ev.deadline || "", value: rec.deadline });
      rec.deadline = null;
    } else if (rec.deadline < todayISO()) {
      return { dropped: true, dropReason: "job-expired:" + rec.deadline, nulled };
    }
  }
  return { dropped: false, record: rec, nulled };
}

// ---------------------------------------------------------------------------
// 成品记录(对齐 news.json / jobs.json 既有种子数据的字段)
// ---------------------------------------------------------------------------

// 程序级清理:剥掉网页 <title> 常见的站点名尾缀段("标题_独家_雅昌新闻"、"Title - Hyperallergic")。
// 只剥"分隔符 + 尾段【整体等于】站名词表项或媒体名/域名"的情况(精确匹配,评审修正:
// 不用 endsWith,避免把"××的新闻"这类正文尾段误删),确定性处理、绝不改标题正文。
const SITE_SUFFIX = new Set(["新闻", "独家", "雅昌", "雅昌新闻", "雅昌艺术网", "艺术中国", "99艺术网", "资讯", "官网", "艺术资讯", "art news"]);
function stripSiteSuffix(t, source, domain) {
  if (!t) return t;
  let s = String(t).trim();
  const eq = (a, b) => a && b && a.trim().toLowerCase() === String(b).trim().toLowerCase();
  for (let guard = 0; guard < 4; guard++) {
    const m = /^(.*?)(?:__|_|\s+[-–—|]\s+)([^_]{1,20})$/.exec(s);
    if (!m || !m[1].trim()) break;
    const tail = m[2].trim();
    if (!SITE_SUFFIX.has(tail.toLowerCase()) && !eq(tail, source) && !eq(tail, domain)) break;
    s = m[1].trim();
  }
  return s || String(t).trim();
}

function finalizeNews(rec, url, host, cover, via) {
  const dom = host.replace(/^www\./, "");
  const src0 = str(rec.source);
  for (const f of ["title", "title_zh", "title_en"]) rec[f] = stripSiteSuffix(str(rec[f]), src0, dom);
  return {
    id: "news-" + hash6(url) + "-" + slug(rec.title_en || rec.title || rec.title_zh),
    title: str(rec.title),
    source: str(rec.source) || dom,
    summary: str(rec.summary_zh),
    url,
    ...(cover ? { cover, cover_source: dom } : {}),
    published_at: rec.published_at || null,
    category: str(rec.category) || "其他",
    domain: dom,
    _via: via,
    title_zh: str(rec.title_zh) || str(rec.title),
    title_en: str(rec.title_en) || str(rec.title),
    summary_zh: str(rec.summary_zh),
    summary_en: str(rec.summary_en) || str(rec.summary_zh),
    added_at: todayISO()
  };
}

function finalizeJobs(rec, url, host, cover, via) {
  const dom = host.replace(/^www\./, "");
  return {
    id: "job-" + hash6(url) + "-" + slug(rec.title_en || rec.title || rec.title_zh),
    title: str(rec.title),
    org: str(rec.org),
    city: str(rec.city), country: str(rec.country),
    employment_type: str(rec.employment_type),
    salary: str(rec.salary),
    deadline: rec.deadline || null,
    summary: str(rec.summary_zh),
    apply_url: url,
    ...(cover ? { cover, cover_source: dom } : {}),
    domain: dom,
    posted_at: null,
    _via: via,
    title_zh: str(rec.title_zh) || str(rec.title),
    title_en: str(rec.title_en) || str(rec.title),
    summary_zh: str(rec.summary_zh),
    summary_en: str(rec.summary_en) || str(rec.summary_zh),
    added_at: todayISO()
  };
}

// ---------------------------------------------------------------------------
// 频道定义
// ---------------------------------------------------------------------------

export const CHANNELS = {
  news: {
    key: "news",
    dataPath: join(SITE_DATA, "news.json"),
    listKey: "items",
    promptFile: "extract-news.txt",
    recentBias: true,        // 搜索偏向最近一年(资讯要新)
    maxAgeDays: 730,         // 超过约两年的旧文不收
    urlOf: o => o.url,
    verify: verifyNews,
    finalize: finalizeNews,
    locFields: ["title", "title_zh", "title_en", "summary_zh", "summary_en", "source"],
    fallbackQueries: q => [q + " 艺术 资讯 报道", q + " 展览 美术馆 新闻", q + " art news"],
    intentSystem: () =>
      "你是艺术资讯检索的意图理解器。用户想找某主题的艺术新闻/资讯/评论/专题文章。" +
      "把用户这句需求拆成结构化检索意图,只输出一个 JSON,不要任何解释。\n" +
      "字段:\n" +
      "  location: 用户明确提到的地点/城市/地区,没提就 null。\n" +
      "  subject: 核心主题(艺术家/展览/事件/领域),没提就 null。\n" +
      "  search_queries: 2-3 条适合直接丢给搜索引擎的精准查询,每条都把主题和资讯类词(新闻/报道/评论/专题)组合好;" +
      "以中文为主,可含 1 条英文;资讯要新,可带上 " + new Date().getFullYear() + " 年份。\n" +
      '例 "威尼斯双年展" -> {"location":null,"subject":"威尼斯双年展","search_queries":["威尼斯双年展 ' + new Date().getFullYear() + ' 报道","威尼斯双年展 中国馆 艺术 新闻","Venice Biennale ' + new Date().getFullYear() + ' news"]}'
  },
  jobs: {
    key: "jobs",
    dataPath: join(SITE_DATA, "jobs.json"),
    listKey: "jobs",
    promptFile: "extract-jobs.txt",
    recentBias: true,        // 招聘同样要新(旧职位早关了)
    maxAgeDays: null,
    urlOf: o => o.apply_url,
    verify: verifyJobs,
    finalize: finalizeJobs,
    locFields: ["title", "title_zh", "title_en", "org", "city", "country", "summary_zh", "summary_en"],
    fallbackQueries: q => [q + " 美术馆 画廊 招聘", q + " 艺术机构 招聘 岗位", q + " art museum gallery jobs hiring"],
    intentSystem: () =>
      "你是艺术行业招聘检索的意图理解器。用户想找艺术相关的工作岗位(美术馆/画廊/艺术机构/艺术媒体/拍卖行/院校等)。" +
      "把用户这句需求拆成结构化检索意图,只输出一个 JSON,不要任何解释。\n" +
      "字段:\n" +
      "  location: 用户明确提到的城市/地区,没提就 null。\n" +
      "  subject: 岗位方向(如 策展、设计、编辑、运营),没提就 null。\n" +
      "  search_queries: 2-3 条精准查询,每条都把地点/方向和机构类型词(美术馆/画廊/艺术机构)+ 招聘词组合好;" +
      "以中文为主,可含 1 条英文(jobs/hiring/careers)。\n" +
      '例 "上海 策展" -> {"location":"上海","subject":"策展","search_queries":["上海 美术馆 画廊 策展 招聘","上海 艺术机构 招聘 策展人","Shanghai gallery curator jobs"]}'
  }
};

// ---------------------------------------------------------------------------
// AI 意图理解(与机会频道 understandQuery 同构,prompt 按频道)
// ---------------------------------------------------------------------------

export async function understandChannelQuery(chKey, userQuery) {
  const sys = CHANNELS[chKey].intentSystem();
  const user = "用户需求:" + userQuery;
  // GLM 免费档为主(意图理解是轻任务,flash 足够,且是长期主力,见 2026-08-02 决策)
  try { const g = await extractGlmFree(sys, user, 400); if (g && g.data) return g.data; } catch (e) {}
  // GLM 不可用时 DeepSeek 兜底
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.EXTRACT_MODEL || "deepseek-chat",
        temperature: 0.2, max_tokens: 400, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    const m = /\{[\s\S]*\}/.exec(raw);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return null; }
}

// 相关性把关:用户明确指定了地点,而这条内容各字段都不含该地点 → 判为跑题丢弃(与机会频道同)。
function matchChannelLocation(ch, rec, loc) {
  if (!loc) return true;
  const hay = ch.locFields.map(f => rec[f] || "").join(" ");
  return hay.indexOf(loc) !== -1;
}

// ---------------------------------------------------------------------------
// 单页处理:抓好的页面 → AI 提取 → 程序校验 → 成品记录(检索与每日管道共用)
// ---------------------------------------------------------------------------

export async function processChannelPage(chKey, page, via) {
  const ch = CHANNELS[chKey];
  const prompt = await getChannelPrompt(ch.promptFile);
  const user = `【信源域名】${page.host || ""}\n【原文如下,只能使用这里的信息】\n\n${String(page.text).slice(0, MAX_INPUT_CHARS)}`;
  const ex = await llmExtract(prompt, user, 2000);
  const v = ch.verify(ex.data, { sourceText: page.text });
  if (v.dropped) return { dropped: true, reason: v.dropReason, usage: ex.usage };
  // 资讯:原文提不到日期时用 URL 自带日期兜底(程序解析,非 AI 推测);超龄旧文一律不收
  if (chKey === "news") {
    if (!v.record.published_at) {
      const ud = urlDateISO(page.url);
      if (ud) v.record.published_at = ud;
    }
    const age = v.record.published_at ? daysAgo(v.record.published_at) : null;
    if (age != null && age > ch.maxAgeDays) return { dropped: true, reason: "too-old:" + v.record.published_at, usage: ex.usage };
  }
  // 封面:页面自带 og:image(真图,热链;前端加载失败自动退回设计海报卡)
  let cover = null;
  if (page.rawHtml) {
    const cv = extractCover(page.rawHtml, page.url);
    if (cv && !looksGeneric(cv, page.host)) cover = cv;
  }
  const rec = ch.finalize(v.record, page.url, page.host, cover, via || "search");
  return { record: rec, nulled: v.nulled, usage: ex.usage };
}

// ---------------------------------------------------------------------------
// 写库:按文件的串行锁(并发检索同时写 news.json 不互相覆盖);临界区内再去一次重。
// ---------------------------------------------------------------------------

const chains = new Map();
export function withFileLock(path, fn) {
  const prev = chains.get(path) || Promise.resolve();
  const p = prev.then(fn, fn);
  chains.set(path, p.then(() => {}, () => {}));
  return p;
}

// 读频道数据。文件不存在(首次)→ 返回空文档;文件存在但读取/解析失败 → 抛错。
// 绝不能把"损坏的库"当成"空库",否则随后的 upsert 会用几条新记录整库覆盖(评审 HIGH)。
export async function readChannelDoc(chKey) {
  const ch = CHANNELS[chKey];
  try { return JSON.parse(await readFile(ch.dataPath, "utf8")); }
  catch (e) {
    if (e && e.code === "ENOENT") {
      const d = { _meta: {}, generated_at: todayISO(), count: 0 };
      d[ch.listKey] = [];
      return d;
    }
    throw new Error("读取 " + chKey + " 数据失败(拒绝以空库继续,防整库覆盖): " + (e.message || e));
  }
}

export function upsertChannelRecords(chKey, records) {
  const ch = CHANNELS[chKey];
  return withFileLock(ch.dataPath, async () => {
    const doc = await readChannelDoc(chKey);
    const list = doc[ch.listKey] || (doc[ch.listKey] = []);
    const ids = new Set(list.map(o => o.id));
    const urls = new Set(list.map(o => ch.urlOf(o)).filter(Boolean));
    const fresh = records.filter(r => !ids.has(r.id) && !urls.has(ch.urlOf(r)));
    if (fresh.length) {
      list.push(...fresh);
      doc.count = list.length;
      doc.generated_at = todayISO();
      // tmp 名带 pid+时间戳:server 与每日管道是两个进程,固定 .tmp 会互相踩(评审 HIGH)
      const tmp = ch.dataPath + ".tmp-" + process.pid + "-" + Date.now();
      await writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
      await rename(tmp, ch.dataPath);
    }
    return fresh;
  });
}

// ---------------------------------------------------------------------------
// 检索闭环(供 /api/search?channel=news|jobs):与机会频道同一套流程与预算
// ---------------------------------------------------------------------------

export async function harvestChannel(chKey, query, target = 6) {
  const ch = CHANNELS[chKey];
  const intent = await understandChannelQuery(chKey, query);
  const loc = intent && intent.location ? String(intent.location).trim() : null;
  process.stderr.write("  [" + chKey + "意图] 地点=" + (loc || "—") + " 主题=" + ((intent && intent.subject) || "—") + "\n");
  const queries = (intent && Array.isArray(intent.search_queries) && intent.search_queries.length)
    ? intent.search_queries.slice(0, 3).map(String)
    : ch.fallbackQueries(query);

  const rawUrls = [];
  for (const q of queries) {
    rawUrls.push(...await searchWeb(q, { recent: ch.recentBias }));
    await sleep(800);   // 对搜索端点客气一点
  }

  // 候选去重 + 过滤噪声;首页不是文章/职位详情,跳过
  const seen = new Set(), cands = [];
  for (const u of rawUrls) {
    let parsed; try { parsed = new URL(u); } catch (e) { continue; }
    if (BLOCK.test(u) || unsafeHost(parsed.host)) continue;
    if (parsed.pathname === "/" || parsed.pathname === "") continue;
    const key = u.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push(key);
  }

  // 现有库(去重基底,不加锁读;写入时锁内还会再去一次重)
  const doc = await readChannelDoc(chKey);
  const list = doc[ch.listKey] || [];
  const existIds = new Set(list.map(o => o.id));
  const existUrls = new Set(list.map(o => ch.urlOf(o)).filter(Boolean));

  const added = [], log = [];
  let probed = 0;
  const MAX_PROBE = 16;
  const t0 = Date.now();
  const BUDGET = 110000;   // 总时间预算:超 110 秒返回已收集的
  for (const url of cands) {
    if (added.length >= target || probed >= MAX_PROBE) break;
    if (Date.now() - t0 > BUDGET) { log.push("time-budget-reached"); break; }
    if (existUrls.has(url)) continue;
    probed++;
    let host; try { host = new URL(url).host; } catch (e) { continue; }
    let f;
    try { f = await fetchSource({ url, domain: host, type: "html" }); }
    catch (e) { log.push("fetch-error " + host); continue; }
    if (f.skipped || !f.text || f.text.length < 200) { log.push("skip " + host + " " + (f.reason || "thin")); continue; }
    let r;
    try { r = await processChannelPage(chKey, { url, host, text: f.text, rawHtml: f.rawHtml }, "search"); }
    catch (e) { log.push("extract-fail " + host); continue; }
    if (r.dropped) { log.push("dropped " + host + " " + String(r.reason).slice(0, 40)); continue; }
    const rec = r.record;
    if (loc && !matchChannelLocation(ch, rec, loc)) { log.push("跑题(不含 " + loc + ") " + host); continue; }
    if (existIds.has(rec.id) || added.find(a => a.id === rec.id)) continue;
    added.push(rec);
    log.push("✓ " + (rec.title_zh || rec.title));
  }

  const saved = added.length ? await upsertChannelRecords(chKey, added) : [];
  return { added: saved, probed, candidates: cands.length, log };
}
