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
import { extractGlmFree } from "./extract.mjs";

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
      title_en: o.title_en || null,
      org: o.org_zh || "", city: o.city_zh || "", country: o.country_zh || "",
      org_en: o.org_en || null, city_en: o.city_en || null, country_en: o.country_en || null,
      category: o.category || "", deadline: o.deadline || null,
      summary: String(o.summary_zh || "").slice(0, 160),
      cover: o.cover || null
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
    const src = n.source || n.domain || "";
    // 国内/国际判定(周刊"中外对照"用):国内媒体名单 or 原文标题即中文
    const cn = /雅昌|艺术中国|99艺术|中国美术|凤凰艺术/.test(src) || /[一-鿿]/.test(String(n.title || ""));
    ok.push({
      oid: n.id, kind: "news",
      title: n.title_zh || n.title || "",
      title_en: n.title_en || (!/[一-鿿]/.test(String(n.title||"")) ? n.title : null),
      source: src, region: cn ? "国内" : "国际",
      published_at: n.published_at || null,
      url: n.url,
      summary: String(n.summary_zh || n.summary || "").slice(0, 160),
      cover: n.cover || null
    });
  }
  ok.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
  // 交替取,保证国际顶级媒体(Hyperallergic/Artforum/Artnet/The Art Newspaper/ARTnews 等)资讯
  // 始终有代表——用户要求周刊纳入"顶级艺术周刊的最新资讯",且撰稿铁律需要中外对照材料。
  const intl = ok.filter(x => x.region === "国际"), dom = ok.filter(x => x.region === "国内");
  const merged = []; let i = 0, j = 0;
  while (merged.length < 30 && (i < intl.length || j < dom.length)) {
    if (i < intl.length) merged.push(intl[i++]);              // 每轮先放一条国际,防国内近期新闻扎堆挤掉国际
    if (j < dom.length && merged.length < 30) merged.push(dom[j++]);
  }
  return merged;
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
      title_en: j.title_en || (!/[一-鿿]/.test(String(j.title||"")) ? j.title : null),
      // 修:招聘数据的地点在 city/country 字段(原先取不存在的 location,招聘 meta 一直缺地点)
      org: j.org_zh || j.org || "", location: [j.city, j.country].filter(Boolean).join(" "),
      deadline: j.deadline || null, url: j.apply_url || j.url,
      summary: String(j.summary_zh || j.summary || "").slice(0, 100),
      cover: j.cover || null
    };
    if ((j.posted_at || j.added_at || "") >= since) fresh.push(item); else open.push(item);
  }
  return fresh.concat(open).slice(0, 30);
}

// ---------- 撰稿 agent(v0.70.0):文章型周刊 ----------
// 定位:专业撰稿人水准的编辑部文章(对标 NYT 艺术版 / e-flux criticism 的行文),
// 不是链接清单。反幻觉的落法:
//   - AI 只能引用【编号候选清单】里的条目;正文提及项目必须用 [[编号:显示文字]] 标记,
//     程序逐个校验编号合法性并回填真实链接(机会→站内详情深链,资讯/招聘→原文),
//     非法标记剥壳保文字——AI 写不出一个假链接;
//   - 配图只能选候选自带封面(image: 编号),图与图注由程序回填;
//   - 允许【转述】当代艺术理论观点组织论述,但铁律禁止编造直接引语/页码/出版细节;
//   - 全文如实标注"AI 撰写·条目事实以原文为准";生成后程序校验(结构/引用数),不达标重试一次,
//     再不行退回清单式保底出刊(绝不因为追求文采而停刊或编造)。
const REF_RE = /\[\[(\d+)[::]([^\]]{1,60})\]\]/g;
// 中文媒体/机构名 → 通行英文名(仅收录确知的权威对应,绝不臆造;表外用启发式:
// 名称含拉丁品牌词时取拉丁部分,如 "Tate 泰特英国美术馆"→"Tate";纯中文且无对应则保留原文——专有名词不硬译)
const SOURCE_EN = {
  "雅昌新闻": "Artron News", "雅昌艺术网": "Artron News", "艺术中国": "Art China", "99艺术网": "99ys.com",
  "中国美术馆": "National Art Museum of China", "中央美术学院": "Central Academy of Fine Arts (CAFA)",
  "清华大学美术学院": "Tsinghua University Academy of Arts & Design",
  "UCCA尤伦斯当代艺术中心": "UCCA Center for Contemporary Art",
  "澎湃新闻·艺术评论": "The Paper · Art Review", "新华网": "Xinhua", "中国新闻网": "China News Service",
  "新京报": "The Beijing News", "香港01": "HK01", "联合早报网": "Lianhe Zaobao",
  "艺术论坛 Artforum(中文版)": "Artforum China", "Artforum(艺术论坛)": "Artforum",
  "中国日报网": "China Daily", "BBC News 中文": "BBC News Chinese", "上观新闻": "Shanghai Observer",
  "江西日报": "Jiangxi Daily", "中国国家博物馆": "National Museum of China",
  "香港故宮文化博物館": "Hong Kong Palace Museum", "國立臺灣美術館": "National Taiwan Museum of Fine Arts",
  "臺南市美術館": "Tainan Art Museum", "大地藝術祭": "Echigo-Tsumari Art Triennale",
  "世界新闻网": "World Journal", "欧洲时报网": "Nouvelles d'Europe", "報導者 The Reporter": "The Reporter",
  "艺术新闻/The Art Journal": "The Art Journal", "The Art Newspaper(艺术新闻报)": "The Art Newspaper",
  "纽约市博物馆": "Museum of the City of New York", "北京市文物局": "Beijing Municipal Cultural Heritage Bureau",
  "国际艺术新闻网": "International Art News", "景德镇陶瓷大学官方网站": "Jingdezhen Ceramic University",
  "当代唐人艺术中心": "Tang Contemporary Art", "空白空间 WHITE SPACE": "WHITE SPACE", "藝術家雜誌社": "Artist Magazine"
};
function enName(s) {
  s = String(s || "").trim();
  if (!s || !/[一-鿿]/.test(s)) return s;                    // 本就是英文
  if (SOURCE_EN[s]) return SOURCE_EN[s];
  const noParen = s.replace(/[((][^))]*[))]/g, "").trim();  // 去中文括号注释:The Art Newspaper(艺术新闻报)
  if (noParen && !/[一-鿿]/.test(noParen)) return noParen;
  const latin = s.split(/\s+/).filter(t => /^[\x20-\x7E’&.·-]+$/.test(t) && /[A-Za-z]/.test(t)).join(" ");
  if (latin.length >= 3) return latin;                        // "Tate 泰特英国美术馆" → "Tate"
  return s;                                                   // 纯中文专有名词:保留原文,不硬译
}
function candLine(c, i) {
  const bits = [c.title];
  if (c.kind === "opp") {
    if (c.org) bits.push(c.org);
    const place = [c.city, c.country].filter(Boolean).join(" ");
    if (place) bits.push(place);
    if (c.deadline) bits.push("截止" + c.deadline);
  } else if (c.kind === "news") {
    if (c.region) bits.push("【" + c.region + "】");
    if (c.source) bits.push("来源:" + c.source);
    if (c.published_at) bits.push(c.published_at);
  } else {
    if (c.org) bits.push(c.org);
    if (c.location) bits.push(c.location);
    if (c.deadline) bits.push("截止" + c.deadline);
  }
  if (c.summary) bits.push(c.summary);
  if (c.cover) bits.push("[有配图]");
  return "[" + i + "] " + bits.join(" | ");
}
async function composeArticleAI(cand, weekId) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  // 全局连续编号的候选表(三段展示,编号不分段,防 AI 混淆)
  const C = [].concat(cand.opps.slice(0, 30), cand.news.slice(0, 25), cand.jobs.slice(0, 12));
  if (!C.length) return null;
  let listText = "【机会(可申请的展览征集/驻留/奖项)】\n";
  C.forEach((c, i) => {
    if (i === cand.opps.slice(0, 30).length) listText += "\n【资讯(本周艺术新闻,来自国内外一线艺术媒体,已标注国内/国际)】\n";
    if (i === cand.opps.slice(0, 30).length + cand.news.slice(0, 25).length) listText += "\n【招聘(在招艺术岗位)】\n";
    listText += candLine(c, i) + "\n";
  });
  const sys =
    "你是艺术平台 ArtPortal 的特约主笔,笔名 Eli。写作水准对标《纽约时报》艺术版与 e-flux criticism:严谨、克制、具体、有洞察。\n" +
    "任务:基于给定的【编号候选清单】(全部为平台已核实的真实条目;资讯部分来自 Hyperallergic、The Art Newspaper、Artforum、ArtReview、雅昌艺术网、艺术中国等国内外一线艺术媒体),写一篇 1400–2000 字的中文艺术周报文章——是真正的文章,不是条目罗列。\n\n" +
    "结构要求(像论文一样严谨):\n" +
    "1. 标题:有观点的刊题(不要『第X周周报』这种流水账题);副题一句,点出本周的观察线索。\n" +
    "2. 正文 3–4 个章节:把候选条目组织进【有内在逻辑的叙事】(如按地理、媒介、机制、时间性分组),每章节 2–4 段;段落之间要有承转,不是并列的条目说明。\n" +
    "3. 全球视野与中外对照(本刊立身之本):资讯候选已标【国内】【国际】——文章必须体现国内与国际艺术现场的对照观察(市场环境、机构机制、创作方式、正在讨论的论题的差异与呼应),至少一个章节把中外材料并置分析,让读者从一篇文章看清两边的水温。\n" +
    "4. 理论视野:在合适的章节【转述】1–3 处当代艺术理论帮助读者理解材料(如布里奥的关系美学、克莱尔·毕晓普对参与式艺术的批评、格罗伊斯论策展与档案、布尔迪厄的场域理论等)——理论必须服务于本周材料的解读,不堆砌名词。\n" +
    "5. 结语:一段,收束本周观察,给创作者一个具体的行动建议。\n\n" +
    "铁律(违反任何一条即废稿):\n" +
    "A. 一切事实(项目/机构/人名/日期/地点/数字)只能来自候选清单;绝不引入清单之外的展览、机构或事件。\n" +
    "B. 正文每次提到候选条目,必须用 [[编号:显示文字]] 标记,如 [[3:未来世代艺术奖]];显示文字须是该条目的实际名称或自然简称;至少提及 8 个不同条目,机会/资讯/招聘三类都要覆盖。\n" +
    "C. 理论只能【转述观点】,绝不使用带引号的直接引语,绝不编造书名页码、年份、出版细节;理论家人名与理论名称须是公认常识。\n" +
    "D. 语言:中文书面语;不用『震撼』『必看』『重磅』等营销腔;不吹捧任何机构。\n" +
    "E. 每个章节可选一张配图:字段 image 填某个标注[有配图]的候选编号(该章节确实谈到它时才配),否则填 null。\n\n" +
    '只输出一个 JSON:{"title":"…","subtitle":"…","sections":[{"heading":"…","image":编号或null,"paragraphs":["…","…"]}],"closing":"…"}';
  async function callOnce(extraNote) {
    const userContent = "本期:" + weekId + (extraNote ? "\n(上一稿问题:" + extraNote + ",请重写并严格遵守铁律)" : "") + "\n\n候选清单:\n" + listText;
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.EXTRACT_MODEL || "deepseek-chat",
          temperature: 0.75, max_tokens: 5000, response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userContent }
          ]
        }),
        signal: AbortSignal.timeout(150000)
      });
      if (!res.ok) throw new Error("deepseek " + res.status);
      const j = await res.json();
      const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      const m = /\{[\s\S]*\}/.exec(raw);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) {
      // DeepSeek 不可用 → 免费 GLM 兜底成文(文笔弱一档;铁律仍由 inspect 校验+引用程序回填把关),
      // 再不行 compose 会退回清单式程序模板,刊不断更。
      try { const g = await extractGlmFree(sys, userContent, 5000); return (g && g.data) || null; }
      catch (e2) { return null; }
    }
  }
  // 稿件校验:结构完整 + 引用充分。不达标给一次重写机会(带上问题说明)。
  function inspect(out) {
    if (!out || !String(out.title || "").trim()) return "缺标题";
    const secs = Array.isArray(out.sections) ? out.sections : [];
    if (secs.length < 2) return "章节少于 2 个";
    let refs = new Set(), badRef = 0, totalLen = 0;
    for (const s of secs) {
      const paras = Array.isArray(s.paragraphs) ? s.paragraphs : [];
      if (!paras.length) return "存在空章节";
      for (const p of paras) {
        totalLen += String(p).length;
        for (const mm of String(p).matchAll(REF_RE)) {
          const n = Number(mm[1]);
          if (Number.isInteger(n) && n >= 0 && n < C.length) refs.add(n); else badRef++;
        }
      }
    }
    if (refs.size < 6) return "文内 [[编号:文字]] 引用不足(仅 " + refs.size + " 个,需≥8)";
    if (badRef > refs.size) return "存在大量非法编号引用";
    if (totalLen < 600) return "正文太短";
    return null;
  }
  let out = await callOnce(null);
  let problem = inspect(out);
  if (problem) {
    // 诊断:把首段样本打出来,看模型实际用了什么标记格式(排查 [[编号:文字]] 走样)
    try {
      const p0 = out && out.sections && out.sections[0] && out.sections[0].paragraphs && out.sections[0].paragraphs[0];
      if (p0) process.stderr.write("[周报] 首段样本:" + String(p0).slice(0, 260) + "\n");
    } catch (e) {}
    process.stderr.write("[周报] 初稿未过校验(" + problem + "),重写一次\n");
    out = await callOnce(problem);
    problem = inspect(out);
    if (problem) { process.stderr.write("[周报] 重写仍未过(" + problem + "),退回清单式\n"); return null; }
  }
  const { article, refNum } = assembleArticle(out, C, weekId);
  // 英文平行版(中英切换):忠实翻译原稿(保留 [[编号:文字]] 标记),用同一套引用编号组装;
  // 翻译失败/结构走样 → 不挂 en,前端英文界面回退中文(诚实降级,绝不硬凑)。
  try {
    const enOut = await translateArticle(out, key);
    if (enOut) {
      const enSecs = assembleEnSections(enOut, C, refNum);
      if (enSecs.length === article.sections.length) {
        const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
        article.en = { title: s(enOut.title, 90), subtitle: s(enOut.subtitle, 200), closing: s(enOut.closing, 900), sections: enSecs };
        // 英文正文里 AI 给出的项目英文名,回填到 References 的 title_en(比机翻库存名更贴切)
        const enName = new Map();
        for (const sec of enSecs) for (const p of sec.paragraphs) for (const sg of p) {
          if (sg.ref && sg.ref.text && !enName.has(sg.ref.n)) enName.set(sg.ref.n, sg.ref.text);
        }
        for (const r of article.references) if (enName.has(r.n)) r.title_en = enName.get(r.n);
      } else process.stderr.write("[周报] 英文版章节数与中文不一致,弃用(前端回退中文)\n");
    }
  } catch (e) {}
  return article;
}
// 忠实翻译整篇文章(NYT 式书面英文);[[编号:文字]] 标记保留编号、标记内文字译为英文名/自然表述
async function translateArticle(out, key) {
  const payload = { title: out.title, subtitle: out.subtitle, sections: (out.sections || []).map(s => ({ heading: s.heading, paragraphs: s.paragraphs })), closing: out.closing };
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.EXTRACT_MODEL || "deepseek-chat",
        temperature: 0.3, max_tokens: 6000, response_format: { type: "json_object" },
        messages: [
          { role: "system", content:
            "Faithfully translate this Chinese art-weekly article into polished written English (NYT arts-desk register). " +
            "Keep the JSON structure EXACTLY the same (same number of sections, same number of paragraphs per section). " +
            "In-text markers like [[3:未来世代艺术奖]] MUST be preserved with the same number; translate only the display text inside (use the project's common English name if it has one, otherwise a natural rendering). " +
            "Do not add or remove facts. Output JSON only, same shape as input: {title,subtitle,sections:[{heading,paragraphs:[...]}],closing}" },
          { role: "user", content: JSON.stringify(payload) }
        ]
      }),
      signal: AbortSignal.timeout(150000)
    });
    if (!res.ok) return null;
    const j = await res.json();
    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    const m = /\{[\s\S]*\}/.exec(raw);
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return null; }
}
// 程序组装:解析引用标记→回填真实链接与文末汇总;配图编号→回填封面与图注。
// 存档格式 format:2 —— paragraphs 为 segment 数组 [{t:"文字"}|{ref:{n,oid,kind,url,text}}]
// buildSegs:refOrder 传 null = 只认已有编号(英文遍),未知编号剥壳——中英共用同一套文末编号。
function buildSegs(text, C, refNum, refOrder) {
  const segs = [];
  let last = 0;
  for (const m of String(text).matchAll(REF_RE)) {
    const n = Number(m[1]);
    const label = m[2].trim();
    if (m.index > last) segs.push({ t: String(text).slice(last, m.index) });
    const valid = Number.isInteger(n) && n >= 0 && n < C.length && (refNum.has(n) || refOrder);
    if (valid) {
      if (!refNum.has(n)) { refNum.set(n, refNum.size + 1); refOrder.push(n); }
      const c = C[n];
      segs.push({ ref: { n: refNum.get(n), oid: c.oid, kind: c.kind, url: c.kind === "opp" ? null : (c.url || null), text: label || c.title } });
    } else {
      segs.push({ t: label });             // 非法编号:剥掉标记只留文字,绝不生成假链接
    }
    last = m.index + m[0].length;
  }
  if (last < String(text).length) segs.push({ t: String(text).slice(last) });
  return segs;
}
// 英文平行章节(只译文本层;image/references 共用中文版——项目名等专有名词不做二次翻译)
function assembleEnSections(enOut, C, refNum) {
  const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  return (enOut.sections || [])
    .map(sec => ({
      heading: s(sec.heading, 90),
      paragraphs: (Array.isArray(sec.paragraphs) ? sec.paragraphs : []).map(p => buildSegs(s(p, 3000), C, refNum, null))
    }))
    .filter(sec => sec.paragraphs.length);
}
function assembleArticle(out, C, weekId) {
  const s = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const refOrder = [];                       // 首次出现顺序 → 文末编号 1..n
  const refNum = new Map();                  // 候选下标 → 文末编号
  const sections = (out.sections || []).map(sec => {
    const paras = (Array.isArray(sec.paragraphs) ? sec.paragraphs : []).map(p => buildSegs(s(p, 2000), C, refNum, refOrder));
    let image = null;
    const iv = Number(sec.image);
    if (Number.isInteger(iv) && iv >= 0 && iv < C.length && C[iv].cover) {
      const c = C[iv];
      const enBy = c.org_en || enName(c.org || c.source || "");
      image = {
        src: c.cover,
        caption: c.title + (c.org || c.source ? " · " + (c.org || c.source) : ""),
        caption_en: c.title_en ? c.title_en + (enBy ? " · " + enBy : "") : null
      };
    }
    return { heading: s(sec.heading, 60), image, paragraphs: paras };
  }).filter(sec => sec.paragraphs.length);
  const references = refOrder.map((n, i) => {
    const c = C[n];
    const meta = c.kind === "opp"
      ? [c.org, [c.city, c.country].filter(Boolean).join(" "), c.deadline ? "截止 " + c.deadline : ""].filter(Boolean).join(" · ")
      : c.kind === "news"
        ? [c.source, c.published_at].filter(Boolean).join(" · ")
        : [c.org, c.location, c.deadline ? "截止 " + c.deadline : ""].filter(Boolean).join(" · ");
    // 英文 meta:机构/城市/国家用数据里的英文字段(机会已 100% 双语),媒体名走权威映射,截止→Deadline
    const meta_en = c.kind === "opp"
      ? [c.org_en || enName(c.org), [c.city_en || c.city, c.country_en || c.country].filter(Boolean).join(" "), c.deadline ? "Deadline " + c.deadline : ""].filter(Boolean).join(" · ")
      : c.kind === "news"
        ? [enName(c.source), c.published_at].filter(Boolean).join(" · ")
        : [enName(c.org), c.location, c.deadline ? "Deadline " + c.deadline : ""].filter(Boolean).join(" · ");
    return { n: i + 1, oid: c.oid, kind: c.kind, title: c.title, title_en: c.title_en || null, meta, meta_en, url: c.kind === "opp" ? null : (c.url || null) };
  });
  return {
    article: {
      format: 2,
      author: "Eli",                         // 本刊主笔笔名(AI 撰写标注照常保留,绝不冒充真人记者)
      title: s(out.title, 60) || ("ArtPortal 艺术周刊 " + weekId),
      subtitle: s(out.subtitle, 120),
      closing: s(out.closing, 600),
      sections, references
    },
    refNum
  };
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
  if (!cand.opps.length && !cand.news.length && !cand.jobs.length) {
    return { report: null, empty: true };    // 空刊保护:数据长期没更新就不出刊
  }
  let report = null;
  // 首选:撰稿 agent 的文章型周刊(format 2);两稿都不过校验才退回清单式,保证必出刊
  const article = await composeArticleAI(cand, weekId);
  if (article) {
    report = {
      id: weekId,
      date: todayISO(),
      ai_composed: true,
      counts: ["opp", "news", "job"].map(k => article.references.filter(r => r.kind === k).length),
      ...article,
      generated_at: new Date().toISOString()
    };
  } else {
    let c = await composeWithAI(cand, weekId);
    const ai = !!c;
    if (!c) c = composeFallback(cand, weekId);
    report = {
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
    report.counts = report.sections.map(s => s.items.length);
  }
  await mkdir(WEEKLY_DIR, { recursive: true });
  await atomicWrite(file, report);
  // 目录:一行一期(新在前),供前端横条与归档列表用
  const idx = await readWeeklyIndex();
  const list = (idx.list || []).filter(x => x.id !== weekId);
  list.unshift({ id: weekId, title: report.title, title_en: report.en ? report.en.title : null, date: report.date, counts: report.counts });
  list.sort((a, b) => b.id.localeCompare(a.id));
  await atomicWrite(join(WEEKLY_DIR, "index.json"), { list: list.slice(0, 120) });
  return { report, existed: false };
}

// ---------- 个人专属总结(v0.73.0)----------
// 复用文章型撰稿管线(候选编号→[[编号:文字]]标记→程序回填真实链接→文末汇总),
// 与周刊的区别:①素材=该用户的收藏(不做时间过滤,收藏即入选);②署名 ArtPortal(非 Eli);
// ③中文单语(用户选择,省一半 AI 成本,不译英);④口吻"为你综述"。反幻觉红线完全一致。
// 入参 favItems: [{channel:"opportunities"|"news"|"jobs", item:原始对象}](works 不进文字综述)。
export async function generatePersonalSummary(favItems, opts = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const opps = [], news = [], jobs = [];
  for (const f of (favItems || [])) {
    const o = f.item || {};
    if (f.channel === "opportunities") opps.push({
      oid: o.id, kind: "opp", title: o.title_zh || o.title_en || "", title_en: o.title_en || null,
      org: o.org_zh || "", city: o.city_zh || "", country: o.country_zh || "",
      org_en: o.org_en || null, city_en: o.city_en || null, country_en: o.country_en || null,
      category: o.category || "", deadline: o.deadline || null,
      summary: String(o.summary_zh || "").slice(0, 160), cover: o.cover || null
    });
    else if (f.channel === "news") news.push({
      oid: o.id, kind: "news", title: o.title_zh || o.title || "", title_en: o.title_en || null,
      source: o.source || o.domain || "",
      region: (/雅昌|艺术中国|99艺术|中国美术|凤凰艺术/.test(o.source || "") || /[一-鿿]/.test(String(o.title || ""))) ? "国内" : "国际",
      published_at: o.published_at || null, url: o.url,
      summary: String(o.summary_zh || o.summary || "").slice(0, 160), cover: o.cover || null
    });
    else if (f.channel === "jobs") jobs.push({
      oid: o.id, kind: "job", title: o.title_zh || o.title || "", title_en: o.title_en || null,
      org: o.org_zh || o.org || "", location: [o.city, o.country].filter(Boolean).join(" "),
      deadline: o.deadline || null, url: o.apply_url || o.url,
      summary: String(o.summary_zh || o.summary || "").slice(0, 100), cover: o.cover || null
    });
  }
  const C = [].concat(opps.slice(0, 30), news.slice(0, 25), jobs.slice(0, 12));
  if (C.length < 2) return { error: "too_few" };   // 素材太少不足以成文
  let listText = "【机会(用户收藏的展览征集/驻留/奖项)】\n";
  const nOpp = opps.slice(0, 30).length, nNews = news.slice(0, 25).length;
  C.forEach((c, i) => {
    if (i === nOpp) listText += "\n【资讯(用户收藏的艺术新闻)】\n";
    if (i === nOpp + nNews) listText += "\n【招聘(用户收藏的岗位)】\n";
    listText += candLine(c, i) + "\n";
  });
  const nick = String(opts.nickname || "").slice(0, 40);
  const sys =
    "你是艺术平台 ArtPortal 的编辑,为单个用户撰写一份【专属收藏综述】,署名 ArtPortal。写作水准对标《纽约时报》艺术版:严谨、克制、具体、有洞察。\n" +
    "任务:基于该用户【收藏的编号候选清单】(全部为平台已核实的真实条目),写一篇 900–1500 字的中文综述——不是条目罗列,而是为这位用户量身写的文章:读出 TA 收藏里的兴趣脉络与共性(媒介/地域/机制/主题),把这些收藏组织成有内在逻辑的叙事,并给出面向 TA 的具体建议(临近截止的提醒、值得深挖的方向)。\n\n" +
    "结构:1)有观点的标题 + 一句副题(点出这位用户的收藏主线);2)正文 2–3 个章节,每章 2–3 段,段落之间有承转;3)结语一段,给 TA 一个具体的行动建议。\n\n" +
    "铁律(违反任何一条即废稿):\n" +
    "A. 一切事实(项目/机构/人名/日期/地点/数字)只能来自候选清单,绝不引入清单之外的任何内容。\n" +
    "B. 正文每次提到候选条目必须用 [[编号:显示文字]] 标记(如 [[2:未来世代艺术奖]]);显示文字须是该条目实际名称或自然简称;至少提及 6 个不同条目。\n" +
    "C. 不用营销腔(『必看』『重磅』『震撼』);不吹捧机构;可克制地转述当代艺术理论帮助解读,但绝不使用带引号的直接引语、绝不编造书名页码年份等出版细节。\n" +
    "D. 语言:中文书面语。E. 每个章节可选一张配图:字段 image 填某个标注[有配图]的候选编号(该章确实谈到它时才配),否则填 null。\n\n" +
    '只输出一个 JSON:{"title":"…","subtitle":"…","sections":[{"heading":"…","image":编号或null,"paragraphs":["…","…"]}],"closing":"…"}';
  async function callOnce(extra) {
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.EXTRACT_MODEL || "deepseek-chat",
          temperature: 0.7, max_tokens: 4000, response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys },
            { role: "user", content: (nick ? "用户昵称:" + nick + "\n" : "") + "收藏清单:\n" + listText + (extra ? "\n(上一稿问题:" + extra + ",请重写并严格遵守铁律)" : "") }
          ]
        }),
        signal: AbortSignal.timeout(150000)
      });
      if (!res.ok) return null;
      const j = await res.json();
      const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
      const m = /\{[\s\S]*\}/.exec(raw);
      return m ? JSON.parse(m[0]) : null;
    } catch (e) { return null; }
  }
  function inspect(out) {
    if (!out || !String(out.title || "").trim()) return "缺标题";
    const secs = Array.isArray(out.sections) ? out.sections : [];
    if (secs.length < 2) return "章节少于 2 个";
    let refs = new Set(), totalLen = 0;
    for (const s of secs) {
      const paras = Array.isArray(s.paragraphs) ? s.paragraphs : [];
      if (!paras.length) return "存在空章节";
      for (const p of paras) {
        totalLen += String(p).length;
        for (const mm of String(p).matchAll(REF_RE)) { const n = Number(mm[1]); if (Number.isInteger(n) && n >= 0 && n < C.length) refs.add(n); }
      }
    }
    if (refs.size < 4) return "文内引用不足(仅 " + refs.size + " 个,需≥6)";
    if (totalLen < 400) return "正文太短";
    return null;
  }
  let out = await callOnce(null);
  let problem = inspect(out);
  if (problem) { out = await callOnce(problem); problem = inspect(out); if (problem) return null; }
  const { article } = assembleArticle(out, C, "");
  article.author = "ArtPortal";
  delete article.en;                              // 个人总结中文单语,不挂英文版
  return {
    kind: "personal",
    date: todayISO(),
    ai_composed: true,
    counts: ["opp", "news", "job"].map(k => article.references.filter(r => r.kind === k).length),
    ...article,
    generated_at: new Date().toISOString()
  };
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
// 文章型(format 2)引用 → 链接:机会走站内详情深链,资讯/招聘走原文
function refHref(ref, siteUrl) {
  return ref.kind === "opp" ? siteUrl + "/#/o/" + encodeURIComponent(ref.oid) : (ref.url || siteUrl);
}
function articleEmailHtml(report, { siteUrl, unsubUrl }) {
  const serif = "Georgia,'Times New Roman','Songti SC',STSong,SimSun,serif";
  const sans = "-apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
  const para = (segs) => '<p style="font-family:' + serif + ';font-size:16px;line-height:1.9;color:#1b1a18;margin:0 0 16px">' +
    segs.map(sg => sg.t != null
      ? esc(sg.t)
      : '<a href="' + esc(refHref(sg.ref, siteUrl)) + '" style="color:#2e6fa7;text-decoration:underline">' + esc(sg.ref.text) + '</a><sup style="font-size:11px;color:#8a847c">[' + sg.ref.n + ']</sup>'
    ).join("") + "</p>";
  const sec = (sc) =>
    '<h2 style="font-family:' + serif + ';font-size:20px;margin:30px 0 4px;color:#1b1a18;border-top:1px solid #e8e4dc;padding-top:22px">' + esc(sc.heading) + "</h2>" +
    (sc.image ? '<img src="' + esc(/^https?:/i.test(sc.image.src) ? sc.image.src : siteUrl + "/" + sc.image.src) + '" alt="" style="width:100%;border-radius:6px;margin:10px 0 4px" />' +
      '<div style="font-family:' + sans + ';font-size:11.5px;color:#8a847c;margin:0 0 14px">' + esc(sc.image.caption) + "</div>" : "") +
    sc.paragraphs.map(para).join("");
  return (
    '<div style="max-width:620px;margin:0 auto;padding:28px 18px;background:#f7f6f2">' +
      '<div style="font-family:' + sans + ';font-size:12px;letter-spacing:.16em;color:#8a847c;text-align:center">ARTPORTAL · 艺术周刊</div>' +
      '<h1 style="font-family:' + serif + ';font-size:27px;line-height:1.35;margin:14px 0 6px;color:#1b1a18;text-align:center">' + esc(report.title) + "</h1>" +
      (report.subtitle ? '<p style="font-family:' + serif + ';font-size:15px;color:#4a4a47;text-align:center;margin:0 0 6px">' + esc(report.subtitle) + "</p>" : "") +
      '<div style="font-family:' + sans + ';font-size:11.5px;color:#8a847c;text-align:center;margin-bottom:6px">' + esc("文 / " + (report.author || "Eli") + " · " + report.id + " · " + report.date) + "</div>" +
      report.sections.map(sec).join("") +
      (report.closing ? '<p style="font-family:' + serif + ';font-size:16px;line-height:1.9;color:#1b1a18;margin:24px 0 0;font-style:italic">' + esc(report.closing) + "</p>" : "") +
      '<h2 style="font-family:' + serif + ';font-size:17px;margin:32px 0 10px;border-top:1px solid #e8e4dc;padding-top:22px">本期提及</h2>' +
      report.references.map(r =>
        '<div style="font-family:' + sans + ';font-size:12.5px;line-height:1.7;color:#4a4a47;margin:0 0 7px">[' + r.n + '] ' +
        '<a href="' + esc(refHref(r, siteUrl)) + '" style="color:#2e6fa7">' + esc(r.title) + "</a>" + (r.meta ? " — " + esc(r.meta) : "") + "</div>"
      ).join("") +
      '<hr style="border:none;border-top:1px solid #e8e4dc;margin:26px 0 12px" />' +
      '<p style="font-family:' + sans + ';font-size:11px;color:#8a847c;line-height:1.7">本文由 AI(主笔 agent)撰写生成,条目事实以各项目原文为准。</p>' +
      '<p style="font-family:' + sans + ';font-size:11px;color:#8a847c;line-height:1.7">你收到本邮件是因为在 ArtPortal 注册时勾选了订阅周报。' +
        '<a href="' + esc(unsubUrl) + '" style="color:#8a847c">退订</a> · <a href="' + esc(siteUrl) + '" style="color:#8a847c">访问 ArtPortal</a></p>' +
    "</div>"
  );
}
export function renderEmailHtml(report, { siteUrl, unsubUrl }) {
  if (report.format === 2) return articleEmailHtml(report, { siteUrl, unsubUrl });
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
  if (report.format === 2) {
    const lines = [report.title, report.subtitle || "", report.id + " · " + report.date + " · AI 撰写,条目事实以原文为准", ""];
    for (const sc of report.sections) {
      lines.push("== " + sc.heading + " ==");
      for (const p of sc.paragraphs) lines.push(p.map(sg => sg.t != null ? sg.t : sg.ref.text + "[" + sg.ref.n + "]").join(""), "");
    }
    if (report.closing) lines.push(report.closing, "");
    lines.push("—— 本期提及 ——");
    for (const r of report.references) lines.push("[" + r.n + "] " + r.title + (r.meta ? " — " + r.meta : "") + "\n    " + refHref(r, siteUrl));
    lines.push("", "退订:" + unsubUrl);
    return lines.join("\n");
  }
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
