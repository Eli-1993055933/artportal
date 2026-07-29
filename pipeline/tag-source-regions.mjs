// tag-source-regions.mjs —— 给 sources.json 的信源打上 region_hint(归属哪位区域经理)。
//
// 用途:①/admin 工牌墙显示每位经理的"辖区信源数";②将来信源涨到几百上千条后,
//       每日抓取可按区分片(当值大区那天多抓自己辖区),而不是每天全量硬抓。
//
// 原则(与全站反幻觉同调):**纯程序确定性推导,不调 AI;拿不准就留空。**
//   打错一个归属不会污染内容(region_hint 只影响调度与统计,不进任何对外展示的事实字段),
//   但仍宁可少打不错打——空值一眼可见,错值会被当成已核实。
//
// 判据优先级:
//   ① 地名命中(org_zh / name_zh / notes / domain 里出现 regions.json 的 terms,或下面的省市补充表)
//   ② 顶级域国家码(.jp/.de/.au…)
//   ③ 都不命中 → 留空
//
// 用法:node tag-source-regions.mjs --dry     只看会怎么打,不写盘
//       node tag-source-regions.mjs           写回 sources.json(原子写,先备份 .bak-regions)

import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegions } from "./lib/regions.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, "sources.json");
const DRY = process.argv.includes("--dry");

// 省市补充表:regions.json 的 terms 只列了代表城市,这里把整省/更多地级市补齐。
// 只写"能唯一确定归属"的地名;北上广深杭这类一线城市在 cn-tier1,不重复列。
const CN_EXTRA = {
  "cn-north": ["河北", "山西", "内蒙", "辽宁", "吉林", "黑龙江", "唐山", "保定", "邯郸", "包头", "鞍山", "抚顺", "吉林市", "齐齐哈尔", "承德", "秦皇岛"],
  "cn-east": ["江苏", "浙江", "安徽", "山东", "福建", "镇江", "泰州", "盐城", "淮安", "连云港", "湖州", "衢州", "丽水", "舟山", "芜湖", "蚌埠", "淄博", "威海", "泰安", "莆田", "漳州", "宁德", "三明", "南平"],
  "cn-south": ["广西", "海南", "肇庆", "清远", "韶关", "梅州", "阳江", "茂名", "河源", "揭阳", "北海", "钦州", "梧州", "儋州"],
  "cn-central-west": ["湖北", "湖南", "河南", "江西", "四川", "云南", "贵州", "陕西", "甘肃", "青海", "宁夏", "新疆", "西藏", "宜昌", "襄阳", "株洲", "湘潭", "衡阳", "洛阳", "南阳", "安阳", "赣州", "九江", "绵阳", "自贡", "宜宾", "泸州", "曲靖", "大理州", "六盘水", "咸阳", "宝鸡", "延安", "天水", "酒泉", "喀什", "伊犁", "日喀则"],
  "cn-hkmotw": ["香港", "澳门", "澳門", "台湾", "台灣", "臺灣", "台北", "臺北", "台中", "臺中", "高雄", "台南", "臺南", "新竹", "桃園", "桃园"]
};

// 域名 → 区域经理:名字里不带城市的知名机构,按【所在地这一客观事实】逐条列明。
// 逐条可核对(每条都写了所在地),不是模型猜的;拿不准的一律不列(见文件末尾"故意留空"说明)。
const DOMAIN_REGION = {
  // —— 北京 ——
  "cafa.edu.cn": "cn-tier1",              // 中央美术学院(北京)
  "dsx.cafa.edu.cn": "cn-tier1",          // 中央美院雕塑系(北京)
  "cafamuseum.org": "cn-tier1",           // 中央美院美术馆(北京)
  "namoc.cn": "cn-tier1",                 // 中国美术馆(北京)
  "threeshadows.cn": "cn-tier1",          // 三影堂摄影艺术中心(北京草场地)
  "ccom.edu.cn": "cn-tier1",              // 中央音乐学院(北京)
  "chnmusic.org.cn": "cn-tier1",          // 中国音乐家协会(北京)
  "chinaasc.org.cn": "cn-tier1",          // 中国建筑学会(北京)
  "cnaf.cn": "cn-tier1",                  // 国家艺术基金管理中心(北京)
  "claf.org.cn": "cn-tier1",              // 中国文学艺术基金会(北京)
  "fashion.org.cn": "cn-tier1",           // 中国服装设计师协会(北京)
  "chinafashionweek.org.cn": "cn-tier1",  // 中国国际时装周(北京)
  "cnacs.net.cn": "cn-tier1",             // 中国工艺美术学会(北京)
  "foundertype.com": "cn-tier1",          // 北大方正字库(北京)
  "cphoto.com.cn": "cn-tier1",            // 《中国摄影》/中国摄影家协会(北京)
  // —— 杭州 / 上海 / 广州 / 深圳 ——
  "caa.edu.cn": "cn-tier1",               // 中国美术学院(杭州)
  "di-award.org": "cn-tier1",             // 中国设计智造大奖 DIA(中国美院主办,杭州)
  "cicaf.com": "cn-tier1",                // 中国国际动漫节(杭州)
  "art.ecnu.edu.cn": "cn-tier1",          // 华东师范大学美术学院(上海)
  "johnmooreschina.com": "cn-tier1",      // 约翰·莫尔绘画奖(中国)(上海)
  "ciga.me": "cn-tier1",                  // CiGA 中国独立游戏联盟(上海)
  "cicfcn.com": "cn-tier1",               // 中国国际漫画节 CICF(广州)
  "hxnart.org.cn": "cn-tier1",            // 何香凝美术馆(深圳)
  "wangshikuofoundation.org.cn": "cn-tier1",  // 王式廓艺术基金会(北京)
  // —— 其他中国 ——
  "lumei.edu.cn": "cn-north",             // 鲁迅美术学院(沈阳)
  "mill6chat.org": "cn-hkmotw",           // CHAT 六廠 / 南豐紗廠(香港荃灣)
  "npac-weiwuying.org": "cn-hkmotw",      // 衛武營國家藝術文化中心(高雄)
  "firstfilm.org.cn": "cn-central-west",  // FIRST 青年电影展(西宁)
  // —— 国际(总部所在地)——
  "ars.electronica.art": "intl-central-europe",      // 奥地利电子艺术节(林茨)
  "hnfoundation.com": "intl-central-europe",         // 汉·内夫肯斯基金会(巴塞罗那)
  "asianculturalcouncil.org": "intl-na-east",        // 亚洲文化协会 ACC(纽约)
  "vermontstudiocenter.org": "intl-na-east",         // 佛蒙特工作室中心(佛蒙特)
  "bemiscenter.org": "intl-na-east",                 // Bemis 当代艺术中心(奥马哈)
  "headlands.org": "intl-na-west",                   // Headlands 艺术中心(加州)
  "aestheticamagazine.com": "intl-west-europe",      // Aesthetica 杂志(英国约克)
  "worldpressphoto.org": "intl-west-europe",         // 世界新闻摄影基金会(阿姆斯特丹)
  "futuregenerationartprize.org": "intl-north-east-europe"  // PinchukArtCentre(基辅)
};
// 故意留空(全球性平台,不属于任何一位区域经理,也不该被某位经理"认领"):
//   transartists.org · e-flux.com · artconnect.com · curatorspace.com · chinaresidencies.com

// 顶级域 → 区域经理。只列归属明确的;.com/.org/.net/.edu 等通用域不参与(无法判断国别)。
const TLD_REGION = {
  jp: "intl-east-asia", kr: "intl-east-asia",
  sg: "intl-sea-sa", th: "intl-sea-sa", id: "intl-sea-sa", my: "intl-sea-sa", vn: "intl-sea-sa", ph: "intl-sea-sa", in: "intl-sea-sa",
  uk: "intl-west-europe", fr: "intl-west-europe", nl: "intl-west-europe", be: "intl-west-europe", ie: "intl-west-europe",
  de: "intl-central-europe", at: "intl-central-europe", ch: "intl-central-europe", it: "intl-central-europe",
  es: "intl-central-europe", pt: "intl-central-europe", gr: "intl-central-europe",
  se: "intl-north-east-europe", dk: "intl-north-east-europe", no: "intl-north-east-europe", fi: "intl-north-east-europe",
  is: "intl-north-east-europe", pl: "intl-north-east-europe", cz: "intl-north-east-europe", hu: "intl-north-east-europe",
  ee: "intl-north-east-europe", lv: "intl-north-east-europe", lt: "intl-north-east-europe",
  au: "intl-oceania", nz: "intl-oceania",
  ae: "intl-mena-africa", qa: "intl-mena-africa", sa: "intl-mena-africa", il: "intl-mena-africa",
  tr: "intl-mena-africa", eg: "intl-mena-africa", ng: "intl-mena-africa", ke: "intl-mena-africa", za: "intl-mena-africa",
  br: "intl-latam", mx: "intl-latam", ar: "intl-latam", cl: "intl-latam", pe: "intl-latam", cu: "intl-latam",
  hk: "cn-hkmotw", mo: "cn-hkmotw", tw: "cn-hkmotw"
};

function tldOf(domain) {
  const p = String(domain || "").toLowerCase().split(".").filter(Boolean);
  if (p.length < 2) return null;
  const last = p[p.length - 1];
  // co.uk / org.uk / com.au 等两段国别域:取最后一段
  return last;
}

async function main() {
  const cfg = await loadRegions();
  // 地名 → 经理 id(来自 regions.json 的 terms + 上面的补充表)。长地名优先匹配,避免"台中"被"台"截胡。
  const nameMap = [];
  for (const m of cfg.managers) for (const t of m.terms) if (t && t.length >= 2) nameMap.push([t, m.id]);
  for (const [id, arr] of Object.entries(CN_EXTRA)) for (const t of arr) nameMap.push([t, id]);
  nameMap.sort((a, b) => b[0].length - a[0].length);

  const raw = JSON.parse(await readFile(SRC, "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw.sources || []);
  const before = arr.filter(s => s.region_hint).length;
  const stats = {}, byName = [], byTld = [], unresolved = [];

  for (const s of arr) {
    // 已有【具体】归属就不动;旧的粗标 "intl"/"cn"/"tw" 视为待细化(它们不是经理 id)
    const cur = s.region_hint;
    if (cur && cfg.managers.some(m => m.id === cur)) { stats[cur] = (stats[cur] || 0) + 1; continue; }

    const hay = [s.org_zh, s.name_zh, s.notes, s.domain, s.url].filter(Boolean).join(" ").toLowerCase();
    let hit = null, why = null;
    // ⓪ 域名事实表优先(名字不带城市的知名机构),它比地名模糊匹配更准
    const dom = String(s.domain || "").toLowerCase().replace(/^www\./, "");
    if (DOMAIN_REGION[dom]) { hit = DOMAIN_REGION[dom]; why = dom; }
    if (!hit) for (const [term, id] of nameMap) {
      if (hay.indexOf(String(term).toLowerCase()) !== -1) { hit = id; why = term; break; }
    }
    if (!hit) {
      const t = tldOf(s.domain);
      if (t === "cn") { hit = null; }                       // .cn 只说明在中国,定不到具体大区 → 交给地名判据,判不出就留空
      else if (t && TLD_REGION[t]) { hit = TLD_REGION[t]; why = "." + t; }
    }
    if (hit) {
      s.region_hint = hit;
      stats[hit] = (stats[hit] || 0) + 1;
      (why && why.startsWith(".") ? byTld : byName).push(`${(s.org_zh || s.name_zh || s.domain).slice(0, 20)} → ${hit} (${why})`);
    } else {
      delete s.region_hint;                                  // 旧的粗标 intl/cn 清掉,空着比错着强
      unresolved.push((s.org_zh || s.name_zh || s.domain).slice(0, 26) + " | " + s.domain);
    }
  }

  console.log(`信源总数 ${arr.length};原有归属 ${before} 条 → 现有归属 ${arr.length - unresolved.length} 条,未判定 ${unresolved.length} 条`);
  console.log("\n按经理分布:");
  for (const m of cfg.managers) console.log("  " + m.zh.padEnd(14) + (stats[m.id] || 0));
  console.log(`\n靠地名判定 ${byName.length} 条,靠顶级域判定 ${byTld.length} 条`);
  console.log("\n地名判定样例:"); byName.slice(0, 12).forEach(x => console.log("  " + x));
  console.log("\n顶级域判定样例:"); byTld.slice(0, 8).forEach(x => console.log("  " + x));
  console.log(`\n未判定(留空,不猜)${unresolved.length} 条,样例:`); unresolved.slice(0, 12).forEach(x => console.log("  " + x));

  if (DRY) { console.log("\n[--dry] 未写盘。"); return; }
  await copyFile(SRC, SRC + ".bak-regions");
  const tmp = SRC + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(raw, null, 2), "utf8");
  await rename(tmp, SRC);
  console.log("\n已写回 sources.json(备份 sources.json.bak-regions)");
}
main().catch(e => { console.error("失败:", e); process.exit(1); });
