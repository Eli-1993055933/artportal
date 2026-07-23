// leads.mjs —— 自动化发现(路线图第 6 项,合规可行版,v0.82.0):社媒线索 → 官网收录。
//
// 把小红书/微博等社媒当【发现线索】,不当内容源:
//   1. 只读搜索引擎公开索引里的帖子【标题+摘要】(searchWebRich 结构上不返回链接,
//      下游拿不到 URL 就不可能去抓社媒页面/存社媒外链——红线 2「绝不抓微信/小红书/抖音」不破);
//   2. DeepSeek 从标题/摘要里提炼「机会身份」(机会名称+主办方),名称必须是原文子串,
//      提炼不出就空手而归,绝不硬编;
//   3. 每条线索走既有 searchAndHarvest 官网检索管线(由 server.mjs 注入):
//      定位主办方官网 → 抓官网原文 → 提取 + 逐字 evidence 程序校验 → 才入库,
//      与用户手动 AI 检索完全同一条反幻觉管线,来源标注同样是「AI 检索收录·请核对」;
//   4. 线索指纹与历史/在库标题去重,state/leads.json 留痕可审计。
//
// 预算观:每天 1 次线索搜索 + 每条线索 1 轮官网检索;serper 余量不足由 server 侧直接休勘。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchWebRich } from "./websearch.mjs";
import { llmExtract, extractGlmFree } from "./extract.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dir, "..", "state", "leads.json");
const OPP_PATH = join(__dir, "..", "..", "site", "data", "opportunities.json");

// 线索查询词轮转:瞄准「正在传播中的征集公告」——用 报名/截止/公众号 等传播词 + 最近一个月,
// 捞出社媒/媒体/机构页上正在扩散的机会线索(serper 免费档禁 site: 语法,实测传播词效果反而更好:
// 一把就捞出深圳光影艺术季征集、华语纪录电影征集、Instagram 上的歌德学院群展招募等)。
// 无论线索出自哪个平台,都只读索引层标题/摘要,收录一律走官网管线。
const CLUE_QUERIES = [
  '青年艺术家 征集 报名 截止',
  '艺术家驻留 招募 申请 公众号',
  '双年展 公开征集 投稿',
  '艺术 驻地计划 招募 截止',
  '美术馆 展览 征集 通知 报名',
  '艺术奖 申报 启动 青年',
];

function readState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch (e) { return { qIdx: 0, clues: {}, log: [] }; }
}
function writeState(st) {
  try {
    mkdirSync(join(__dir, "..", "state"), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(st, null, 2), "utf8");
  } catch (e) {}
}
function fpOf(name) { return String(name).toLowerCase().replace(/[\s《》「」【】''""·・\-—()()]/g, ""); }

// 库内已有同名机会?(标题包含线索名即视为已收录,宁保守勿重复检索烧预算)
function libHas(name) {
  try {
    const doc = JSON.parse(readFileSync(OPP_PATH, "utf8"));
    const arr = doc.items || doc.opportunities || [];
    const n = fpOf(name);
    if (n.length < 4) return true;   // 名字太短没有辨识度,当已存在处理(跳过)
    return arr.some(o => fpOf((o.title_zh || "") + (o.title_en || "")).includes(n));
  } catch (e) { return false; }
}

// 线索提炼(轻任务,免费 GLM 为主、DeepSeek 兜底,v0.83.1):
// 只允许从给定标题/摘要文本里抄机会名与主办方,提炼不出返回空数组。
async function distillClues(rows) {
  if (!rows.length) return [];
  const text = rows.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? " —— " + r.snippet : ""}`).join("\n");
  const sys =
    "下面是社交媒体上关于艺术机会的帖子标题与摘要(搜索引擎索引,可能混有广告/个人日常/培训班营销)。\n" +
    "请从中提炼出【明确可辨识的真实艺术机会】(展览征集/驻留/奖项/工作坊),每条给出:\n" +
    "  name: 机会名称(必须直接出现在标题或摘要文本中,原样照抄,不许改写扩写)\n" +
    "  org: 主办方名称(同样必须出现在文本中;看不出来就填空字符串)\n" +
    "规则:辨识不出明确机会名的一律不要;广告、艺考培训、代报名、个人感想一律不要;拿不准就不要。\n" +
    '只输出 JSON:{"clues":[{"name":"...","org":"..."}]}';
  let out = null;
  if (process.env.MOD_API_KEY) {
    try { out = (await extractGlmFree(sys, text, 800)).data; } catch (e) {}
  }
  if (!out) out = (await llmExtract(sys, text, 800)).data;
  const src = rows.map(r => (r.title + " " + r.snippet)).join("\n");
  return (Array.isArray(out.clues) ? out.clues : [])
    .map(c => ({ name: String(c.name || "").trim().slice(0, 60), org: String(c.org || "").trim().slice(0, 40) }))
    // 反幻觉:名称必须真的出现在原始标题/摘要里(子串校验),AI 编的直接丢
    .filter(c => c.name.length >= 4 && src.includes(c.name));
}

// 一天一勘:线索搜索 → 提炼 → 去重 → 逐条走官网检索管线(harvest 由 server 注入)。
// 返回 { query, rows, distilled, tried, added, clueNames } 供打卡与日志。
export async function leadsTick({ harvest, cap }) {
  const st = readState();
  const q = CLUE_QUERIES[st.qIdx % CLUE_QUERIES.length];
  st.qIdx = (st.qIdx + 1) % CLUE_QUERIES.length;
  const maxClues = Math.max(1, Number(cap || process.env.DISCOVER_CAP || 2));

  const rows = await searchWebRich(q, { recent: true });
  const summary = { query: q, rows: rows.length, distilled: 0, tried: 0, added: 0, clueNames: [] };
  if (!rows.length) { writeState(st); return summary; }

  const clues = await distillClues(rows);
  summary.distilled = clues.length;

  const fresh = [];
  for (const c of clues) {
    const fp = fpOf(c.name);
    if (st.clues[fp]) continue;          // 历史线索去重(试过就不再试,无论成败)
    if (libHas(c.name)) {                // 库里已有 → 记档但不烧检索
      st.clues[fp] = { name: c.name, org: c.org, at: new Date().toISOString(), result: "already-in-lib" };
      continue;
    }
    fresh.push(c);
    if (fresh.length >= maxClues) break;
  }

  for (const c of fresh) {
    const query = (c.org ? c.org + " " : "") + c.name;
    let added = 0;
    try {
      const r = await harvest(query, 4);   // 既有反幻觉管线:官网定位+evidence 校验,入库标「AI 检索」
      added = (r && r.added && r.added.length) || 0;
    } catch (e) { /* 单条失败不拖垮整轮 */ }
    st.clues[fpOf(c.name)] = { name: c.name, org: c.org, at: new Date().toISOString(), result: added ? ("added:" + added) : "no-verified-source" };
    summary.tried++; summary.added += added; summary.clueNames.push(c.name + (added ? "✓" : "✗"));
  }

  st.log = (st.log || []).slice(-59);
  st.log.push({ at: new Date().toISOString(), ...summary });
  writeState(st);
  return summary;
}
