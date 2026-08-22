// balance.mjs —— 机会类型均衡巡检器 + 短板词提供器(2026-08-22 新增,2026-08-23 重构)
//
// 双用途:
//   ① 独立 CLI:读 opportunities.json → 统计 org_type/apply_fee/category 三维分布 →
//      识别短板桶 → 写 state/balance-report.json(供人工 / 日报查看)。用法:`node balance.mjs`。
//   ② 服务端程序库:导出纯函数 computeShortageTerms(arr) → 返回短板桶词表。
//      server.mjs 每小时在【服务器本地】用它自己的机会数据算短板(不依赖本机生成的 report 文件),
//      把短板词注入区域经理选词,让免费/收费/官方/商业/独立学术/各类别每天自动补均衡。
//
// 纯程序统计,不调用 AI、不编造;所有"短板词"只是检索意图字,入库仍逐字 evidence 校验。
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const OUT = join(__dir, "state", "balance-report.json");

// 目标占比。低于目标占比或低于绝对量下限即判短板。
export const TARGETS = {
  org_type: { official: 0.35, independent: 0.4, commercial: 0.2, _min_abs: 20 },
  apply_fee: { free: 0.4, paid: 0.35, unknown: 0.25, _min_abs: 30 },
  category: { opencall: 0.35, residency: 0.35, award: 0.15, grant: 0.08, workshop: 0.05, _min_abs: 15 }
};

// 短板 → 定向补抓词(纯检索意图,非编造数据)。供 server 注入区域经理选词。
export const SHORTAGE_TERMS = {
  commercial: [
    "commercial gallery open call emerging artists",
    "art fair open call artists application",
    "auction house art prize open call",
    "品牌 艺术 赞助 项目 征集",
    "commercial art award cash prize open call"
  ],
  independent: [
    "independent curator open call exhibition",
    "独立艺术空间 open call 征集",
    "art foundation fellowship grant open",
    "artist collective open call join"
  ],
  official: [
    "省文化和旅游厅 美术 作品 征集 官网",
    "地方美术馆 年度 展览 征集 报名",
    "美术学院 学术展 征集 官网",
    "市画院 美协 文联 展览 征集"
  ],
  grant: [
    "art grant for independent artists apply",
    "open call art fund stipend",
    "艺术家 创作 基金 申请 开放",
    "art foundation fellowship grant open"
  ],
  workshop: [
    "art workshop open call participants",
    "艺术家 工作坊 招募 报名",
    "masterclass art open call apply",
    "版画 工作坊 招募 艺术家"
  ],
  paid: [
    "commercial art competition entry fee open call",
    "艺术大赛 报名费 收费",
    "paid art residency apply fee",
    "cash prize art competition open call"
  ],
  free: [
    "free art residency no fee apply",
    "零费用 艺术驻留 申请 免费",
    "free open call for artists no cost",
    "免费 艺术 大赛 征集 报名"
  ]
};

function countBy(arr, key) { const o = {}; for (const r of arr) { const k = r[key] || "none"; o[k] = (o[k] || 0) + 1; } return o; }
function feeBucket(r) {
  const a = r.apply_fee;
  if (a) return a.free === true ? "free" : (a.free === false || a.amount ? "paid" : "unknown");
  return "unknown";
}

// 纯函数:给机会数组,返回 { shortages[], recommended_terms{桶:[词]}, distributions }。
// 可被 server.mjs 复用(它在服务器本地算短板,server 用同一份逻辑,行为一致)。
export function computeShortageTerms(arr) {
  const orgDist = countBy(arr, "org_type");
  const catDist = countBy(arr, "category");
  const feeDist = {};
  for (const r of arr) { const k = feeBucket(r); feeDist[k] = (feeDist[k] || 0) + 1; }

  const short = [];
  const pushShortPlane = (plane, dist, tar) => {
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    const minAbs = tar._min_abs || 0;
    for (const [bucket, target] of Object.entries(tar)) {
      if (bucket.startsWith("_")) continue;
      const n = dist[bucket] || 0;
      const p = total ? n / total : 0;
      if (p < target || n < minAbs) {
        short.push({ dimension: plane, bucket, actual: n, ratio: +p.toFixed(3), target, reason: n < minAbs ? `绝对量<${minAbs}` : "占比低于目标" });
      }
    }
  };
  pushShortPlane("org_type", orgDist, TARGETS.org_type);
  pushShortPlane("apply_fee", feeDist, TARGETS.apply_fee);
  pushShortPlane("category", catDist, TARGETS.category);

  const suggest = {};
  for (const s of short) {
    if (SHORTAGE_TERMS[s.bucket]) { (suggest[s.bucket] || (suggest[s.bucket] = [])); for (const t of SHORTAGE_TERMS[s.bucket]) if (!suggest[s.bucket].includes(t)) suggest[s.bucket].push(t); }
  }

  return {
    total: arr.length,
    distributions: { org_type: orgDist, apply_fee: feeDist, category: catDist },
    shortages: short,
    recommended_terms: suggest
  };
}

async function main() {
  const raw = JSON.parse(await readFile(DATA, "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw.opportunities || raw.items || []);
  const res = computeShortageTerms(arr);
  const report = {
    generated_at: new Date().toISOString(),
    total: res.total,
    distributions: res.distributions,
    gauge: "systemic",
    shortages: res.shortages,
    recommended_terms: res.recommended_terms,
    note: "短板词表为纯检索意图(喂每日调度的定向补抓词),非编造数据;入库始终经 evidence 校验."
  };
  await writeFile(OUT, JSON.stringify(report, null, 2), "utf8");

  console.log(`\n机会总量:${res.total}`);
  console.log(`org_type:  ${JSON.stringify(res.distributions.org_type)}`);
  console.log(`apply_fee: ${JSON.stringify(res.distributions.apply_fee)}`);
  console.log(`category:  ${JSON.stringify(res.distributions.category)}`);
  if (res.shortages.length === 0) {
    console.log("✔ 各维度均达到目标比例,无短板。");
  } else {
    console.log(`\n短板 ${res.shortages.length} 项(低于目标或绝对量过低):`);
    for (const s of res.shortages) console.log(`  - ${s.dimension}.${s.bucket}: ${s.actual}条(占比${(s.ratio * 100).toFixed(1)}%,目标${(s.target * 100).toFixed(0)}%;${s.reason})`);
    console.log("\n建议定向补抓词:");
    for (const [k, v] of Object.entries(res.recommended_terms)) console.log(`  [${k}] ${v.slice(0, 3).join(" | ")}${v.length > 3 ? ` (+${v.length - 3})` : ""}`);
  }
  console.log(`\n报告已写 ${OUT}`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("balance.mjs")) {
  main().catch(e => { console.error("均衡巡检失败:", e); process.exit(1); });
}