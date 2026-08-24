// _tmp-cn-fill.mjs —— 本地开发一次性脚本(检索+官网核准补国内机会)
// 走 /api/search(反幻觉检索管线:搜索→爬原文→AI提取→evidence 逐字校验→才入库)。
// 用法:先启动 server.mjs,再 `node _tmp-cn-fill.mjs [--first N] [--from N]`
const BASE = "http://127.0.0.1:8080/api/search";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 国内可投机会检索词:面向官方机构/协会/美术馆官网征稿页,Bing 会拿到官方 call 页面
const QUERIES = [
  "中国美术家协会 全国美术作品展 征稿通知 2026",
  "国家艺术基金 美术创作资助项目 申报公告 2026",
  "中国书法家协会 全国书法篆刻作品展 征稿启事 2026",
  "中国摄影家协会 全国摄影艺术展览 征稿启事 2026",
  "中国雕塑学会 展览 作品征集 通知 2026",
  "中国国家画院 展览 征稿邀请函 2026",
  "中央美术学院 青年艺术家 作品征集 通知",
  "中国美术学院 在校生 创作大赛 报名 2026",
  "四川美术学院 研究生 作品展览 征集 通知",
  "鲁迅美术学院 美术馆 展览 艺术家 征集",
  "天津美术学院 展览 作品征集 通知 2026",
  "湖北美术学院 美术馆 展览申请 征稿",
  "西安美术学院 教学成果展 作品征集 2026",
  "山东美术馆 2026 展览 征集方案 通知",
  "江苏美术馆 展览 艺术家 招募 2026",
  "广东美术馆 馆藏 进驻艺术家 申请 2026",
  "浙江美术馆 展览申报 艺术家 2026",
  "中国美术家网 省级美术家协会 双年展 征稿 2026",
  "美术报 全省 美术作品展 征稿启事 2026",
  "摄影 大展 征稿启事 2026 县 官方",
  "工艺美术 大师 作品展 征集 通知 2026",
  "动画 短片 征集 大赛 评奖 2026",
  "舞台剧 剧本 征集 大赛 报名 2026",
  "地方 文化馆 公益 艺术培训 公益课堂 招募 2026",
  "非遗 技艺 传承人 招募 传习 2026",
  "版画 双年展 征稿通知 2026 协会",
  "书法 楹联 展览 评选 征稿启事 2026",
  "舞蹈 艺术节 编创 征集 报名 2026",
  "音乐 创作 征集 评奖 2026 协会",
  "美术馆 志愿者 招募 公告 2026",
  "公共艺术 雕塑 设计 征集 城市 2026",
  "文创 设计 大赛 作品征集 组委会 通知 2026",
];

const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? Number(args[i + 1]) : null; };
const firstN = getOpt("--first");            // 只跑前 N 个词
const fromN = getOpt("--from") || 0;         // 从第 N 个词开始
const slice = QUERIES.slice(fromN, firstN ? fromN + firstN : undefined);

for (const q of slice) {
  const t0 = Date.now();
  try {
    const res = await fetch(BASE + "?channel=opportunities&q=" + encodeURIComponent(q));
    const j = await res.json();
    const added = Array.isArray(j.added) ? j.added : [];
    const titles = added.map(a => (a.title_zh || a.title || "?").slice(0, 26)).join(" | ");
    process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(0)}s] "${q}" -> +${added.length} probed=${j.probed} cand=${j.candidates}${j.cached ? "(cached)" : ""} :: ${titles}\n`);
  } catch (e) {
    process.stderr.write(`ERR "${q}": ${e.message}\n`);
  }
  await sleep(5000);   // 请求本身很慢(爬+提取),5s 兜底防 IP 限频
}
process.stderr.write(`batch done (${slice.length} queries)\n`);