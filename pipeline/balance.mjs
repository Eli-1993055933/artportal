// balance.mjs —— 机会类型均衡巡检器(2026-08-22 新增)
// 目的:让每日采集在"官方体制内/商业/独立学术 × 收费/免费" 与 category 分布上不再纯靠运气。
// 做法:读 opportunities.json → 统计 org_type / apply_fee / category 各维度占比 →
//       识别低于目标比例(或绝对量过低)的短板桶 → 输出 state/balance-report.json(含短板定向补抓词)。
// 纯程序统计,不调用 AI、不编造;产出喂给每日调度,由调度按短板词定向补抓。
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "..", "site", "data", "opportunities.json");
const OUT = join(__dir, "state", "balance-report.json");

const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

// 目标占比(可 --target-org_type / --target-category 覆盖)。占位兜底阈值:低于此项视为短板。
const TARGETS = {
  // 机构性质:了一圈"官方体制内 / 商业 / 独立学术 / 其他(聚合/未知)"都要有
  org_type: {
    official: 0.35,      // 官方体制内(美术馆/画院/文旅厅/美协/院校)
    independent: 0.4,    // 独立学术/非营利(基金会/驻留中心/策展实验室)
    commercial: 0.2,     // 商业(画廊/艺博会/拍卖/品牌赞助)——实测仅3条,严重短板
    _min_abs: 20         // 任意性质桶绝对量<20 即判短板(防"占比OK但总量塌方")
  },
  // 收费/免费:免费与收费都要有
  apply_fee: {
    free: 0.4,
    paid: 0.35,
    unknown: 0.25,       // free 与 paid 都判为"有标定";unknown 允许存在但也要有
    _min_abs: 30
  },
  // 类别:主要四类都要有,小众类(grant/workshop)给绝对量保底
  category: {
    opencall: 0.35,
    residency: 0.35,
    award: 0.15,
    grant: 0.08,
    workshop: 0.05,
    _min_abs: 15
  }
};

// 短板 → 定向补抓词(喂给每日调度,同步线程/区域经理检索用)。纯词表,字字是检索意图,非编造数据。
const SHORTAGE_TERMS = {
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
    "艺术大赛 报名费 收费",  // 检索词含收费意图;入库仍以 evidence 为准
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

async function main() {
  const raw = JSON.parse(await readFile(DATA, "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw.opportunities || raw.items || []);
  const orgDist = countBy(arr, "org_type");
  const catDist = countBy(arr, "category");
  const feeDist = {};
  for (const r of arr) { const k = feeBucket(r); feeDist[k] = (feeDist[k] || 0) + 1; }

  const helpers = (named, dist, realGuide) => {
    const total = Object.values(dist).reduce((a, b) => a + b, 0);
    return { total, dist, guide: realGuide };
  };

  const short = [];
  const gauge = "systemic"; // 记录:性质=org_type主判,辅助吃满

  // —— org_type 短板 ——
  const ot = helpers("org_type", orgDist, TARGETS.org_type);
  const otTotal = ot.total;
  for (const [bucket, target] of Object.entries(TARGETS.org_type)) {
    if (bucket.startsWith("_")) continue;
    const n = orgDist[bucket] || 0;
    const p = otTotal ? n / otTotal : 0;
    const minAbs = TARGETS.org_type._min_abs;
    if (p < target || n < minAbs) {
      short.push({ dimension: "org_type", bucket, actual: n, ratio: +p.toFixed(3), target, reason: n < minAbs ? `绝对量<${minAbs}` : "占比低于目标" });
    }
  }
  // —— apply_fee 短板 ——
  const ft = helpers("apply_fee", feeDist, TARGETS.apply_fee);
  const ftTotal = ft.total;
  for (const [bucket, target] of Object.entries(TARGETS.apply_fee)) {
    if (bucket.startsWith("_")) continue;
    const n = feeDist[bucket] || 0;
    const p = ftTotal ? n / ftTotal : 0;
    const minAbs = TARGETS.apply_fee._min_abs;
    if (p < target || n < minAbs) {
      short.push({ dimension: "apply_fee", bucket, actual: n, ratio: +p.toFixed(3), target, reason: n < minAbs ? `绝对量<${minAbs}` : "占比低于目标" });
    }
  }
  // —— category 短板 ——
  const ct = helpers("category", catDist, TARGETS.category);
  const ctTotal = ct.total;
  for (const [bucket, target] of Object.entries(TARGETS.category)) {
    if (bucket.startsWith("_")) continue;
    const n = catDist[bucket] || 0;
    const p = ctTotal ? n / ctTotal : 0;
    const minAbs = TARGETS.category._min_abs;
    if (p < target || n < minAbs) {
      short.push({ dimension: "category", bucket, actual: n, ratio: +p.toFixed(3), target, reason: n < minAbs ? `绝对量<${minAbs}` : "占比低于目标" });
    }
  }

  // 短板 → 建议补抓词(按 bucket 主键聚合去重)
  const suggest = {};
  for (const s of short) {
    const key = SHORTAGE_TERMS[s.bucket] ? s.bucket : (s.dimension === "category" && SHORTAGE_TERMS[s.bucket] ? s.bucket : null);
    if (key) suggessPush(suggest, key);
  }
  // 同名 bucket 在 org_type 与 category 下都收窄(如 commercial→商业;grant/workshop 是 category)
  for (const s of short) {
    if (SHORTAGE_TERMS[s.bucket] && !suggest[s.bucket]) suggest[s.bucket] = [];
  }

  function suggessPush(sg, k) {
    if (!sg[k]) sg[k] = [];
    for (const t of SHORTAGE_TERMS[k]) { if (!sg[k].includes(t)) sg[k].push(t); }
  }

  const report = {
    generated_at: new Date().toISOString(),
    total: arr.length,
    distributions: {
      org_type: orgDist,
      apply_fee: feeDist,
      category: catDist
    },
    gauge,
    shortages: short,
    recommended_terms: suggest,
    note: "短板词表为纯检索意图(喂每日调度的定向补抓词),非编造数据;入库始终经 evidence 校验."
  };

  await writeFile(OUT, JSON.stringify(report, null, 2), "utf8");

  // 人类可读摘要
  console.log(`\n机会总量:${arr.length}`);
  console.log(`org_type:  ${JSON.stringify(orgDist)}`);
  console.log(`apply_fee: ${JSON.stringify(feeDist)}`);
  console.log(`category:  ${JSON.stringify(catDist)}`);
  if (short.length === 0) {
    console.log("✔ 各维度均达到目标比例,无短板。");
  } else {
    console.log(`\n短板 ${short.length} 项(低于目标或绝对量过低):`);
    for (const s of short) console.log(`  - ${s.dimension}.${s.bucket}: ${s.actual}条(占比${(s.ratio * 100).toFixed(1)}%,目标${(s.target * 100).toFixed(0)}%;${s.reason})`);
    console.log("\n建议定向补抓词:");
    for (const [k, v] of Object.entries(suggest)) console.log(`  [${k}] ${v.slice(0, 3).join(" | ")}${v.length > 3 ? ` (+${v.length - 3})` : ""}`);
  }
  console.log(`\n报告已写 ${OUT}`);
}

main().catch(e => { console.error("均衡巡检失败:", e); process.exit(1); });