// geo-reconcile.mjs —— 逐条核对机会条目的真实地点,写入显式坐标。
//
// 背景(2026-10-08 用户反馈):"很多已收录机会在地球上的坐标有问题"。
// 根因:前端 globe-data.js 的 locate() 只认 city_zh/country_zh 两个自由文本字段,
//   ① city_zh="未知" 的 766 条里,绝大多数中国大陆条目一律落到【国家地理中心】(104,35.5,甘肃荒漠),
//      美国条目落到 (-98,39),地图上出现巨大"假堆叠点";
//   ② city_zh 存英文城市名 / 带"市"后缀 / 干脆是国家名,与 CITY 字典对不上 → 静默掉级;
//   ③ 线上/全球事件被赋 (0,0)(几内亚湾海面)。
//
// 本脚本【只用条目自己已抓到的原文文本 + 本地权威行政区划数据】重新判定地点。
// 反幻觉红线不变,且【宁缺毋滥】:只有当城市/省名确实出现在该条目文本里(且有强约束,
// 见下)、或命中【已知机构驻地表】、或回落到【该国地理中心】时才赋坐标,并如实标注精度
//   (城市 / 省会 / 区县 / 州中心 / 机构驻地 / 国家 / 线上)。绝不凭空编造地点;
// 拿不准就回落到上一级(宁可放国家中心,也不放一个错误城市)。
//
// 用法:
//   node geo-reconcile.mjs                     # 试跑(dry),只打印统计与样本
//   node geo-reconcile.mjs --apply             # 写回 site/data/opportunities.json
//   node geo-reconcile.mjs --apply --file <绝对或相对路径>
//
// 写入字段: geo_ll:[lng,lat]  geo_prec  geo_src(命中规则)  geo_ev(命中的原文片段)
//           并把 city_zh/country_zh 归一成规范中文名(供显示/筛选)。

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const DATA_FILE = isAbsolute(opt("--file", "")) ? opt("--file") : join(ROOT, opt("--file", "site/data/opportunities.json"));

// ---------------------------------------------------------------- 1. 本地权威地理数据
// 1a) 前端已有的手写字典(CITY/COUNTRY/NAME_ZH)——直接复用,不重复维护
const sb = { window: {} };
vm.createContext(sb);
vm.runInContext(readFileSync(join(ROOT, "site/js/globe-data.js"), "utf8"), sb);
const G = sb.window.GLOBE_DATA;
const CITY0 = G.CITY, COUNTRY = G.COUNTRY, NAME_ZH = G.NAME_ZH;

// 1b) 中国行政区划(site/data/geo/cn/*.json):省/市/区县 + 官方 center 坐标
const cnProv = new Map();     // 全名(含后缀) -> {ll, ad}
const cnCity = new Map();
const cnDistRaw = new Map();  // 先收集,后剔除同名歧义(如"普陀区"上海/舟山各一)
const CN_DIR = join(ROOT, "site/data/geo/cn");
for (const f of readdirSync(CN_DIR)) {
  if (!f.endsWith(".json")) continue;
  const j = JSON.parse(readFileSync(join(CN_DIR, f), "utf8"));
  for (const ft of j.features || []) {
    const p = ft.properties;
    if (!p || !p.name || !p.center) continue;
    const rec = { ll: p.center, ad: p.adcode };
    if (p.level === "province") cnProv.set(p.name, rec);
    else if (p.level === "city") cnCity.set(p.name, rec);
    else if (p.level === "district") { if (!cnDistRaw.has(p.name)) cnDistRaw.set(p.name, []); cnDistRaw.get(p.name).push(rec); }
  }
}
// 同名区县(≥2 处)一律丢弃,避免"普陀区→舟山"这类误判
const cnDist = new Map();
for (const [name, arr] of cnDistRaw) if (arr.length === 1) cnDist.set(name, arr[0]);
const shortCN = n => n.replace(/(特别行政区|自治区|自治州|地区|盟|市|省|区|县|旗)$/, "");
function buildShortMap(full) {
  const m = new Map();
  for (const k of full.keys()) {
    const s = shortCN(k);
    if (s === k || s.length < 2) continue;
    m.set(s, m.has(s) ? null : k);   // 冲突置 null(歧义,不参与匹配)
  }
  return m;
}
const cnProvShort = buildShortMap(cnProv);
const cnCityShort = buildShortMap(cnCity);

const PROV_CAPITAL = {
  "北京市": "北京市", "天津市": "天津市", "上海市": "上海市", "重庆市": "重庆市",
  "河北省": "石家庄市", "山西省": "太原市", "内蒙古自治区": "呼和浩特市", "辽宁省": "沈阳市",
  "吉林省": "长春市", "黑龙江省": "哈尔滨市", "江苏省": "南京市", "浙江省": "杭州市",
  "安徽省": "合肥市", "福建省": "福州市", "江西省": "南昌市", "山东省": "济南市",
  "河南省": "郑州市", "湖北省": "武汉市", "湖南省": "长沙市", "广东省": "广州市",
  "广西壮族自治区": "南宁市", "海南省": "海口市", "四川省": "成都市", "贵州省": "贵阳市",
  "云南省": "昆明市", "西藏自治区": "拉萨市", "陕西省": "西安市", "甘肃省": "兰州市",
  "青海省": "西宁市", "宁夏回族自治区": "银川市", "新疆维吾尔自治区": "乌鲁木齐市",
  "台湾省": "台北市", "香港特别行政区": "香港特别行政区", "澳门特别行政区": "澳门特别行政区"
};

// 1c) 世界一级行政区(site/data/geo/world/*.json)
// 强约束:仅用【中文名(name_zh)】做匹配,英文名一律不用(极易误伤,如 Texas/"Centre"/"Southern")。
const GENERIC = /^(中部|南部|北部|东部|西部|中央|大区|地区|区域|省|州|县|区|市|岛|半岛|沿海|内陆|首都|都会)$/;
const worldByZh = new Map();   // 中文名 -> {ll, admin}
const worldByName = new Map(); // 英文名(仅用于结构化的 city_zh 字段) -> {ll, admin}
const worldByAdmin = new Map();// 国名(英文) -> [{name, zh, ll}](限英文名,供"已知国家"内匹配)
for (const f of readdirSync(join(ROOT, "site/data/geo/world"))) {
  if (!f.endsWith(".json")) continue;
  const j = JSON.parse(readFileSync(join(ROOT, "site/data/geo/world", f), "utf8"));
  for (const ft of j.features || []) {
    const p = ft.properties;
    if (!p || p.longitude == null || p.latitude == null) continue;
    if (p.name_zh) {
      const zh = String(p.name_zh).trim();
      if (zh.length >= 2 && !GENERIC.test(zh) && !worldByZh.has(zh)) worldByZh.set(zh, { ll: [p.longitude, p.latitude], admin: p.admin || "" });
    }
    if (p.name) {
      const en = String(p.name).trim();
      if (en.length >= 4 && !worldByName.has(en)) worldByName.set(en, { ll: [p.longitude, p.latitude], admin: p.admin || "" });
      if (en.length >= 4 && p.admin) {
        if (!worldByAdmin.has(p.admin)) worldByAdmin.set(p.admin, []);
        worldByAdmin.get(p.admin).push({ name: en, zh: p.name_zh || "", ll: [p.longitude, p.latitude] });
      }
    }
  }
}
const EN2ZH = { ...NAME_ZH };
Object.assign(EN2ZH, {
  "China": "中国", "United States": "美国", "USA": "美国", "United Kingdom": "英国",
  "South Korea": "韩国", "Korea": "韩国", "Czech Republic": "捷克", "Czechia": "捷克",
  "Russia": "俄罗斯", "Netherlands": "荷兰", "Germany": "德国", "France": "法国",
  "Italy": "意大利", "Spain": "西班牙", "Portugal": "葡萄牙", "Greece": "希腊",
  "Switzerland": "瑞士", "Austria": "奥地利", "Belgium": "比利时", "Denmark": "丹麦",
  "Sweden": "瑞典", "Norway": "挪威", "Finland": "芬兰", "Poland": "波兰",
  "Ireland": "爱尔兰", "Iceland": "冰岛", "Canada": "加拿大", "Australia": "澳大利亚",
  "New Zealand": "新西兰", "Japan": "日本", "India": "印度", "Brazil": "巴西",
  "Mexico": "墨西哥", "Argentina": "阿根廷", "Chile": "智利", "Peru": "秘鲁",
  "Colombia": "哥伦比亚", "South Africa": "南非", "Egypt": "埃及", "Turkey": "土耳其",
  "Israel": "以色列", "United Arab Emirates": "阿联酋", "Singapore": "新加坡",
  "Malaysia": "马来西亚", "Thailand": "泰国", "Vietnam": "越南", "Indonesia": "印度尼西亚",
  "Philippines": "菲律宾", "Saudi Arabia": "沙特阿拉伯", "Qatar": "卡塔尔",
  "Luxembourg": "卢森堡", "Slovenia": "斯洛文尼亚", "Croatia": "克罗地亚",
  "Serbia": "塞尔维亚", "Bulgaria": "保加利亚", "Romania": "罗马尼亚", "Hungary": "匈牙利",
  "Ukraine": "乌克兰", "Lithuania": "立陶宛", "Latvia": "拉脱维亚", "Estonia": "爱沙尼亚",
  "Cyprus": "塞浦路斯", "Malta": "马耳他", "Morocco": "摩洛哥", "Kenya": "肯尼亚",
  "Nigeria": "尼日利亚", "Ghana": "加纳", "Ethiopia": "埃塞俄比亚", "Tanzania": "坦桑尼亚",
  "Uganda": "乌干达", "Senegal": "塞内加尔", "Tunisia": "突尼斯", "Algeria": "阿尔及利亚",
  "Pakistan": "巴基斯坦", "Bangladesh": "孟加拉国", "Sri Lanka": "斯里兰卡", "Nepal": "尼泊尔",
  "Kazakhstan": "哈萨克斯坦", "Georgia": "格鲁吉亚", "Armenia": "亚美尼亚",
  "Azerbaijan": "阿塞拜疆", "Uzbekistan": "乌兹别克斯坦", "Mongolia": "蒙古",
  "Ecuador": "厄瓜多尔", "Uruguay": "乌拉圭", "Paraguay": "巴拉圭", "Bolivia": "玻利维亚",
  "Venezuela": "委内瑞拉", "Costa Rica": "哥斯达黎加", "Panama": "巴拿马", "Cuba": "古巴",
  "Jamaica": "牙买加", "Puerto Rico": "波多黎各", "Belarus": "白俄罗斯",
  "United States of America": "美国", "W. Sahara": "西撒哈拉", "Dem. Rep. Congo": "刚果(金)"
});
const ZH2EN = {};
for (const [en, zh] of Object.entries(EN2ZH)) if (!ZH2EN[zh]) ZH2EN[zh] = en;

// 国家名归一:收录数据里 country_zh 常存英文/"城市, 国家"/州缩写等自由文本,
// 归一到标准中文国名后,才能参与后续"国家中心"回落与"该国一级行政区"匹配。
const EXTRA_EN2ZH = { "Spain": "西班牙", "Zambia": "赞比亚", "Guatemala": "危地马拉",
  "Kanada": "加拿大", "España": "西班牙", "Espana": "西班牙", "Deutschland": "德国", "International": "全球" };
const US_STATE_ABBR = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"]);
function normCountry(s) {
  if (!s) return null;
  const t = String(s).replace(/^#/, "").trim();
  if (COUNTRY[t]) return t;
  if (EN2ZH[t]) return EN2ZH[t];
  if (EXTRA_EN2ZH[t]) return EXTRA_EN2ZH[t];
  const parts = t.split(",").map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (COUNTRY[last]) return last;
    if (EN2ZH[last]) return EN2ZH[last];
    if (EXTRA_EN2ZH[last]) return EXTRA_EN2ZH[last];
  }
  if (US_STATE_ABBR.has(t.toUpperCase())) return "美国";
  if (/^澳門|^澳门/.test(t)) return "中国澳门";
  return null;
}

// 1d) 已知机构驻地表(公开注册地)。命中机构名即用,标注"机构驻地"。
const ORG_HQ = [
  [/(中国美术家协会|中国美协|中国书法家协会|中国书协|中国摄影家协会|中国摄协|民族画报社|中国国家画院|中国美术馆|中央美术学院|中国艺术研究院|中国文联|中国文学艺术界联合会)/, "北京市", "北京"],
  [/(中国美术学院|浙江美术馆|西泠印社)/, "杭州市", "杭州"],
  [/(上海当代艺术博物馆|中华艺术宫|上海美术馆)/, "上海市", "上海"],
  [/(广东美术馆|广州美术学院)/, "广州市", "广州"],
  [/(深圳美术馆|关山月美术馆)/, "深圳市", "深圳"],
  [/(四川美术学院)/, "重庆市", "重庆"],
  [/(湖北美术馆|湖北省美术院|武汉美术馆)/, "武汉市", "武汉"],
  [/(西安美术学院|陕西省美术博物馆)/, "西安市", "西安"],
  [/(江苏省美术馆|江苏省国画院|南京艺术学院)/, "南京市", "南京"],
  [/(山东美术馆|山东艺术学院)/, "济南市", "济南"],
  [/(河南省美术馆|河南省美术家协会)/, "郑州市", "郑州"],
  [/(天津美术学院|天津美术馆)/, "天津市", "天津"],
  [/(辽宁省博物馆|辽宁省美术家协会)/, "沈阳市", "沈阳"],
  [/(黑龙江省文学艺术界联合会|黑龙江省文联|黑龙江省美术家协会)/, "哈尔滨市", "哈尔滨"],
  [/(吉林省文学艺术界联合会|吉林省文联|吉林省美术家协会)/, "长春市", "长春"],
  [/(河北省文学艺术界联合会|河北省文联|河北省美术家协会)/, "石家庄市", "石家庄"],
  [/(山西省文学艺术界联合会|山西省文联|山西省美术家协会)/, "太原市", "太原"],
  [/(安徽省文学艺术界联合会|安徽省文联|安徽省美术家协会)/, "合肥市", "合肥"],
  [/(福建省文学艺术界联合会|福建省文联|福建省美术家协会)/, "福州市", "福州"],
  [/(江西省文学艺术界联合会|江西省文联|江西省美术家协会)/, "南昌市", "南昌"],
  [/(湖南省文学艺术界联合会|湖南省文联|湖南省美术家协会)/, "长沙市", "长沙"],
  [/(云南省文学艺术界联合会|云南省文联)/, "昆明市", "昆明"],
  [/(贵州省文学艺术界联合会|贵州省文联)/, "贵阳市", "贵阳"],
  [/(甘肃省文学艺术界联合会|甘肃省文联)/, "兰州市", "兰州"],
  [/(青海省文学艺术界联合会|青海省文联)/, "西宁市", "西宁"],
  [/(海南省文学艺术界联合会|海南省文联)/, "海口市", "海口"],
  [/(新疆维吾尔自治区文学艺术界联合会|新疆美术家协会)/, "乌鲁木齐市", "乌鲁木齐"],
  [/(内蒙古自治区文学艺术界联合会|内蒙古美术家协会)/, "呼和浩特市", "呼和浩特"],
  [/(广西壮族自治区文学艺术界联合会|广西美术家协会)/, "南宁市", "南宁"],
  [/(宁夏回族自治区文学艺术界联合会|宁夏美术家协会)/, "银川市", "银川"],
  [/(西藏自治区文学艺术界联合会|西藏美术家协会)/, "拉萨市", "拉萨"],
  [/(MoMA|Museum of Modern Art|大都会艺术博物馆|Metropolitan Museum)/i, null, "纽约"],
  [/(Tate Modern|Tate Britain|泰特现代|泰特美术馆|Serpentine|蛇形画廊|Royal Academy of Arts|皇家艺术学院)/i, null, "伦敦"],
  [/(Centre Pompidou|蓬皮杜|Louvre|卢浮宫|Musée d'Orsay|奥赛博物馆)/i, null, "巴黎"],
  [/(Uffizi|乌菲兹|La Biennale|威尼斯双年展)/i, null, "威尼斯"],
  [/(documenta|卡塞尔文献展)/i, null, "卡塞尔"]
];

// ---------------------------------------------------------------- 2. 文本匹配
// 中国城市名黑名单:2 字常见词,极易与普通词汇冲突
const CN_BLACKLIST = new Set(["东方", "中山", "大同", "朝阳", "和平", "胜利", "团结", "民主",
  "光明", "前进", "新兴", "向阳", "三明", "双阳", "白云", "青山", "长安", "长宁", "通州"]);

// 中国:只认【全名(带后缀)】或【唯一的短名且不在黑名单】;限定在 org / title 文本内。
function matchCN(text) {
  if (!text) return null;
  let best = null;
  const consider = h => { if (h && (!best || h.k.length > best.k.length)) best = h; };
  for (const [k, ad] of cnCity) if (k.length >= 3 && text.includes(k)) consider({ kind: "city", k, ll: ad.ll, name: shortCN(k) });
  for (const [s, full] of cnCityShort) if (full && s.length >= 2 && !CN_BLACKLIST.has(s) && text.includes(s)) consider({ kind: "city", k: s, ll: cnCity.get(full).ll, name: s });
  if (best) return best;
  for (const [k, ad] of cnDist) if (k.length >= 3 && text.includes(k)) return { kind: "district", k, ll: ad.ll, name: shortCN(k) };
  for (const [k, ad] of cnProv) if (k.length >= 3 && text.includes(k)) {
    const cap = PROV_CAPITAL[k], ll = cap && cnCity.get(cap) ? cnCity.get(cap).ll : ad.ll;
    return { kind: "province", k, ll, name: shortCN(k) };
  }
  for (const [s, full] of cnProvShort) if (full && s.length >= 2 && text.includes(s)) {
    const cap = PROV_CAPITAL[full], ll = cap && cnCity.get(cap) ? cnCity.get(cap).ll : cnProv.get(full).ll;
    return { kind: "province", k: s, ll, name: shortCN(full) };
  }
  return null;
}

// 世界:只认【中文名】,且必须 ≥2 字(避免英文泛词误伤)
function matchWorld(text) {
  if (!text) return null;
  let best = null;
  for (const [zh, w] of worldByZh) if (zh.length >= 2 && text.includes(zh)) {
    if (!best || zh.length > best.k.length) best = { k: zh, ll: w.ll, zh, admin: w.admin };
  }
  return best;
}

// 已知国家内,按该国一级行政区英文名匹配(限制在该国 → 误伤可控,如"California""Bavaria")
function matchWorldInCountry(text, countryZh) {
  if (!text || !countryZh) return null;
  const en = ZH2EN[countryZh];
  if (!en) return null;
  const subs = worldByAdmin.get(en);
  if (!subs) return null;
  let best = null;
  for (const s of subs) {
    const re = new RegExp("\\b" + s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
    if (re.test(text) && (!best || s.name.length > best.k.length)) best = { k: s.name, ll: s.ll, zh: s.zh, admin: en };
  }
  return best;
}

function countryFromDomain(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (/\.cn$/.test(h)) return "中国";
    if (/\.uk$/.test(h)) return "英国";
    if (/\.jp$/.test(h)) return "日本";
    if (/\.de$/.test(h)) return "德国";
    if (/\.fr$/.test(h)) return "法国";
    if (/\.it$/.test(h)) return "意大利";
    if (/\.es$/.test(h)) return "西班牙";
    if (/\.nl$/.test(h)) return "荷兰";
    if (/\.kr$/.test(h)) return "韩国";
    if (/\.au$/.test(h)) return "澳大利亚";
    if (/\.ca$/.test(h)) return "加拿大";
    if (/\.hk$/.test(h)) return "中国香港";
    if (/\.tw$/.test(h)) return "中国台湾";
  } catch (e) {}
  return null;
}

const ONLINE_RE = /(线上展|线上征集|线上展览|线上驻留|网络展|网络征集|虚拟展|虚拟驻留|数字驻留|云端展)/;
const ONLINE_EN = /\b(virtual|online)\s+(exhibition|residency|open\s?call|show|program|studio\s?visit)\b/i;

// ---------------------------------------------------------------- 3. 判定单条
function reconcile(o) {
  const org = [o.org_zh, o.org_en].filter(Boolean).join(" | ");
  const title = [o.title_zh, o.title_en].filter(Boolean).join(" | ");
  const sum = [o.summary_zh, o.summary_en].filter(Boolean).join(" | ");
  const ck0raw = o.country_zh && o.country_zh !== "未知" ? o.country_zh : "";
  const ck0 = COUNTRY[ck0raw] ? ck0raw : (normCountry(ck0raw) || ck0raw);  // 英文/州缩写等归一
  const isCN = !ck0 || ck0 === "中国";

  const c0 = o.city_zh && o.city_zh !== "未知" ? o.city_zh : "";
  // 1) 已有 city_zh 直接对上前端字典
  if (c0 && CITY0[c0]) return { ll: CITY0[c0], prec: "城市", src: "existing-city", ev: c0, city: c0 };
  // 2) 已有 city_zh 是"北京市/武汉市"这类全名,或是英文城市名 → 归一(结构化字段,低误伤)
  if (c0 && !COUNTRY[c0]) {
    const norm = (isCN ? matchCN(c0) : null) || worldByZh.get(c0) || worldByName.get(c0);
    if (norm) return { ll: norm.ll, prec: norm.kind ? (norm.kind === "province" ? "省会" : "城市") : "州中心", src: "existing-city-norm", ev: norm.k || c0, city: norm.name || norm.zh || c0, country: norm.kind ? "中国" : (EN2ZH[norm.admin] || undefined) };
  }
  // 3) 机构驻地表
  for (const [re, cityFull, cityName] of ORG_HQ) {
    if (re.test(org) || re.test(title)) {
      const m = (org.match(re) || title.match(re) || [""])[0];
      if (cityFull && cnCity.get(cityFull)) return { ll: cnCity.get(cityFull).ll, prec: "机构驻地", src: "org-hq", ev: m, city: cityName, country: "中国" };
      if (CITY0[cityName]) return { ll: CITY0[cityName], prec: "机构驻地", src: "org-hq", ev: m, city: cityName };
    }
  }
  // 4) 文本里的中国省市名:org 与 title 都允许(全名优先,短名受黑名单约束);
  //    非中国记录(已知外国)直接跳过,避免"德州→Texas""达州→Dallas"类误伤
  if (isCN) {
    const hit = matchCN(org) || matchCN(title);
    if (hit) return { ll: hit.ll, prec: hit.kind === "province" ? "省会" : (hit.kind === "district" ? "区县" : "城市"), src: "text-cn", ev: hit.k, city: hit.name, country: "中国" };
  }
  // 5) 文本里的世界行政区中文名(org/title,不用 summary)
  if (!isCN) {
    const w = matchWorld(org) || matchWorld(title);
    if (w) {
      const country = EN2ZH[w.admin] || ck0 || "未知";
      return { ll: w.ll, prec: "州中心", src: "text-world", ev: w.k, country, city: undefined };
    }
  }
  // 5b) 已知国家 → 该国一级行政区英文名(限定在该国内,误伤可控;如 "California"/"Bavaria")
  if (!isCN && ck0) {
    const w = matchWorldInCountry(org, ck0) || matchWorldInCountry(title, ck0);
    if (w) return { ll: w.ll, prec: "州中心", src: "text-world-country", ev: w.k, country: ck0, city: undefined };
  }
  // 6) 明确标注"全球/线上"的 → 不落点(避免 (0,0) 假堆叠);
  //    其余一律优先落国家中心,只有连国家都没有时才用"线上"文案做兜底判定。
  if (ck0 === "全球" || c0 === "线上")
    return { ll: null, prec: "线上", src: "online", ev: ck0 || "线上", city: c0 || "线上", country: "全球" };
  // 7) 已有国家 → 国家中心
  if (ck0 && COUNTRY[ck0]) return { ll: COUNTRY[ck0], prec: "国家", src: "country-center", ev: ck0, country: ck0 };
  // 8) 域名 TLD 粗判国家
  const cd = countryFromDomain(o.url || o.source_url || "");
  if (cd && COUNTRY[cd]) return { ll: COUNTRY[cd], prec: "国家", src: "tld", ev: cd, country: cd, city: "未知" };
  // 9) 线上文案兜底(只看标题,避免正文提一句"线上"就误判)
  if (ONLINE_RE.test(title) || ONLINE_EN.test(title))
    return { ll: null, prec: "线上", src: "online", ev: "线上", city: "线上", country: "全球" };
  return { ll: null, prec: "未知", src: "unresolved", ev: "" };
}

// ---------------------------------------------------------------- 4. 主流程
function main() {
  const raw = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  const wrap = !Array.isArray(raw);
  const list = Array.isArray(raw) ? raw : (raw.opportunities || raw.items || []);
  const stat = {}, statPrec = {};
  let changed = 0, withLL = 0;
  const samples = [];
  for (const o of list) {
    const r = reconcile(o);
    stat[r.src] = (stat[r.src] || 0) + 1;
    statPrec[r.prec] = (statPrec[r.prec] || 0) + 1;
    if (r.ll) withLL++;
    const prev = o.geo_ll ? o.geo_ll.join(",") : "", next = r.ll ? r.ll.join(",") : "";
    if (prev !== next || o.geo_prec !== r.prec) changed++;
    if (samples.length < 12 && !r.ll) samples.push(`[${r.prec}] ${(o.org_zh || "").slice(0, 16)} | ${(o.title_zh || o.title_en || "").slice(0, 34)}`);
    if (APPLY) {
      o.geo_ll = r.ll || null;
      o.geo_prec = r.prec;
      o.geo_src = r.src;
      o.geo_ev = r.ev || null;
      if (r.city) o.city_zh = r.city;
      if (r.country) o.country_zh = r.country;
    }
  }
  console.log("文件:", DATA_FILE, " 条目:", list.length, APPLY ? "(已写回)" : "(dry)");
  console.log("落点精度:", JSON.stringify(statPrec));
  console.log("判定规则:", JSON.stringify(stat));
  console.log("可落点:", withLL, "  无坐标:", list.length - withLL, "  变化:", changed);
  console.log("--- 仍无坐标样本 ---");
  samples.forEach(s => console.log("  " + s));
  if (APPLY) {
    if (wrap) { raw.opportunities = list; writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2)); }
    else writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
    console.log("已写回。");
  }
}

main();