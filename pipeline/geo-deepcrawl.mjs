// geo-deepcrawl.mjs —— 对 geo-reconcile 仍判不出的"未知"条目,【逐个打开其网页】判断真实地点。
//
// 背景(2026-10-08 用户反馈第二轮):"还有好多的艺术机会,位置是未知,你要去点开他们的网页主页
//   判断这个项目究竟是属于什么地方的"。这些条目 org/title/summary 里确实没有地点信息(多为国际
//   平台 ArtConnect / ArtRabbit / TheArtList / ACA 等的聚合页),只能去抓原页面。
//
// 做的事:
//   1. 取 official_url 与 url(去重)逐个抓 HTML(≤14s 超时、IPv4 优先、并发 6、结果缓存)。
//   2. 从页面里抽地点线索:
//      a) 结构化字段:许多平台(Next.js/Nuxt)把地点塞在页面内嵌 JSON 里,如
//         {"country":"GB","city":"London"} —— 正则(容忍 \" 转义)取首个 city/country/region/state。
//      b) 可见正文 + 结构化线索里,用本地权威字典匹配中国省市 / 世界行政区中文名 / 英文国名。
//      c) 以上都拿不到 → 交给免费大模型(extractGlmFree)从正文里抽 国家/城市/地区 + 原文证据。
//   3. 坐标映射:中国省市字典 → 世界行政区中心 → 世界城市表 → 国家中心。精度如实标注。
//   4. 反幻觉:LLM 给的 evidence 必须是所提供文本的子串(空白归一后),否则整条作废;值本身
//      也须是页面文本里出现过的地方名。
//
// 用法:
//   node geo-deepcrawl.mjs --limit 12        # 小样本试跑(dry,不写盘),先验精度
//   node geo-deepcrawl.mjs --apply           # 全量处理并写回 site/data/opportunities.json
//   node geo-deepcrawl.mjs --apply --limit 50
//   node geo-deepcrawl.mjs --apply --only artconnect.com     # 只跑某域名
//   环境:CRAWL_CONC(并发,默认6) CRAWL_TIMEOUT(ms,默认14000) NO_LLM=1(只用本地字典,不调大模型)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import dns from "node:dns";
import { extractGlmFree } from "./lib/extract.mjs";
import {
  ROOT, CITY0, COUNTRY, matchCN, matchWorldInCountry, countryFromDomain,
  normCountry, EN2ZH, ZH2EN, worldByName, worldByZh
} from "./geo-reconcile.mjs";

dns.setDefaultResultOrder("ipv4first");

const __dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = Number(opt("--limit", "0")) || 0;
const ONLY = opt("--only", "");
const NO_LLM = !!process.env.NO_LLM;
const CONC = Number(process.env.CRAWL_CONC || 6);
const TIMEOUT = Number(process.env.CRAWL_TIMEOUT || 14000);
const DATA_FILE = isAbsolute(opt("--file", "")) ? opt("--file") : join(ROOT, opt("--file", "site/data/opportunities.json"));
const CACHE_FILE = join(__dir, "state", "geo-deepcrawl-cache.json");

// 载入 pipeline/.env(与 discover-sources.mjs 同一套轻量做法,避免额外依赖)
for (const p of [join(__dir, ".env"), join(ROOT, ".env")]) {
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
    }
  } catch (e) { /* 无 .env 则跳过 */ }
}

// ---------------------------------------------------------------- 世界城市坐标表
// 平台页面多为英文城市名;本地数据只有中国区划与世界一级行政区,故补一张常见艺术城市表。
// 每项:[中文名, 经度, 纬度, 所属中文国名]。国名用于"由城市反推国家"。
const WORLD_CITY = {
  "London": ["伦敦", -0.13, 51.51, "英国"], "Paris": ["巴黎", 2.35, 48.86, "法国"], "Berlin": ["柏林", 13.40, 52.52, "德国"],
  "New York": ["纽约", -74.01, 40.71, "美国"], "Los Angeles": ["洛杉矶", -118.24, 34.05, "美国"], "Chicago": ["芝加哥", -87.63, 41.88, "美国"],
  "San Francisco": ["旧金山", -122.42, 37.77, "美国"], "Boston": ["波士顿", -71.06, 42.36, "美国"], "Seattle": ["西雅图", -122.33, 47.61, "美国"],
  "Portland": ["波特兰", -122.68, 45.52, "美国"], "Austin": ["奥斯汀", -97.74, 30.27, "美国"], "Miami": ["迈阿密", -80.19, 25.76, "美国"],
  "Houston": ["休斯顿", -95.37, 29.76, "美国"], "Denver": ["丹佛", -104.99, 39.74, "美国"], "Atlanta": ["亚特兰大", -84.39, 33.75, "美国"],
  "Philadelphia": ["费城", -75.17, 39.95, "美国"], "Washington": ["华盛顿", -77.04, 38.91, "美国"], "Detroit": ["底特律", -83.05, 42.33, "美国"],
  "Minneapolis": ["明尼阿波利斯", -93.27, 44.98, "美国"], "Phoenix": ["凤凰城", -112.07, 33.45, "美国"], "Toronto": ["多伦多", -79.35, 43.65, "加拿大"],
  "Vancouver": ["温哥华", -123.12, 49.28, "加拿大"], "Montreal": ["蒙特利尔", -73.57, 45.50, "加拿大"], "Ottawa": ["渥太华", -75.70, 45.42, "加拿大"],
  "Sydney": ["悉尼", 151.21, -33.87, "澳大利亚"], "Melbourne": ["墨尔本", 144.96, -37.81, "澳大利亚"], "Brisbane": ["布里斯班", 153.02, -27.47, "澳大利亚"],
  "Perth": ["珀斯", 115.86, -31.95, "澳大利亚"], "Auckland": ["奥克兰", 174.76, -36.85, "新西兰"], "Wellington": ["惠灵顿", 174.78, -41.31, "新西兰"],
  "Tokyo": ["东京", 139.69, 35.69, "日本"], "Osaka": ["大阪", 135.50, 34.69, "日本"], "Kyoto": ["京都", 135.77, 35.01, "日本"],
  "Seoul": ["首尔", 126.98, 37.57, "韩国"], "Taipei": ["台北", 121.57, 25.03, "中国台湾"], "Hong Kong": ["香港", 114.17, 22.32, "中国香港"],
  "Singapore": ["新加坡", 103.82, 1.35, "新加坡"], "Bangkok": ["曼谷", 100.50, 13.76, "泰国"], "Jakarta": ["雅加达", 106.85, -6.21, "印度尼西亚"],
  "Amsterdam": ["阿姆斯特丹", 4.90, 52.37, "荷兰"], "Rotterdam": ["鹿特丹", 4.48, 51.92, "荷兰"], "Brussels": ["布鲁塞尔", 4.35, 50.85, "比利时"],
  "Vienna": ["维也纳", 16.37, 48.21, "奥地利"], "Zurich": ["苏黎世", 8.54, 47.37, "瑞士"], "Basel": ["巴塞尔", 7.59, 47.56, "瑞士"],
  "Geneva": ["日内瓦", 6.14, 46.20, "瑞士"], "Munich": ["慕尼黑", 11.58, 48.14, "德国"], "Hamburg": ["汉堡", 9.99, 53.55, "德国"],
  "Cologne": ["科隆", 6.96, 50.94, "德国"], "Frankfurt": ["法兰克福", 8.68, 50.11, "德国"], "Dresden": ["德累斯顿", 13.74, 51.05, "德国"],
  "Rome": ["罗马", 12.50, 41.90, "意大利"], "Milan": ["米兰", 9.19, 45.46, "意大利"], "Venice": ["威尼斯", 12.34, 45.44, "意大利"],
  "Florence": ["佛罗伦萨", 11.26, 43.77, "意大利"], "Turin": ["都灵", 7.69, 45.07, "意大利"], "Naples": ["那不勒斯", 14.27, 40.85, "意大利"],
  "Madrid": ["马德里", -3.70, 40.42, "西班牙"], "Barcelona": ["巴塞罗那", 2.17, 41.39, "西班牙"], "Valencia": ["巴伦西亚", -0.38, 39.47, "西班牙"],
  "Seville": ["塞维利亚", -5.99, 37.39, "西班牙"], "Bilbao": ["毕尔巴鄂", -2.93, 43.26, "西班牙"], "Lisbon": ["里斯本", -9.14, 38.72, "葡萄牙"],
  "Porto": ["波尔图", -8.61, 41.15, "葡萄牙"], "Dublin": ["都柏林", -6.26, 53.35, "爱尔兰"], "Edinburgh": ["爱丁堡", -3.19, 55.95, "英国"],
  "Glasgow": ["格拉斯哥", -4.25, 55.86, "英国"], "Manchester": ["曼彻斯特", -2.24, 53.47, "英国"], "Liverpool": ["利物浦", -2.98, 53.41, "英国"],
  "Birmingham": ["伯明翰", -1.90, 52.48, "英国"], "Bristol": ["布里斯托尔", -2.59, 51.45, "英国"], "Copenhagen": ["哥本哈根", 12.57, 55.68, "丹麦"],
  "Oslo": ["奥斯陆", 10.75, 59.91, "挪威"], "Stockholm": ["斯德哥尔摩", 18.07, 59.33, "瑞典"], "Helsinki": ["赫尔辛基", 24.94, 60.17, "芬兰"],
  "Reykjavik": ["雷克雅未克", -21.94, 64.15, "冰岛"], "Warsaw": ["华沙", 21.01, 52.23, "波兰"], "Krakow": ["克拉科夫", 19.94, 50.06, "波兰"],
  "Prague": ["布拉格", 14.44, 50.08, "捷克"], "Brno": ["布尔诺", 16.61, 49.20, "捷克"], "Budapest": ["布达佩斯", 19.04, 47.50, "匈牙利"],
  "Bucharest": ["布加勒斯特", 26.10, 44.43, "罗马尼亚"], "Sofia": ["索菲亚", 23.32, 42.69, "保加利亚"], "Belgrade": ["贝尔格莱德", 20.47, 44.78, "塞尔维亚"],
  "Zagreb": ["萨格勒布", 15.98, 45.81, "克罗地亚"], "Ljubljana": ["卢布尔雅那", 14.85, 46.05, "斯洛文尼亚"], "Athens": ["雅典", 23.73, 37.98, "希腊"],
  "Istanbul": ["伊斯坦布尔", 28.98, 41.01, "土耳其"], "Moscow": ["莫斯科", 37.62, 55.76, "俄罗斯"], "Kyiv": ["基辅", 30.52, 50.45, "乌克兰"],
  "Jerusalem": ["耶路撒冷", 35.21, 31.77, "以色列"], "Tel Aviv": ["特拉维夫", 34.78, 32.08, "以色列"], "Dubai": ["迪拜", 55.27, 25.20, "阿联酋"],
  "Abu Dhabi": ["阿布扎比", 54.37, 24.45, "阿联酋"], "Sharjah": ["沙迦", 55.39, 25.35, "阿联酋"], "Cairo": ["开罗", 31.24, 30.04, "埃及"],
  "Nairobi": ["内罗毕", 36.82, -1.29, "肯尼亚"], "Cape Town": ["开普敦", 18.42, -33.92, "南非"], "Johannesburg": ["约翰内斯堡", 28.05, -26.20, "南非"],
  "Lagos": ["拉各斯", 3.38, 6.52, "尼日利亚"], "Mexico City": ["墨西哥城", -99.13, 19.43, "墨西哥"], "Sao Paulo": ["圣保罗", -46.63, -23.55, "巴西"],
  "Rio de Janeiro": ["里约热内卢", -43.17, -22.91, "巴西"], "Buenos Aires": ["布宜诺斯艾利斯", -58.38, -34.60, "阿根廷"], "Santiago": ["圣地亚哥", -70.67, -33.45, "智利"],
  "Lima": ["利马", -77.03, -12.05, "秘鲁"], "Bogota": ["波哥大", -74.07, 4.71, "哥伦比亚"],
  "Tunis": ["突尼斯", 10.18, 36.80, "突尼斯"], "Casablanca": ["卡萨布兰卡", -7.59, 33.57, "摩洛哥"],
  "Marrakech": ["马拉喀什", -7.99, 31.63, "摩洛哥"], "Accra": ["阿克拉", -0.19, 5.60, "加纳"],
  "Addis Ababa": ["亚的斯亚贝巴", 38.75, 9.02, "埃塞俄比亚"], "Kampala": ["坎帕拉", 32.58, 0.35, "乌干达"],
  "Dakar": ["达喀尔", -17.45, 14.69, "塞内加尔"], "Algiers": ["阿尔及尔", 3.06, 36.75, "阿尔及利亚"],
  "Riyadh": ["利雅得", 46.72, 24.69, "沙特阿拉伯"], "Jeddah": ["吉达", 39.20, 21.49, "沙特阿拉伯"],
  "Doha": ["多哈", 51.53, 25.29, "卡塔尔"], "Amman": ["安曼", 35.93, 31.95, "约旦"],
  "Beirut": ["贝鲁特", 35.50, 33.89, "黎巴嫩"], "Tbilisi": ["第比利斯", 44.83, 41.72, "格鲁吉亚"],
  "Almaty": ["阿拉木图", 76.89, 43.24, "哈萨克斯坦"], "Tashkent": ["塔什干", 69.24, 41.30, "乌兹别克斯坦"],
  "Ulaanbaatar": ["乌兰巴托", 106.92, 47.89, "蒙古"], "Colombo": ["科伦坡", 79.86, 6.93, "斯里兰卡"],
  "Dhaka": ["达卡", 90.41, 23.81, "孟加拉国"], "Kathmandu": ["加德满都", 85.32, 27.72, "尼泊尔"],
  "Hanoi": ["河内", 105.83, 21.03, "越南"], "Ho Chi Minh City": ["胡志明市", 106.63, 10.82, "越南"],
  "Kuala Lumpur": ["吉隆坡", 101.69, 3.14, "马来西亚"], "Manila": ["马尼拉", 120.98, 14.60, "菲律宾"],
  "Yangon": ["仰光", 96.20, 16.87, "缅甸"], "Phnom Penh": ["金边", 104.93, 11.56, "柬埔寨"],
  "Nicosia": ["尼科西亚", 33.38, 35.19, "塞浦路斯"], "Valletta": ["瓦莱塔", 14.51, 35.90, "马耳他"],
  "Bratislava": ["布拉迪斯拉发", 17.11, 48.15, "斯洛伐克"], "Tallinn": ["塔林", 24.75, 59.44, "爱沙尼亚"],
  "Riga": ["里加", 24.11, 56.95, "拉脱维亚"], "Vilnius": ["维尔纽斯", 25.28, 54.69, "立陶宛"],
  "Skopje": ["斯科普里", 21.43, 41.99, "北马其顿"], "Sarajevo": ["萨拉热窝", 18.41, 43.86, "波黑"],
  "Podgorica": ["波德戈里察", 19.26, 42.44, "黑山"], "Tirana": ["地拉那", 19.82, 41.33, "阿尔巴尼亚"]
};

// 中文城市名 -> [ll, 中文国名](AI 对中文页面常返回中文地名,而 WORLD_CITY 是英文键)
const WORLD_CITY_ZH = {};
for (const [, v] of Object.entries(WORLD_CITY)) if (v[0] && !WORLD_CITY_ZH[v[0]]) WORLD_CITY_ZH[v[0]] = [v[1], v[2], v[3]];

// ISO-3166 alpha-2 -> 英文国名(平台内嵌 JSON 常给两字母码,如 ArtConnect 的 country=GB)
const ISO2EN = {
  GB: "United Kingdom", US: "United States", CA: "Canada", AU: "Australia", NZ: "New Zealand",
  IE: "Ireland", FR: "France", DE: "Germany", IT: "Italy", ES: "Spain", PT: "Portugal", NL: "Netherlands",
  BE: "Belgium", LU: "Luxembourg", CH: "Switzerland", AT: "Austria", DK: "Denmark", SE: "Sweden",
  NO: "Norway", FI: "Finland", IS: "Iceland", PL: "Poland", CZ: "Czechia", SK: "Slovakia", HU: "Hungary",
  RO: "Romania", BG: "Bulgaria", HR: "Croatia", RS: "Serbia", SI: "Slovenia", BA: "Bosnia and Herzegovina",
  MK: "North Macedonia", AL: "Albania", GR: "Greece", TR: "Turkey", CY: "Cyprus", MT: "Malta", EE: "Estonia",
  LV: "Latvia", LT: "Lithuania", UA: "Ukraine", RU: "Russia", BY: "Belarus", MD: "Moldova", GE: "Georgia",
  AM: "Armenia", AZ: "Azerbaijan", KZ: "Kazakhstan", UZ: "Uzbekistan", MN: "Mongolia", CN: "China",
  JP: "Japan", KR: "South Korea", TW: "Taiwan", HK: "Hong Kong", MO: "Macao", SG: "Singapore",
  MY: "Malaysia", TH: "Thailand", VN: "Vietnam", ID: "Indonesia", PH: "Philippines", IN: "India",
  PK: "Pakistan", BD: "Bangladesh", LK: "Sri Lanka", NP: "Nepal", AE: "United Arab Emirates",
  SA: "Saudi Arabia", QA: "Qatar", KW: "Kuwait", OM: "Oman", BH: "Bahrain", JO: "Jordan", LB: "Lebanon",
  IL: "Israel", IQ: "Iraq", IR: "Iran", EG: "Egypt", MA: "Morocco", TN: "Tunisia", DZ: "Algeria",
  ZA: "South Africa", KE: "Kenya", NG: "Nigeria", GH: "Ghana", ET: "Ethiopia", TZ: "Tanzania",
  UG: "Uganda", SN: "Senegal", ZM: "Zambia", ZW: "Zimbabwe", BW: "Botswana", NA: "Namibia", MZ: "Mozambique",
  MX: "Mexico", BR: "Brazil", AR: "Argentina", CL: "Chile", PE: "Peru", CO: "Colombia", VE: "Venezuela",
  EC: "Ecuador", UY: "Uruguay", PY: "Paraguay", BO: "Bolivia", CU: "Cuba", JM: "Jamaica", PR: "Puerto Rico",
  CR: "Costa Rica", PA: "Panama", GT: "Guatemala", DO: "Dominican Republic"
};
// 英文/本地语言国名 -> 中文(优先 EN2ZH;EN2ZH 没有的少量补充)
const EN2ZH_EXTRA = { "Slovakia": "斯洛伐克", "North Macedonia": "北马其顿", "Albania": "阿尔巴尼亚",
  "Bosnia and Herzegovina": "波黑", "Moldova": "摩尔多瓦", "Iraq": "伊拉克", "Iran": "伊朗",
  "Dominican Republic": "多米尼加", "Taiwan": "中国台湾", "Hong Kong": "中国香港", "Macao": "中国澳门",
  "Macau": "中国澳门", "Norge": "挪威", "Sverige": "瑞典", "Danmark": "丹麦", "Suomi": "芬兰",
  "Deutschland": "德国", "Italia": "意大利", "España": "西班牙", "Nederland": "荷兰", "België": "比利时",
  "Brasil": "巴西", "Türkiye": "土耳其", "Česko": "捷克", "Polska": "波兰", "Magyarország": "匈牙利" };
function countryZhFromName(en) {
  if (!en) return null;
  if (EN2ZH[en]) return EN2ZH[en];
  if (EN2ZH_EXTRA[en]) return EN2ZH_EXTRA[en];
  return normCountry(en);
}

// ---------------------------------------------------------------- 抓取 & 文本化
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&middot;/g, "·")
    .replace(/&mdash;/g, "-").replace(/&ndash;/g, "-").replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch (e) { return " "; } });
}
function htmlToText(html) {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ");
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}
// 页面内嵌 JSON 里的地点键值(容忍 \" 转义)。只取出现顺序里前若干个,避免导航/下拉项的噪声。
const HINT_RE = /\\?"(city|country|countryCode|country_name|region|state|province|address|locationName|venueCity|locationCity)\\?"\s*:\s*\\?"([^"\\]{2,60})\\?"/gi;
function structuredHints(html) {
  const out = [];
  for (const m of html.matchAll(HINT_RE)) {
    const v = m[2].trim();
    if (!v || /^(null|undefined|)$/i.test(v)) continue;
    out.push(m[1] + "=" + v);
    if (out.length >= 12) break;
  }
  return [...new Set(out)];
}

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow", signal: AbortSignal.timeout(TIMEOUT)
    });
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml|text\/plain|application\/json/i.test(ct)) return { ok: false, reason: "content-type:" + ct.slice(0, 30) };
    let html = await res.text();
    if (html.length > 500000) html = html.slice(0, 500000);
    return { ok: true, status: res.status, finalUrl: res.url, html, text: htmlToText(html) };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e).slice(0, 60) };
  }
}

// ---------------------------------------------------------------- 从页面内容判地点
function normWs(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim(); }
function evidenceInSource(ev, src) {
  const e = normWs(ev);
  return !!e && normWs(src).indexOf(e) !== -1;
}
// 港/澳/台等特殊城市 + 少量本地语言国名(LLM 可能用原文语言返回)
const MISC_CITY = { "澳门": ["澳门", 113.55, 22.20, "中国澳门"], "澳門": ["澳门", 113.55, 22.20, "中国澳门"],
  "香港": ["香港", 114.17, 22.32, "中国香港"], "Hong Kong": ["香港", 114.17, 22.32, "中国香港"],
  "台北": ["台北", 121.57, 25.03, "中国台湾"], "Taipei": ["台北", 121.57, 25.03, "中国台湾"],
  "高雄": ["高雄", 120.30, 22.63, "中国台湾"], "台中": ["台中", 120.67, 24.15, "中国台湾"],
  "台南": ["台南", 120.21, 23.00, "中国台湾"], "新竹": ["新竹", 120.97, 24.80, "中国台湾"] };
const GENERIC_CITY = /^(city|town|village|unknown|n\/a|online|remote|various|tba|tbd|-|null)$/i;

// 由城市名推所属国家(前端 CITY 字典是中英混合、无国别字段,故这里单独判)
function countryOfCity(n) {
  if (MISC_CITY[n]) return MISC_CITY[n][3];
  if (WORLD_CITY[n]) return WORLD_CITY[n][3];
  if (WORLD_CITY_ZH[n]) return WORLD_CITY_ZH[n][2];
  if (matchCN(n)) return "中国";      // 命中中国省市区字典 → 中国
  return undefined;                    // 未知则留空,交由上层保留原值
}

function cityLookup(name) {
  if (!name) return null;
  const raw = String(name).trim();
  if (!raw || GENERIC_CITY.test(raw)) return null;
  // 去掉 "Reno, Nevada" / "哈雷（Saale）" / "哈雷(Saale)" 等后缀或括注
  const n = raw.replace(/[（(].*$/, "").replace(/,\s*.*$/, "").trim();
  if (!n || GENERIC_CITY.test(n)) return null;
  // 带国别信息的表优先;前端 CITY 字典(含中英文、坐标权威)兜底并用 countryOfCity 补国别
  if (MISC_CITY[raw] || MISC_CITY[n]) { const c = MISC_CITY[raw] || MISC_CITY[n]; return { ll: [c[1], c[2]], zh: c[0], kind: "city", country: c[3] }; }
  if (WORLD_CITY[n]) return { ll: [WORLD_CITY[n][1], WORLD_CITY[n][2]], zh: WORLD_CITY[n][0], kind: "city", country: WORLD_CITY[n][3] };
  if (WORLD_CITY_ZH[n]) return { ll: [WORLD_CITY_ZH[n][0], WORLD_CITY_ZH[n][1]], zh: n, kind: "city", country: WORLD_CITY_ZH[n][2] };
  if (CITY0[n]) return { ll: CITY0[n], zh: n, kind: "city", country: countryOfCity(n) };
  const w = worldByName.get(n);
  if (w) return { ll: w.ll, zh: undefined, admin: w.admin, kind: "region", country: EN2ZH[w.admin] || undefined };
  const wz = worldByZh.get(n);
  if (wz) return { ll: wz.ll, zh: n, admin: wz.admin, kind: "region", country: EN2ZH[wz.admin] || undefined };
  return null;
}

// 依据 {text, hints, url} 判地点。返回 {ll, prec, src, ev, city, country} 或 null(交 LLM)
// 注意:【不做整页盲扫地名】(页脚/语言/筛选/往届作品里混入的无关地名极易误判,如"Oslo 的征集"
// 因正文提到乌克兰艺术家而被判成乌克兰)。只用:中国区划匹配 + 平台内嵌结构化字段。
function resolveFromPage(o, page) {
  const text = page.text || "";
  const hints = page.hints || [];

  // 1) 中国省市(正文里出现)
  const cn = matchCN(text);
  if (cn) return { ll: cn.ll, prec: cn.kind === "province" ? "省会" : (cn.kind === "district" ? "区县" : "城市"),
    src: "web-visit", ev: cn.k, city: cn.name, country: "中国" };

  // 2) 平台内嵌结构化字段:国家(ISO 两字母码或全名)
  let country = null, ev = "";
  for (const h of hints) {
    const [k, v] = h.split("=");
    if (/country/i.test(k)) {
      const zh = (ISO2EN[v.toUpperCase()] && countryZhFromName(ISO2EN[v.toUpperCase()])) || countryZhFromName(v);
      if (zh && zh !== "全球") { country = zh; ev = v; break; }
    }
  }

  // 3) 结构化 city → 命中市表/一级行政区表
  for (const h of hints) {
    const [k, v] = h.split("=");
    if (/city|venue/i.test(k)) {
      const c = cityLookup(v);
      if (c) return { ll: c.ll, prec: c.kind === "region" ? "州中心" : "城市", src: "web-visit", ev: v,
        city: c.zh || v, country: c.country || country };
    }
  }
  // 3b) 结构化 region/state → 已知国家内的一级行政区
  if (country) {
    for (const h of hints) {
      const [k, v] = h.split("=");
      if (/region|state|province/i.test(k)) {
        const wc = matchWorldInCountry(v, country);
        if (wc) return { ll: wc.ll, prec: "州中心", src: "web-visit", ev: v, country };
      }
    }
  }
  // 4) 只拿到国家 → 先记住,让 LLM 有机会给出更细的城市
  if (country && COUNTRY[country]) return { country, ev, _weak: true };
  return null;
}

// LLM 兜底:从正文抽 国家/城市/地区 + 原文证据。反幻觉两道闸:
//   ① evidence 必须是从所提供文本(正文+内嵌字段)里原样复制的子串;
//   ② 真正用来定位的那个地名(city / country / region)必须也在原文里出现过(值本身须见原文)。
const SYS = `你是地理信息抽取器,判断一条艺术机会的举办地/主办机构所在地/驻留地。
只看用户给的【网页文本】和【页面内嵌字段】,严禁用你自己的知识补充或推断。
规则:
1. 找的是这条机会【本身】的地点(举办地、主办机构驻地、驻留地)。
2. 若页面只说某艺术家/往届获奖者的国籍或所在地,与举办地无关,不要采用。
3. 页面没有明确写出地点时,所有字段留空字符串,不要猜。纯线上/虚拟/远程活动填 online=true。
4. 地名(country/city/region)必须【按文本里出现的那种语言原样输出】,不要翻译、不要换成英文;
   例如中文页面里写的"津巴布韦"就填"津巴布韦",英文页面里写的 "Zimbabwe" 就填 "Zimbabwe"。
5. evidence 必须从文本里【原样复制】一小段(≤80 字),能支撑你的判断。
6. 严格输出 JSON,无多余文字。
字段:{"online":true|false,"country":"国家名","city":"城市名","region":"州/省/地区名","evidence":"原文片段"}`;

// 值是否在原文里出现过(空白归一 + 忽略大小写 + 繁简归一)。中文≥2字、西文≥3字母才算,避免短词误伤
const TRAD2SIMP = (() => {
  const pairs = "門门 藝艺 節节 徵征 區区 臺台 灣湾 國国 會会 學学 術术 導导 獎奖 專专 業业 場场 館馆 畫画 動动 際际 東东 華华 樂乐 圖图 書书 電电 視视 網网 語语 該该 們们 個个 為为 於于 與与 後后 開开 關关 長长 產产 現现 發发 說说 這这 進进 過过 對对 應应 從从 實实 團团 體体 時时 間间 內内 無无 讓让 認认 訊讯 費费 資资 質质 覽览 廳厅 廣广 島岛 縣县 鄉乡 樓楼 積积 稱称 種种 類类 級级 結结 織织 統统 計计 許许 請请 課课 論论 議议 讀读 變变 響响 項项 題题 顯显 風风 飛飞 馬马 鳥鸟 魚鱼 龍龙 點点 樓楼 樂乐 衛卫 護护 鐵铁 銀银";
  const m = new Map();
  for (const p of pairs.split(" ")) if (p.length === 2) m.set(p[1], p[0]);
  return m;
})();
const normCJK = s => String(s).replace(/[\u4e00-\u9fff]/g, ch => TRAD2SIMP.get(ch) || ch);
function valueInSource(name, source) {
  if (!name) return false;
  const a = normCJK(normWs(name)).toLowerCase(), b = normCJK(normWs(source)).toLowerCase();
  const minLen = /[\u4e00-\u9fff]/.test(a) ? 2 : 3;
  return a.length >= minLen && b.indexOf(a) !== -1;
}
// 美国州缩写 -> 州名(LLM 常给 "CA"/"FL";本地世界数据只认全名)
const US_ABBR = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia" };

async function llmLocate(o, page, dbg) {
  // source 纳入本条目【自身的原文】(标题/机构名)——它们本就是抓来的原始字段,
  // 用于核对 AI 给出的地名是否真在原文出现(如 SKOG 的 "Oslo" 就只在标题里)。
  const source = [
    page.text || "", (page.hints || []).join(" "),
    o.org_zh || o.org_en || "", o.title_zh || o.title_en || ""
  ].filter(Boolean).join(" ");
  const body = [
    "【机构】" + (o.org_zh || o.org_en || ""),
    "【标题】" + (o.title_zh || o.title_en || ""),
    "【网页文本】", (page.text || "").slice(0, 7000),
    (page.hints && page.hints.length) ? "\n【页面内嵌字段】" + page.hints.join(" ; ") : ""
  ].join("\n");
  const r = await extractGlmFree(SYS, body, 400);
  const d = (r && r.data) || {};
  const ev = normWs(d.evidence || "");
  const evOk = evidenceInSource(ev, source);
  if (dbg) dbg.push({ data: d, evInSrc: evOk, cityInSrc: valueInSource(d.city, source), countryInSrc: valueInSource(d.country, source), regionInSrc: valueInSource(d.region, source) });

  // 纯线上/虚拟活动:AI 明确判定且证据可核 → 接受(不落点)
  if (d.online === true && evOk) return { online: true, ev };

  // ② 采用的地名须在原文出现过(值本身须见原文;AI 凭自己知识补的地点一律作废)
  //    inSource 支持中英互查:AI 给中文「奥斯陆」而原文写 "Oslo" 也应认。
  const inSource = (name, zh) => {
    if (!name) return false;
    const cands = [name, zh];
    if (WORLD_CITY[name]) cands.push(WORLD_CITY[name][0]);
    if (WORLD_CITY_ZH[name]) for (const [en, v] of Object.entries(WORLD_CITY)) if (v[0] === name) cands.push(en);
    const czh = countryZhFromName(name); if (czh) cands.push(czh);
    if (ZH2EN[name]) cands.push(ZH2EN[name]);
    return cands.some(c => c && valueInSource(c, source));
  };

  const city = cityLookup(d.city);
  if (city && inSource(d.city, city.zh)) return { ll: city.ll, prec: city.kind === "region" ? "州中心" : "城市", src: "web-visit-ai",
    ev: evOk ? ev : normWs(d.city), city: city.zh || d.city, country: city.country || undefined };

  // ③ region 落在世界一级行政区上(LLM 常只给州/省,如 "Florida"/"FL"/"CA")→ 州中心
  const regionRaw = normWs(d.region);
  if (regionRaw) {
    const abbr = regionRaw.toUpperCase();
    const full = US_ABBR[abbr];                                    // "FL" -> "Florida"
    const regionInSrc = full ? new RegExp("\\b" + abbr + "\\b").test(source) : valueInSource(regionRaw, source);
    if (regionInSrc) {
      const reg = worldByName.get(full || regionRaw);
      if (reg) return { ll: reg.ll, prec: "州中心", src: "web-visit-ai",
        ev: evOk ? ev : regionRaw, country: EN2ZH[reg.admin] || undefined };
    }
  }

  const country = inSource(d.country, countryZhFromName(d.country)) ? countryZhFromName(d.country) : null;
  if (country && COUNTRY[country]) {
    const regionName = (() => {
      const rr = normWs(d.region); if (!rr) return null;
      const f = US_ABBR[rr.toUpperCase()];
      const inSrc = f ? new RegExp("\\b" + rr.toUpperCase() + "\\b").test(source) : valueInSource(rr, source);
      return inSrc ? (f || rr) : null;
    })();
    const region = regionName ? matchWorldInCountry(regionName, country) : null;
    if (region) return { ll: region.ll, prec: "州中心", src: "web-visit-ai", ev: evOk ? ev : regionName, country };
    return { ll: COUNTRY[country], prec: "国家", src: "web-visit-ai", ev: evOk ? ev : normWs(d.country), country };
  }
  return null;
}

// ---------------------------------------------------------------- 主流程
function loadJson(p, dflt) { try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { return dflt; } }

async function main() {
  const raw = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  const wrap = !Array.isArray(raw);
  const list = Array.isArray(raw) ? raw : (raw.opportunities || raw.items || []);
  let targets = list.filter(o => (o.geo_prec === "未知" || o.geo_src === "unresolved") && !o.geo_ll);
  if (ONLY) targets = targets.filter(o => { try { return new URL(o.url || o.official_url).host.includes(ONLY); } catch (e) { return false; } });
  if (LIMIT) targets = targets.slice(0, LIMIT);
  console.log(`目标 ${targets.length} 条(全库未知 ${list.filter(o => o.geo_prec === "未知").length})`);

  if (!existsSync(dirname(CACHE_FILE))) mkdirSync(dirname(CACHE_FILE), { recursive: true });
  const cache = loadJson(CACHE_FILE, {});
  const stat = { 城市: 0, 省会: 0, 区县: 0, 州中心: 0, 国家: 0, 线上: 0, 仍未解决: 0 };
  let done = 0, applied = 0;

  const queue = targets.slice();
  async function worker() {
    while (queue.length) {
      const o = queue.shift();
      try {
        let rec = cache[o.id];
        if (!rec) {
          const urlsSeen = new Set();
          const pages = [];
          const dbg = [];
          // official_url 优先(机构官网更可能写出真实举办地;聚合平台页脚常带平台自身地址,易带偏)
          for (const u of [o.official_url, o.url]) {
            if (!u || urlsSeen.has(u)) continue;
            urlsSeen.add(u);
            const p = await fetchPage(u);
            if (p.ok) { p.hints = structuredHints(p.html); pages.push(p); }
            else pages.push({ ok: false, url: u, reason: p.reason });
          }
          const good = pages.filter(p => p.ok && (p.text || "").length > 100);
          // 页面抓不到内容(JS 渲染/被拦)时,仍允许仅凭【标题/机构】判定(它们也是原始字段)
          if (!good.length) good.push({ text: "", hints: [], url: "" });
          // 先跑"可靠级"(中国区划 / 平台内嵌字段);只有国家级的先记着,让 LLM 有机会给出城市
          let strong = null, weak = null;
          for (const p of good) {
            const r = resolveFromPage(o, p);
            if (r && !r._weak) { strong = r; break; }
            if (r && r._weak && !weak) weak = r;
          }
          let res = strong;
          if (!res && !NO_LLM && good.length) {
            for (const p of good) {
              try { const r = await llmLocate(o, p, dbg); if (r) { res = r; break; } }
              catch (e) { /* LLM 失败不致命 */ }
            }
          }
          if (!res && weak) res = { ll: COUNTRY[weak.country], prec: "国家", src: "web-visit", ev: weak.ev, country: weak.country };
          if (!res) {   // 最后退路:域名 TLD(如 .ie → 爱尔兰)
            const cd = countryFromDomain(o.url || o.official_url || "");
            if (cd && COUNTRY[cd]) res = { ll: COUNTRY[cd], prec: "国家", src: "tld", ev: cd, country: cd };
          }
          rec = { res: res || null, fetched: pages.filter(p => p.ok && (p.text || "").length > 100).length, urls: pages.map(p => (p.ok ? "ok" : "ERR:" + p.reason)) };
          if (!res) rec.dbg = dbg;   // 未解决时留证据,便于定位原因
          cache[o.id] = rec;
          writeFileSync(CACHE_FILE, JSON.stringify(cache));
        }
        const r = rec.res;
        if (r && r.online) stat.线上++;
        else if (r && r.ll) { stat[r.prec] = (stat[r.prec] || 0) + 1; }
        else stat.仍未解决++;
        if (APPLY && r && (r.ll || r.online)) {
          o.geo_ll = r.ll || null;
          o.geo_prec = r.ll ? r.prec : "线上";
          o.geo_src = r.src || "web-visit";
          o.geo_ev = r.ev || null;
          if (r.city) o.city_zh = r.city;
          if (r.country) o.country_zh = r.country;
          applied++;
        }
      } catch (e) {
        stat.仍未解决++;
        console.log("  ERR", o.id, String(e.message || e).slice(0, 80));
      }
      if (++done % 25 === 0) console.log(`  ...进度 ${done}/${targets.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length || 1) }, worker));

  console.log("\n=== 深挖结果 ===");
  console.log("精度分布:", JSON.stringify(stat));
  console.log(APPLY ? `已写回 ${applied} 条` : "(dry 未写盘)");
  if (APPLY) {
    if (wrap) { raw.opportunities = list; writeFileSync(DATA_FILE, JSON.stringify(raw, null, 2)); }
    else writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
    console.log("已写回:", DATA_FILE);
  }
}

main().catch(e => { console.error(e); process.exit(1); });