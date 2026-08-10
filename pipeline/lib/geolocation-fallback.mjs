// geolocation-fallback.mjs —— 地理信息兜底补全(v1.8.0)
//
// 解决问题:约 32% 的机会记录 city_zh 为空,27% country_zh 为空。
// 这些不是"真的没城市",而是 AI 提取时未能从原文中解析出来。
//
// 兜底管线(逐级回退,绝不编造):
//   1. AI 已提取 → 直接使用
//   2. 正则匹配原文中的城市名(从 globe-data.js 的 CITY 表加载)
//   3. 域名推断(如 tokyo-art.edu → 东京/日本)
//   4. 区域经理上下文(如果是区域经理抓取的,用其负责地区)
//   5. 标记为 "未知" (不再为 null,让前端可聚合展示)

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// 城市名 -> [lng, lat] 的映射(与 globe-data.js 的 CITY 表保持一致)
// 只存中文名 + 常用英文名,避免重复维护
const CITY_MAP = {
  // 中国大陆
  "北京": [116.41, 39.90], "上海": [121.47, 31.23], "广州": [113.26, 23.13],
  "深圳": [114.06, 22.54], "成都": [104.07, 30.57], "重庆": [106.55, 29.56],
  "天津": [117.36, 39.34], "南京": [118.80, 32.06], "杭州": [120.16, 30.27],
  "武汉": [114.31, 30.59], "西安": [108.94, 34.34], "厦门": [118.09, 24.48],
  "长沙": [112.94, 28.23], "郑州": [113.63, 34.75], "青岛": [120.38, 36.07],
  "苏州": [120.59, 31.30], "沈阳": [123.43, 41.81], "大连": [121.61, 38.91],
  "昆明": [102.72, 25.04], "济南": [117.12, 36.65], "宁波": [121.55, 29.87],
  "合肥": [117.23, 31.82], "福州": [119.30, 26.07], "无锡": [120.30, 31.57],
  "南昌": [115.86, 28.68], "贵阳": [106.63, 26.65], "太原": [112.55, 37.87],
  "石家庄": [114.51, 38.04], "哈尔滨": [126.53, 45.80], "长春": [125.32, 43.82],
  "南宁": [108.37, 22.82], "兰州": [103.83, 36.06], "海口": [110.20, 20.04],
  "三亚": [109.51, 18.25], "景德镇": [117.18, 29.27],
  "银川": [106.23, 38.49], "乌鲁木齐": [87.62, 43.83],
  "呼和浩特": [111.75, 40.84], "拉萨": [91.17, 29.65], "西宁": [101.78, 36.62],
  "珠海": [113.57, 22.27], "佛山": [113.12, 23.02], "东莞": [113.75, 23.04],
  "中山": [113.39, 22.52], "惠州": [114.41, 23.11], "泉州": [118.58, 24.93],
  "温州": [120.67, 28.00], "绍兴": [120.58, 30.00], "嘉兴": [120.76, 30.75],
  "金华": [119.65, 29.08], "台州": [121.42, 28.66], "烟台": [121.39, 37.52],
  "潍坊": [119.10, 36.70], "临沂": [118.35, 35.10], "徐州": [117.18, 34.26],
  "扬州": [119.41, 32.39], "南通": [120.86, 32.01], "常州": [119.97, 31.77],
  "徐州": [117.18, 34.26], "无锡": [120.30, 31.57],
  // 港澳台
  "香港": [114.17, 22.32], "澳门": [113.54, 22.20], "台北": [121.57, 25.03],
  "高雄": [120.30, 22.63], "台中": [120.67, 24.15], "台南": [120.21, 23.00],
  "新竹": [120.97, 24.80],
  // 亚洲其他
  "东京": [139.65, 35.68], "大阪": [135.50, 34.69], "京都": [135.77, 35.01],
  "首尔": [126.98, 37.57], "新加坡": [103.82, 1.35], "曼谷": [100.50, 13.76],
  "吉隆坡": [101.69, 3.14], "雅加达": [106.85, -6.21],
  "马尼拉": [120.98, 14.60], "河内": [105.85, 21.03],
  "孟买": [72.88, 19.08], "新德里": [77.10, 28.70],
  "迪拜": [55.27, 25.20], "沙迦": [55.40, 25.36],
  "阿布扎比": [54.37, 24.45], "多哈": [51.53, 25.29],
  "伊斯坦布尔": [28.98, 41.01], "特拉维夫": [34.78, 32.08],
  "首尔": [126.98, 37.57], "釜山": [129.08, 35.18],
  // 欧洲
  "巴黎": [2.35, 48.86], "伦敦": [-0.13, 51.51], "柏林": [13.40, 52.52],
  "罗马": [12.50, 41.90], "米兰": [9.19, 45.46], "威尼斯": [12.34, 45.44],
  "马德里": [-3.70, 40.42], "巴塞罗那": [2.17, 41.39],
  "阿姆斯特丹": [4.90, 52.37], "维也纳": [16.37, 48.21],
  "苏黎世": [8.54, 47.38], "日内瓦": [6.14, 46.20],
  "布鲁塞尔": [4.35, 50.85], "慕尼黑": [11.58, 48.14],
  "法兰克福": [8.68, 50.11], "哥本哈根": [12.57, 55.68],
  "斯德哥尔摩": [18.07, 59.33], "奥斯陆": [10.75, 59.91],
  "赫尔辛基": [24.94, 60.17], "都柏林": [-6.26, 53.35],
  "里斯本": [-9.14, 38.72], "雅典": [23.73, 37.98],
  "布拉格": [14.44, 50.08], "华沙": [21.01, 52.23],
  "布达佩斯": [19.04, 47.50], "莫斯科": [37.62, 55.76],
  // 北美
  "纽约": [-74.01, 40.71], "洛杉矶": [-118.24, 34.05],
  "旧金山": [-122.42, 37.77], "芝加哥": [-87.63, 41.88],
  "波士顿": [-71.06, 42.36], "华盛顿": [-77.04, 38.91],
  "西雅图": [-122.33, 47.61], "迈阿密": [-80.19, 25.76],
  "多伦多": [-79.35, 43.65], "温哥华": [-123.12, 49.28],
  "蒙特利尔": [-73.57, 45.50], "墨西哥城": [-99.13, 19.43],
  "费城": [-75.17, 39.95], "匹兹堡": [-79.99, 40.44],
  // 南美
  "圣保罗": [-46.63, -23.55], "里约热内卢": [-43.17, -22.91],
  "布宜诺斯艾利斯": [-58.38, -34.60], "圣地亚哥": [-70.67, -33.45],
  "利马": [-77.03, -12.05], "波哥大": [-74.07, 4.71],
  // 大洋洲
  "悉尼": [151.21, -33.87], "墨尔本": [144.96, -37.81],
  "奥克兰": [174.76, -36.85], "珀斯": [115.86, -31.95],
  // 非洲
  "开罗": [31.24, 30.04], "拉各斯": [3.38, 6.52],
  "约翰内斯堡": [28.05, -26.20], "内罗毕": [36.82, -1.29],
  "卡萨布兰卡": [-7.59, 33.57], "开普敦": [18.42, -33.92],
  // 英文城市名(部分)
  "New York": [-74.01, 40.71], "New York City": [-74.01, 40.71],
  "London": [-0.13, 51.51], "Paris": [2.35, 48.86],
  "Berlin": [13.40, 52.52], "Tokyo": [139.65, 35.68],
  "Hong Kong": [114.17, 22.32], "Seoul": [126.98, 37.57],
  "Singapore": [103.82, 1.35], "Sydney": [151.21, -33.87],
  "Toronto": [-79.35, 43.65], "Vancouver": [-123.12, 49.28],
  "Dubai": [55.27, 25.20], "Los Angeles": [-118.24, 34.05],
  "San Francisco": [-122.42, 37.77], "Chicago": [-87.63, 41.88]
};

// 国家名 -> 城市/中心 的映射(用于兜底)
const COUNTRY_TO_CITY = {
  "中国": "北京", "美国": "纽约", "英国": "伦敦", "法国": "巴黎",
  "德国": "柏林", "意大利": "罗马", "西班牙": "马德里", "荷兰": "阿姆斯特丹",
  "日本": "东京", "韩国": "首尔", "新加坡": "新加坡", "泰国": "曼谷",
  "印度": "新德里", "阿联酋": "迪拜", "加拿大": "多伦多", "澳大利亚": "悉尼",
  "新西兰": "奥克兰", "巴西": "圣保罗", "墨西哥": "墨西哥城",
  "阿根廷": "布宜诺斯艾利斯", "俄罗斯": "莫斯科", "土耳其": "伊斯坦布尔",
  "埃及": "开罗", "南非": "约翰内斯堡", "葡萄牙": "里斯本", "希腊": "雅典",
  "爱尔兰": "都柏林", "丹麦": "哥本哈根", "瑞典": "斯德哥尔摩",
  "挪威": "奥斯陆", "芬兰": "赫尔辛基", "波兰": "华沙", "捷克": "布拉格",
  "匈牙利": "布达佩斯", "比利时": "布鲁塞尔", "瑞士": "苏黎世",
  "奥地利": "维也纳", "以色列": "特拉维夫", "印度尼西亚": "雅加达",
  "马来西亚": "吉隆坡", "越南": "河内", "菲律宾": "马尼拉",
  "摩洛哥": "卡萨布兰卡", "肯尼亚": "内罗毕", "尼日利亚": "拉各斯",
  "中国香港": "香港", "中国澳门": "澳门", "中国台湾": "台北",
  // 英文
  "China": "北京", "United States": "纽约", "USA": "纽约",
  "United Kingdom": "伦敦", "UK": "伦敦", "France": "巴黎",
  "Germany": "柏林", "Japan": "东京", "South Korea": "首尔",
  "Korea": "首尔", "Canada": "多伦多", "Australia": "悉尼",
  "Brazil": "圣保罗", "India": "新德里", "Singapore": "新加坡",
  "Hong Kong": "香港"
};

// 域名后缀 -> 国家映射(粗略兜底)
const DOMAIN_TLD_COUNTRY = {
  ".cn": "中国", ".com.cn": "中国",
  ".jp": "日本", ".co.jp": "日本",
  ".kr": "韩国", ".co.kr": "韩国",
  ".uk": "英国", ".ac.uk": "英国",
  ".fr": "法国", ".de": "德国", ".it": "意大利",
  ".es": "西班牙", ".nl": "荷兰", ".be": "比利时",
  ".ch": "瑞士", ".at": "奥地利",
  ".au": "澳大利亚", ".nz": "新西兰",
  ".ca": "加拿大", ".us": "美国",
  ".br": "巴西", ".mx": "墨西哥", ".ar": "阿根廷",
  ".ru": "俄罗斯", ".tr": "土耳其",
  ".in": "印度", ".sg": "新加坡", ".th": "泰国",
  ".id": "印度尼西亚", ".my": "马来西亚",
  ".hk": "中国香港", ".mo": "中国澳门", ".tw": "中国台湾",
  ".ae": "阿联酋", ".sa": "沙特阿拉伯",
  ".eg": "埃及", ".za": "南非", ".ng": "尼日利亚",
  ".ke": "肯尼亚", ".ma": "摩洛哥",
  ".se": "瑞典", ".no": "挪威", ".dk": "丹麦", ".fi": "芬兰",
  ".pl": "波兰", ".cz": "捷克", ".hu": "匈牙利",
  ".pt": "葡萄牙", ".gr": "希腊", ".ie": "爱尔兰",
  ".il": "以色列", ".qa": "卡塔尔",
  ".vn": "越南", ".ph": "菲律宾"
};

// 预排序城市名列表(按长度降序,优先匹配长名避免"青岛"匹配成"青"或"岛")
const SORTED_CITY_NAMES = Object.keys(CITY_MAP).sort((a, b) => b.length - a.length);

/**
 * 从原文中尝试匹配城市名
 * @param {string} text - 原文
 * @returns {string|null} 匹配到的城市名,未找到返回 null
 */
function matchCityFromText(text) {
  if (!text) return null;
  for (const city of SORTED_CITY_NAMES) {
    if (text.includes(city)) return city;
  }
  return null;
}

/**
 * 从域名推断国家
 * @param {string} domain - 域名
 * @returns {string|null} 推断的国家,未找到返回 null
 */
function inferCountryFromDomain(domain) {
  if (!domain) return null;
  const lower = domain.toLowerCase();
  for (const [tld, country] of Object.entries(DOMAIN_TLD_COUNTRY)) {
    if (lower.endsWith(tld)) return country;
  }
  return null;
}

/**
 * 从区域经理上下文推断城市/国家
 * @param {object} ctx - 上下文,含 region 信息
 * @returns {{city: string|null, country: string|null}}
 */
function inferFromRegion(ctx) {
  if (!ctx || !ctx.region) return { city: null, country: null };
  const region = ctx.region;
  // 区域经理的 terms 里包含城市名
  if (Array.isArray(region.terms)) {
    for (const term of region.terms) {
      if (CITY_MAP[term]) {
        return { city: term, country: null };
      }
      if (COUNTRY_TO_CITY[term]) {
        const city = COUNTRY_TO_CITY[term];
        return { city, country: term };
      }
    }
  }
  return { city: null, country: null };
}

/**
 * 地理信息兜底补全主函数
 * @param {object} record - AI 提取的原始记录
 * @param {object} ctx - 上下文(domain, source_url, region 等)
 * @param {string} sourceText - 原始抓取文本
 * @returns {{city_zh: string, country_zh: string, geo_fallback: string}} 补全结果 + 兜底来源
 */
export function fillGeoFallback(record, ctx = {}, sourceText = "") {
  const result = {
    city_zh: record.city_zh || null,
    country_zh: record.country_zh || null,
    geo_fallback: "ai"  // 标记兜底来源
  };

  // 如果 AI 已经提取了,直接返回
  if (result.city_zh && result.country_zh) {
    return result;
  }

  // Step 1: 从原文正则匹配城市名
  if (!result.city_zh) {
    const matched = matchCityFromText(sourceText);
    if (matched) {
      result.city_zh = matched;
      result.geo_fallback = "text_match";
      // 尝试从城市名推断国家
      if (!result.country_zh) {
        result.country_zh = inferCountryFromCity(matched);
      }
      return result;
    }
  }

  // Step 2: 从域名推断
  if (!result.country_zh && ctx.domain) {
    const inferred = inferCountryFromDomain(ctx.domain);
    if (inferred) {
      result.country_zh = inferred;
      // 从国家名获取首都/主要城市
      if (!result.city_zh && COUNTRY_TO_CITY[inferred]) {
        result.city_zh = COUNTRY_TO_CITY[inferred];
      }
      result.geo_fallback = "domain_infer";
      return result;
    }
  }

  // Step 3: 从区域经理上下文推断
  if (ctx.region) {
    const inferred = inferFromRegion(ctx);
    if (inferred.city && !result.city_zh) {
      result.city_zh = inferred.city;
      result.geo_fallback = "region_context";
    }
    if (inferred.country && !result.country_zh) {
      result.country_zh = inferred.country;
    }
    if (result.geo_fallback === "ai") result.geo_fallback = "region_context";
    return result;
  }

  // Step 4: 从国家名反推城市(如果有国家没城市)
  if (result.country_zh && !result.city_zh && COUNTRY_TO_CITY[result.country_zh]) {
    result.city_zh = COUNTRY_TO_CITY[result.country_zh];
    result.geo_fallback = result.geo_fallback === "ai" ? "country_infer" : result.geo_fallback;
  }

  // Step 5: 都没有,标记为 "未知" (不再为 null)
  if (!result.city_zh) {
    result.city_zh = "未知";
    result.geo_fallback = result.geo_fallback === "ai" ? "unknown" : result.geo_fallback;
  }
  if (!result.country_zh) {
    result.country_zh = "未知";
  }

  return result;
}

/**
 * 从城市名推断国家(简化版)
 */
function inferCountryFromCity(city) {
  // 中国城市默认中国
  const chineseCities = ["北京", "上海", "广州", "深圳", "成都", "重庆", "天津", "南京",
    "杭州", "武汉", "西安", "厦门", "长沙", "郑州", "青岛", "苏州", "沈阳", "大连",
    "昆明", "济南", "宁波", "合肥", "福州", "无锡", "南昌", "贵阳", "太原", "石家庄",
    "哈尔滨", "长春", "南宁", "兰州", "海口", "三亚", "景德镇", "银川", "乌鲁木齐",
    "呼和浩特", "拉萨", "西宁", "珠海", "佛山", "东莞", "中山", "惠州", "泉州",
    "温州", "绍兴", "嘉兴", "金华", "台州", "烟台", "潍坊", "临沂", "徐州", "扬州",
    "南通", "常州"];
  if (chineseCities.includes(city)) return "中国";

  const cityCountryMap = {
    // 中文名映射
    "香港": "中国香港", "澳门": "中国澳门", "台北": "中国台湾", "高雄": "中国台湾",
    "台中": "中国台湾", "台南": "中国台湾", "新竹": "中国台湾",
    "东京": "日本", "大阪": "日本", "京都": "日本",
    "首尔": "韩国", "釜山": "韩国",
    "新加坡": "新加坡", "曼谷": "泰国", "吉隆坡": "马来西亚",
    "雅加达": "印度尼西亚", "马尼拉": "菲律宾", "河内": "越南",
    "孟买": "印度", "新德里": "印度",
    "迪拜": "阿联酋", "沙迦": "阿联酋", "阿布扎比": "阿联酋", "多哈": "卡塔尔",
    "伊斯坦布尔": "土耳其", "特拉维夫": "以色列",
    "巴黎": "法国", "伦敦": "英国", "柏林": "德国", "罗马": "意大利",
    "米兰": "意大利", "威尼斯": "意大利", "马德里": "西班牙", "巴塞罗那": "西班牙",
    "阿姆斯特丹": "荷兰", "维也纳": "奥地利", "苏黎世": "瑞士", "日内瓦": "瑞士",
    "布鲁塞尔": "比利时", "慕尼黑": "德国", "法兰克福": "德国",
    "哥本哈根": "丹麦", "斯德哥尔摩": "瑞典", "奥斯陆": "挪威",
    "赫尔辛基": "芬兰", "都柏林": "爱尔兰", "里斯本": "葡萄牙", "雅典": "希腊",
    "布拉格": "捷克", "华沙": "波兰", "布达佩斯": "匈牙利", "莫斯科": "俄罗斯",
    "纽约": "美国", "洛杉矶": "美国", "旧金山": "美国", "芝加哥": "美国",
    "波士顿": "美国", "华盛顿": "美国", "西雅图": "美国", "迈阿密": "美国",
    "费城": "美国", "匹兹堡": "美国",
    "多伦多": "加拿大", "温哥华": "加拿大", "蒙特利尔": "加拿大",
    "墨西哥城": "墨西哥",
    "圣保罗": "巴西", "里约热内卢": "巴西", "布宜诺斯艾利斯": "阿根廷",
    "圣地亚哥": "智利", "利马": "秘鲁", "波哥大": "哥伦比亚",
    "悉尼": "澳大利亚", "墨尔本": "澳大利亚", "奥克兰": "新西兰", "珀斯": "澳大利亚",
    "开罗": "埃及", "拉各斯": "尼日利亚", "约翰内斯堡": "南非", "内罗毕": "肯尼亚",
    "卡萨布兰卡": "摩洛哥", "开普敦": "南非",
    // 英文名映射(用于英文原文匹配)
    "Tokyo": "日本", "Osaka": "日本", "Kyoto": "日本", "Yokohama": "日本",
    "Seoul": "韩国", "Busan": "韩国",
    "Singapore": "新加坡", "Bangkok": "泰国", "Kuala Lumpur": "马来西亚",
    "Jakarta": "印度尼西亚", "Manila": "菲律宾", "Hanoi": "越南",
    "Mumbai": "印度", "Delhi": "印度", "New Delhi": "印度",
    "Dubai": "阿联酋", "Sharjah": "阿联酋", "Abu Dhabi": "阿联酋", "Doha": "卡塔尔",
    "Istanbul": "土耳其", "Tel Aviv": "以色列",
    "Paris": "法国", "London": "英国", "Berlin": "德国", "Rome": "意大利",
    "Milan": "意大利", "Venice": "意大利", "Madrid": "西班牙", "Barcelona": "西班牙",
    "Amsterdam": "荷兰", "Vienna": "奥地利", "Zurich": "瑞士", "Geneva": "瑞士",
    "Brussels": "比利时", "Munich": "德国", "Frankfurt": "德国",
    "Copenhagen": "丹麦", "Stockholm": "瑞典", "Oslo": "挪威",
    "Helsinki": "芬兰", "Dublin": "爱尔兰", "Lisbon": "葡萄牙", "Athens": "希腊",
    "Prague": "捷克", "Warsaw": "波兰", "Budapest": "匈牙利", "Moscow": "俄罗斯",
    "New York": "美国", "New York City": "美国", "Los Angeles": "美国",
    "San Francisco": "美国", "Chicago": "美国",
    "Boston": "美国", "Washington": "美国", "Seattle": "美国", "Miami": "美国",
    "Philadelphia": "美国", "Pittsburgh": "美国",
    "Toronto": "加拿大", "Vancouver": "加拿大", "Montreal": "加拿大",
    "Mexico City": "墨西哥",
    "Sao Paulo": "巴西", "Rio de Janeiro": "巴西", "Buenos Aires": "阿根廷",
    "Santiago": "智利", "Lima": "秘鲁", "Bogota": "哥伦比亚",
    "Sydney": "澳大利亚", "Melbourne": "澳大利亚", "Auckland": "新西兰", "Perth": "澳大利亚",
    "Cairo": "埃及", "Lagos": "尼日利亚", "Johannesburg": "南非", "Nairobi": "肯尼亚",
    "Casablanca": "摩洛哥", "Cape Town": "南非", "Hong Kong": "中国香港",
    "Macau": "中国澳门", "Taipei": "中国台湾", "Kaohsiung": "中国台湾"
  };
  return cityCountryMap[city] || null;
}

/**
 * 加载城市坐标(供前端地图落点使用)
 * 与 globe-data.js 的 CITY 表保持一致
 */
export function getCityCoords(cityName) {
  return CITY_MAP[cityName] || null;
}

/**
 * 验证一个城市名是否在已知列表中
 */
export function isKnownCity(name) {
  return name && CITY_MAP[name] !== undefined;
}

/**
 * 获取所有已知城市列表
 */
export function getAllKnownCities() {
  return Object.keys(CITY_MAP);
}
