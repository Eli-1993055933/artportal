// discover-sources.mjs —— 路线图第 30.1 项:给区域经理找辖区信源(sources.json 扩量)。
//
// 目的:区域经理现靠"每班检索几个词"抓机会,serper 是硬约束撑不久;真正可持续的增长
// 引擎是【地区机构信源】——零 serper 成本抓,只花带宽。这脚本负责【发现候选】:
//   搜索(真实结果)→ 过滤黑名单/已有 → 真实抓取校验(robots+可达)→ 写入 sources.json。
//
// 反幻觉红线不降级,只是对象从"机会内容"换成"信源列表":
//   ① 域名/URL 一律取自真实搜索结果,绝不编造;
//   ② org_zh 取自真实页面 <title>(清洗常见后缀),不由 AI 生成;
//   ③ reachable 字段是真实 HTTP 探测结果,不是猜的;
//   ④ 一律 confirmed:false(与现有 152 条同一惯例)——机器只负责"够得着的候选",
//     具体是不是"通知公告列表页"、后续能不能稳定抓到真机会,仍由 run.mjs 的
//     discoverDetailLinks + verify.mjs 的 evidence 校验兜底,拿不准不会污染正文数据。
//
// 用法:
//   node discover-sources.mjs --dry                     只看会发现什么,不写盘,不消耗真实抓取
//   node discover-sources.mjs                            默认:选当前信源数最少的 6 个区域经理,各 2 词
//   node discover-sources.mjs --regions cn-north,intl-latam --per-region 3
//   node discover-sources.mjs --limit-checks 40          最多真实抓取校验多少个候选(防跑太久)

import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegions } from "./lib/regions.mjs";
import { searchWebFull, serperBudgetLeft, braveBudgetLeft, BLOCK, unsafeHost } from "./lib/websearch.mjs";
import { fetchSource } from "./lib/fetch.mjs";
import { THIRD_PARTY } from "./lib/aggregators.mjs";

// 自动加载 .env(如果存在)
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, ".env");
try {
  const envText = await readFile(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)/);
    if (m) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
  }
} catch (e) { /* .env 不存在则跳过 */ }
const SRC_PATH = join(__dir, "sources.json");

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const opt = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
const PER_REGION = Math.max(1, parseInt(opt("--per-region", "2"), 10) || 2);
const LIMIT_CHECKS = Math.max(1, parseInt(opt("--limit-checks", "60"), 10) || 60);
const ONLY_REGIONS = (opt("--regions", "") || "").split(",").map(s => s.trim()).filter(Boolean);

// 机构猎词(不是机会猎词——机会猎词已在 server.mjs 的 AUTO_QUERIES 里,那是"找征集内容";
// 这里是"找机构本身",目标是官网/通知栏目页,不是具体某条公告)。
const CN_INST_KW = ["美术馆 画院 文联 官网 通知公告", "文化馆 展览 征集 官网", "美术家协会 官网 通知"];
const INTL_INST_KW = ["art museum cultural center official website news", "arts council open call grants apply", "art foundation official website exhibitions"];
// 空洞区本地语言词池(v1.4.0):拉美英文检索漏西语/葡语机构,按区覆盖本地叫法(convocatoria=征集/edital=公告)
const INTL_KW_BY_REGION = {
  "intl-latam": ["museo de arte convocatoria sitio oficial", "residencia artística convocatoria abierta", "museu de arte edital convocatória site oficial"],
  "intl-mena-africa": ["art foundation open call official website", "biennial art residency application official", "arts council grants apply official site"],
  "intl-north-east-europe": ["kunsthalle art centre open call official", "artist residency application official website", "art museum grants open call official"]
};

function titleToOrg(title, domain) {
  let t = String(title || "").trim();
  // 常见站点标题分隔符,取前段(网站标题惯例是"页面名 - 站点名"或"站点名 - 副标题");
  // 两种都可能,取更像机构名的那段(长度 2~24、不含明显导航词)。
  const parts = t.split(/[\-–—|_丨│]/).map(s => s.trim()).filter(Boolean);
  const cand = parts.filter(s => s.length >= 2 && s.length <= 24 && !/^(首页|官网|Home|Official|Welcome)$/i.test(s));
  if (cand.length) return cand.sort((a, b) => b.length - a.length)[0].slice(0, 40);
  return domain;
}

// 明显不是机构官网、而是文件托管/云存储直链的域名——搜索结果偶尔会命中某机构存在这类平台上的
// 单个文件(PDF/图片/JSON),fetchSource 对它们也会返回 200,但那不是"通知公告列表页",
// 抓了也没有可发现的详情链接,徒增噪声。先在这挡掉,比事后清理省事。
const STORAGE_HOST = /(^|\.)(s3[.-][a-z0-9-]+\.amazonaws\.com|amazonaws\.com|cloudfront\.net|googleusercontent\.com|blob\.core\.windows\.net|storage\.googleapis\.com|wixsite\.com|weebly\.com)$/i;
function domainOf(u) { try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch (e) { return null; } }
// 同 seed-known-institutions.mjs 的坑:纯中文标题会被滤空,统一兜底成 "src" 会导致互相撞车丢数据。
function slug(s) {
  const base = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 20);
  if (base) return base;
  let h = 0; for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return "cn-" + h.toString(36).slice(0, 8);
}

async function main() {
  const cfg = await loadRegions();
  const raw = JSON.parse(await readFile(SRC_PATH, "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw.sources || []);
  const existingDomains = new Set(arr.map(s => s.domain));
  const existingIds = new Set(arr.map(s => s.id));

  // 目标区域:显式指定的,或自动挑"现有信源数最少"的 6 个(优先补短板,而不是继续加固已经多的)。
  const counted = {};
  for (const s of arr) if (s.region_hint) counted[s.region_hint] = (counted[s.region_hint] || 0) + 1;
  let targets = ONLY_REGIONS.length
    ? cfg.managers.filter(m => ONLY_REGIONS.includes(m.id))
    : cfg.managers.slice().sort((a, b) => (counted[a.id] || 0) - (counted[b.id] || 0)).slice(0, 6);

  console.log(`目标区域(${targets.length} 个):` + targets.map(m => `${m.zh}(现${counted[m.id] || 0}个)`).join("、"));
  console.log(`每区 ${PER_REGION} 词,Brave 余量 ${braveBudgetLeft()}, Serper 余量 ${serperBudgetLeft()}\n`);

  const added = [], skippedExisting = [], skippedBlock = [], skippedUnreachable = [], checked = new Set();
  let checksLeft = LIMIT_CHECKS;

  for (const m of targets) {
    if (braveBudgetLeft() <= 0 && serperBudgetLeft() <= 2) { console.log("⚠️ Brave 和 Serper 余量均不足,后续区域跳过"); break; }
    const cn = m.kind !== "intl";
    const kw = cn ? CN_INST_KW : (INTL_KW_BY_REGION[m.id] || INTL_INST_KW);
    // 国际区优先用拉丁字母城市名(terms 前半是中文名,拼进英/西语检索词效果差)
    const pool = cn ? m.terms : m.terms.filter(t => /^[\x20-\x7E]+$/.test(t));
    const terms = (pool.length ? pool : m.terms).slice(0, PER_REGION);
    if (!terms.length) continue;

    for (let i = 0; i < Math.min(PER_REGION, terms.length); i++) {
      const term = terms[i];
      const q = `${term} ${kw[i % kw.length]}`;
      let results;
      try { results = await searchWebFull(q, { gl: m.gl, hl: m.hl }); }
      catch (e) { console.log(`  [${m.zh}] "${q}" 搜索失败:${e.message}`); continue; }
      process.stderr.write(`  [${m.zh}] "${q}" → ${results.length} 条结果(Brave 余量 ${braveBudgetLeft()}, Serper 余量 ${serperBudgetLeft()})\n`);

      for (const r of results) {
        const dom = domainOf(r.link);
        if (!dom) continue;
        if (existingDomains.has(dom) || checked.has(dom)) { skippedExisting.push(dom); continue; }
        const host = dom;
        if (BLOCK.test(r.link) || unsafeHost(host)) { skippedBlock.push(dom); continue; }
        if (THIRD_PARTY.some(t => host === t || host.endsWith("." + t))) { skippedBlock.push(dom); continue; }
        if (STORAGE_HOST.test(host)) { skippedBlock.push(dom + "(文件托管,非官网)"); continue; }
        checked.add(dom);
        if (checksLeft-- <= 0) continue;                      // 超过校验上限的候选记下但不抓,下次再补

        // 真实可达性校验:robots + 实抓(与 run.mjs 抓正式信源同一套函数,同样限速/署名)
        let fr;
        try { fr = await fetchSource({ url: r.link, type: "html" }); }
        catch (e) { fr = { skipped: true, reason: "error:" + e.message }; }
        if (fr.skipped) { skippedUnreachable.push(`${dom}(${fr.reason})`); continue; }
        // 页面正文太短(<200字):很可能是"仅 JS 渲染的空壳"或错误页伪装 200,不是可抓的通知栏目
        if (!fr.text || fr.text.length < 200) { skippedUnreachable.push(`${dom}(正文过短,疑似空壳/JS渲染)`); continue; }

        const id = slug(dom.split(".")[0]) + "-auto";
        if (existingIds.has(id)) continue;                    // 极小概率 id 撞车,跳过防覆盖
        const entry = {
          id, org_zh: titleToOrg(r.title, dom), name_zh: "机器发现",
          url: r.link, domain: dom, type: "html", rss: null,
          org_type: "official", category_hint: ["opencall", "award", "workshop"],
          reachable: true, robots: fr.robots || "unknown", confirmed: false,
          notes: `机器发现(v0.99.0,搜索词「${q}」)· 未核实是否为通知公告列表页,首轮抓取按 discoverDetailLinks 表现淘汰`,
          region_hint: m.id
        };
        arr.push(entry); existingDomains.add(dom); existingIds.add(id);
        added.push(entry);
        console.log(`  ✓ [${m.zh}] ${entry.org_zh} → ${dom}`);
      }
    }
  }

  console.log(`\n发现 ${added.length} 个新信源;跳过已有/黑名单 ${skippedBlock.length + skippedExisting.length} 个,不可达 ${skippedUnreachable.length} 个`);
  if (skippedUnreachable.length) console.log("不可达样例:" + skippedUnreachable.slice(0, 6).join("、"));

  if (DRY || !added.length) { console.log(DRY ? "\n[--dry] 未写盘。" : "\n无新增,未写盘。"); return; }
  raw.sources = arr; if (Array.isArray(raw)) { /* 顶层就是数组的情况已在 arr 里改好 */ }
  const out = Array.isArray(raw) ? arr : raw;
  await copyFile(SRC_PATH, SRC_PATH + ".bak-discover");
  const tmp = SRC_PATH + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
  await rename(tmp, SRC_PATH);
  console.log(`已写回 sources.json(信源总数 ${arr.length},备份 sources.json.bak-discover)`);
}
main().catch(e => { console.error("失败:", e); process.exit(1); });
