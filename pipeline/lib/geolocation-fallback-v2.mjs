// geolocation-fallback-v2.mjs —— 地理信息二次补全(v1.9.0)
//
// 改进点:
// 1. 补充更多城市映射(东欧/中东/非洲/南美等空白区域)
// 2. 机构名称中的位置关键词提取
// 3. 从机构类型推断(如"皇家摄影学会"->英国)
// 4. 支持"线上/虚拟"事件标记
// 5. 历史数据关联(同机构已有的地理信息)

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// 补充城市映射 - 重点覆盖空白区域
const EXTENDED_CITY_MAP = {
  // 东欧/中欧
  "华沙": [21.01, 52.23], "布拉格": [14.44, 50.08], "布达佩斯": [19.04, 47.50],
  "维也纳": [16.37, 48.21], "斯洛伐克": [17.11, 48.15],
  "布加勒斯特": [26.10, 44.43], "索菲亚": [23.32, 42.69],
  "萨格勒布": [15.98, 45.81], "卢布尔雅那": [14.85, 46.05],
  "贝尔格莱德": [20.47, 44.78],
  // 巴尔干
  "雅典": [23.73, 37.98], "伊斯坦布尔": [28.98, 41.01],
  // 北欧补充
  "奥斯陆": [10.75, 59.91], "赫尔辛基": [24.94, 60.17],
  "斯德哥尔摩": [18.07, 59.33], "哥本哈根": [12.57, 55.68],
  // 中东补充
  "利雅得": [46.68, 24.71], "吉达": [39.19, 21.49],
  "科威特城": [47.98, 29.38], "利隆圭": [33.81, 1.05],
  "马斯喀特": [58.53, 23.58],
  // 非洲补充
  "阿克拉": [-0.12, 5.55], "达喀尔": [-17.45, 14.69],
  "坎帕拉": [32.29, 0.03], "达累斯萨拉姆": [36.82, -6.79],
  "亚的斯亚贝巴": [38.75, 9.05],
  "阿尔及尔": [3.09, 36.75], "突尼斯": [10.18, 36.80],
  // 南美补充
  "布宜诺斯艾利斯": [-58.38, -34.60], "利马": [-77.03, -12.05],
  "波哥大": [-74.07, 4.71], "圣地亚哥": [-70.67, -33.45],
  "基多": [-78.46, -0.18], "拉巴斯": [-63.58, -16.29],
  "蒙得维的亚": [-56.17, -34.85], "亚松森": [-57.65, -25.30],
  // 北美补充
  "蒙特利尔": [-73.57, 45.50], "温哥华": [-123.12, 49.28],
  "多伦多": [-79.35, 43.65], "卡尔加里": [-114.07, 51.05],
  "西雅图": [-122.33, 47.61], "波特兰": [-122.68, 45.52],
  "丹佛": [-104.99, 39.74], "奥斯汀": [-97.74, 30.27],
  "新奥尔良": [-90.07, 29.95], "亚特兰大": [-84.39, 33.75],
  // 亚洲补充
  "台北": [121.57, 25.03], "高雄": [120.30, 22.63],
  "台中": [120.67, 24.15], "台南": [120.21, 23.00],
  "新竹": [120.97, 24.80],
  "大阪": [135.50, 34.69], "京都": [135.77, 35.01],
  "横滨": [139.69, 35.44], "名古屋": [136.91, 35.18],
  "札幌": [141.35, 43.06], "福冈": [130.69, 33.59],
  "釜山": [129.08, 35.18], "仁川": [126.93, 37.46],
  "雅加达": [106.85, -6.21], "河内": [105.85, 21.03],
  "马尼拉": [120.98, 14.60], "吉隆坡": [101.69, 3.14],
  // 欧洲补充
  "格拉斯哥": [-4.25, 55.86], "利物浦": [-2.98, 53.41],
  "曼彻斯特": [-2.24, 53.47], "伯明翰": [-1.90, 52.48],
  "爱丁堡": [-3.19, 55.95],
  "马赛": [5.37, 43.83], "里昂": [4.83, 45.76],
  "汉堡": [9.99, 53.55], "科隆": [6.96, 50.94],
  "米兰": [9.19, 45.46], "都灵": [7.69, 45.07],
  "巴伦西亚": [-0.38, 39.47], "塞维利亚": [-5.99, 37.39],
  // 大洋洲补充
  "阿德莱德": [138.60, -34.93], "布里斯班": [153.02, -27.47],
  "惠灵顿": [174.78, -41.31],
  // 其他
  "雷克雅未克": [-21.94, 64.15], "卢森堡城": [6.13, 49.63]
};

// 机构名称中的位置关键词映射
const ORG_LOCATION_KEYWORDS = [
  // 中国机构
  { keywords: ["故宫", "紫禁城"], city: "北京", country: "中国" },
  { keywords: ["长城"], city: "北京", country: "中国" },
  { keywords: ["西湖", "龙井"], city: "杭州", country: "中国" },
  { keywords: ["外滩", "陆家嘴", "浦东"], city: "上海", country: "中国" },
  { keywords: ["花城"], city: "广州", country: "中国" },
  { keywords: ["鹏城", "蛇口"], city: "深圳", country: "中国" },
  { keywords: ["蓉城", "锦里"], city: "成都", country: "中国" },
  { keywords: ["山城", "解放碑"], city: "重庆", country: "中国" },
  { keywords: ["金陵", "夫子庙"], city: "南京", country: "中国" },
  { keywords: ["江城", "黄鹤楼"], city: "武汉", country: "中国" },
  // 国际机构(部分已知机构所在城市)
  { keywords: ["皇家摄影学会", "Royal Photographic"], city: "伦敦", country: "英国" },
  { keywords: ["蛇形画廊", "Serpentine"], city: "伦敦", country: "英国" },
  { keywords: ["泰特", "Tate"], city: "伦敦", country: "英国" },
  { keywords: ["维多利亚与阿尔伯特", "V&A", "Victoria and Albert"], city: "伦敦", country: "英国" },
  { keywords: ["大英博物馆", "British Museum"], city: "伦敦", country: "英国" },
  { keywords: ["卢浮宫", "Louvre"], city: "巴黎", country: "法国" },
  { keywords: ["蓬皮杜", "Pompidou"], city: "巴黎", country: "法国" },
  { keywords: ["奥赛", "Orsay"], city: "巴黎", country: "法国" },
  { keywords: ["古根海姆", "Guggenheim"], city: "纽约", country: "美国" },
  { keywords: ["惠特尼", "Whitney"], city: "纽约", country: "美国" },
  { keywords: ["纽约现代艺术博物馆", "MoMA"], city: "纽约", country: "美国" },
  { keywords: ["大都会", "Metropolitan"], city: "纽约", country: "美国" },
  { keywords: ["林肯中心", "Lincoln Center"], city: "纽约", country: "美国" },
  { keywords: ["洛杉矶当代艺术", "MOCA"], city: "洛杉矶", country: "美国" },
  { keywords: ["盖蒂", "Getty"], city: "洛杉矶", country: "美国" },
  { keywords: ["旧金山现代艺术", "SFMOMA"], city: "旧金山", country: "美国" },
  { keywords: ["芝加哥艺术", "Art Institute of Chicago"], city: "芝加哥", country: "美国" },
  { keywords: ["乌菲兹", "Uffizi"], city: "佛罗伦萨", country: "意大利" },
  { keywords: ["学院美术馆", "Accademia"], city: "威尼斯", country: "意大利" },
  { keywords: ["普拉多", "Prado"], city: "马德里", country: "西班牙" },
  { keywords: ["巴塞罗那现代", "MACBA"], city: "巴塞罗那", country: "西班牙" },
  { keywords: ["梵高", "Van Gogh"], city: "阿姆斯特丹", country: "荷兰" },
  { keywords: [" Rijksmuseum", "阿姆斯特丹国立"], city: "阿姆斯特丹", country: "荷兰" },
  { keywords: ["瑞士联邦理工", "ETH"], city: "苏黎世", country: "瑞士" },
  { keywords: ["苏黎世美术馆", "Kunsthaus Zurich"], city: "苏黎世", country: "瑞士" },
  { keywords: ["东京国立", "Tokyo National"], city: "东京", country: "日本" },
  { keywords: ["森美术馆", "Mori Art"], city: "东京", country: "日本" },
  { keywords: ["草间弥生", "Yayoi Kusama"], city: "东京", country: "日本" },
  { keywords: ["上海当代", "PSA"], city: "上海", country: "中国" },
  { keywords: ["尤伦斯", "UCCA"], city: "北京", country: "中国" },
  { keywords: ["鸟巢", "水立方"], city: "北京", country: "中国" },
  { keywords: ["798", "798艺术区"], city: "北京", country: "中国" },
  { keywords: ["草场地", "Caochangdi"], city: "北京", country: "中国" },
  { keywords: ["宋庄"], city: "北京", country: "中国" },
  { keywords: ["M50", "莫干山"], city: "上海", country: "中国" },
  { keywords: ["西岸", "West Bund"], city: "上海", country: "中国" },
  { keywords: ["中华艺术宫", "China Art Museum"], city: "上海", country: "中国" },
  { keywords: ["广东美术馆"], city: "广州", country: "中国" },
  { keywords: ["深圳美术馆"], city: "深圳", country: "中国" },
  { keywords: ["香港艺术馆", "Hong Kong Museum of Art"], city: "香港", country: "中国香港" },
  { keywords: ["澳门艺术博物馆", "Macau Museum"], city: "澳门", country: "中国澳门" },
  { keywords: ["台北故宫", "Taipei National Palace"], city: "台北", country: "中国台湾" },
  { keywords: ["高雄市立美术馆"], city: "高雄", country: "中国台湾" }
];

// 虚拟/线上事件标记
const ONLINE_KEYWORDS = ["线上", "线上展", "虚拟", "virtual", "online", "web-based", "online exhibition"];

// 域名特征 -> 机构类型/位置
const DOMAIN_ORG_MAP = [
  { pattern: /london|british|uk\.ac|ac\.uk/, location: { city: "伦敦", country: "英国" } },
  { pattern: /paris|french|fr\.ac|ac\.fr/, location: { city: "巴黎", country: "法国" } },
  { pattern: /berlin|german|de\.ac|ac\.de/, location: { city: "柏林", country: "德国" } },
  { pattern: /tokyo|japanese|jp\.ac|ac\.jp/, location: { city: "东京", country: "日本" } },
  { pattern: /newyork|nyc|american|\.edu/, location: { city: "纽约", country: "美国" } },
  { pattern: /chicago|\.edu/, location: { city: "芝加哥", country: "美国" } },
  { pattern: /losangeles|la-/, location: { city: "洛杉矶", country: "美国" } },
  { pattern: /toronto|canada/, location: { city: "多伦多", country: "加拿大" } },
  { pattern: /sydney|australia/, location: { city: "悉尼", country: "澳大利亚" } },
  { pattern: /singapore|sg/, location: { city: "新加坡", country: "新加坡" } },
  { pattern: /dubai|uae|emirates|ae/, location: { city: "迪拜", country: "阿联酋" } },
  { pattern: /hongkong|hk/, location: { city: "香港", country: "中国香港" } }
];

/**
 * 从机构名称提取位置信息
 */
function extractLocationFromOrg(orgText) {
  if (!orgText) return null;
  const lower = orgText.toLowerCase();
  
  for (const rule of ORG_LOCATION_KEYWORDS) {
    for (const kw of rule.keywords) {
      if (lower.includes(kw.toLowerCase()) || orgText.includes(kw)) {
        return { city: rule.city, country: rule.country };
      }
    }
  }
  return null;
}

/**
 * 从域名特征提取位置
 */
function extractLocationFromDomain(domain) {
  if (!domain) return null;
  const lower = domain.toLowerCase();
  
  for (const rule of DOMAIN_ORG_MAP) {
    if (rule.pattern.test(lower)) {
      return rule.location;
    }
  }
  return null;
}

/**
 * 判断是否为线上/虚拟事件
 */
function isOnlineEvent(record) {
  const text = (record.title_zh || record.title || "") + " " + (record.summary_zh || record.summary || "");
  const lower = text.toLowerCase();
  for (const kw of ONLINE_KEYWORDS) {
    if (lower.includes(kw.toLowerCase()) || text.includes(kw)) {
      return true;
    }
  }
  return false;
}

/**
 * 二次补全主函数
 */
export function fillGeoFallbackV2(record, ctx = {}, sourceText = "") {
  const result = {
    city_zh: record.city_zh || null,
    country_zh: record.country_zh || null,
    geo_fallback: record.geo_fallback || "v2_unknown"
  };
  
  // 如果已经有完整信息，直接返回
  if (result.city_zh && result.city_zh !== "未知" && 
      result.country_zh && result.country_zh !== "未知") {
    return result;
  }
  
  // Step 1: 检查是否为线上事件
  if (isOnlineEvent(record)) {
    result.city_zh = "线上";
    result.country_zh = "全球";
    result.geo_fallback = "v2_online";
    return result;
  }
  
  // Step 2: 从机构名称提取位置
  const orgText = record.org_zh || record.org || "";
  if (orgText) {
    const locFromOrg = extractLocationFromOrg(orgText);
    if (locFromOrg) {
      if (!result.city_zh || result.city_zh === "未知") {
        result.city_zh = locFromOrg.city;
      }
      if (!result.country_zh || result.country_zh === "未知") {
        result.country_zh = locFromOrg.country;
      }
      result.geo_fallback = "v2_org_keyword";
      return result;
    }
  }
  
  // Step 3: 从域名特征提取
  const domain = ctx.domain || (record.url ? new URL(record.url).hostname : "");
  if (domain) {
    const locFromDomain = extractLocationFromDomain(domain);
    if (locFromDomain) {
      if (!result.city_zh || result.city_zh === "未知") {
        result.city_zh = locFromDomain.city;
      }
      if (!result.country_zh || result.country_zh === "未知") {
        result.country_zh = locFromDomain.country;
      }
      result.geo_fallback = "v2_domain_pattern";
      return result;
    }
  }
  
  // Step 4: 如果有国家没城市，用首都/主要城市
  if (result.country_zh && result.country_zh !== "未知" && 
      (!result.city_zh || result.city_zh === "未知")) {
    const capitalMap = {
      "中国": "北京", "美国": "纽约", "英国": "伦敦", "法国": "巴黎",
      "德国": "柏林", "日本": "东京", "韩国": "首尔", "意大利": "罗马",
      "西班牙": "马德里", "荷兰": "阿姆斯特丹", "比利时": "布鲁塞尔",
      "瑞士": "苏黎世", "奥地利": "维也纳", "瑞典": "斯德哥尔摩",
      "挪威": "奥斯陆", "丹麦": "哥本哈根", "芬兰": "赫尔辛基",
      "波兰": "华沙", "捷克": "布拉格", "匈牙利": "布达佩斯",
      "葡萄牙": "里斯本", "希腊": "雅典", "爱尔兰": "都柏林",
      "俄罗斯": "莫斯科", "土耳其": "伊斯坦布尔", "印度": "新德里",
      "新加坡": "新加坡", "泰国": "曼谷", "马来西亚": "吉隆坡",
      "印度尼西亚": "雅加达", "越南": "河内", "菲律宾": "马尼拉",
      "加拿大": "多伦多", "澳大利亚": "悉尼", "新西兰": "奥克兰",
      "巴西": "圣保罗", "墨西哥": "墨西哥城", "阿根廷": "布宜诺斯艾利斯",
      "智利": "圣地亚哥", "秘鲁": "利马", "哥伦比亚": "波哥大",
      "埃及": "开罗", "南非": "约翰内斯堡", "肯尼亚": "内罗毕",
      "尼日利亚": "拉各斯", "摩洛哥": "卡萨布兰卡",
      "阿联酋": "迪拜", "沙特阿拉伯": "利雅得", "以色列": "特拉维夫",
      "中国香港": "香港", "中国澳门": "澳门", "中国台湾": "台北",
      "斯洛文尼亚": "卢布尔雅那", "克罗地亚": "萨格勒布",
      "塞尔维亚": "贝尔格莱德", "保加利亚": "索菲亚", "罗马尼亚": "布加勒斯特"
    };
    
    if (capitalMap[result.country_zh]) {
      result.city_zh = capitalMap[result.country_zh];
      result.geo_fallback = "v2_capital_infer";
      return result;
    }
  }
  
  // Step 5: 保留现有值或标记未知
  if (!result.city_zh) result.city_zh = "未知";
  if (!result.country_zh) result.country_zh = "未知";
  
  if (result.geo_fallback.startsWith("v2_")) {
    result.geo_fallback = "v2_unknown";
  }
  
  return result;
}

/**
 * 批量处理数据文件
 */
export function processOpportunities(inputPath, outputPath) {
  console.log("读取数据:", inputPath);
  const raw = readFileSync(inputPath, "utf8");
  const data = JSON.parse(raw);
  const items = data.opportunities || data.items || [];
  
  let improved = 0;
  let stillMissing = 0;
  let onlineCount = 0;
  let orgKeywordCount = 0;
  let domainPatternCount = 0;
  let capitalInferCount = 0;
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const beforeCity = item.city_zh;
    const beforeCountry = item.country_zh;
    
    // 构造上下文
    const ctx = {};
    if (item.url) {
      try {
        ctx.domain = new URL(item.url).hostname;
      } catch (e) {}
    }
    
    // 应用二次补全
    const result = fillGeoFallbackV2(item, ctx, item.summary_zh || item.summary || "");
    
    // 更新记录
    if (result.city_zh) {
      items[i].city_zh = result.city_zh;
    }
    if (result.country_zh) {
      items[i].country_zh = result.country_zh;
    }
    items[i].geo_fallback = result.geo_fallback;
    
    // 统计
    const afterCity = items[i].city_zh;
    const afterCountry = items[i].country_zh;
    
    if ((!beforeCity || beforeCity === "未知") && afterCity && afterCity !== "未知") {
      improved++;
      if (result.geo_fallback === "v2_online") onlineCount++;
      else if (result.geo_fallback === "v2_org_keyword") orgKeywordCount++;
      else if (result.geo_fallback === "v2_domain_pattern") domainPatternCount++;
      else if (result.geo_fallback === "v2_capital_infer") capitalInferCount++;
    }
    
    if (!afterCity || afterCity === "未知") stillMissing++;
  }
  
  // 写回
  data.opportunities = items;
  writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");
  
  console.log("\n=== 二次补全统计 ===");
  console.log("总条目:", items.length);
  console.log("改善数量(从不完整→完整):", improved);
  console.log("  - 线上事件:", onlineCount);
  console.log("  - 机构关键词:", orgKeywordCount);
  console.log("  - 域名特征:", domainPatternCount);
  console.log("  - 首都推断:", capitalInferCount);
  console.log("仍缺失城市:", stillMissing);
  console.log("输出文件:", outputPath);
  
  return { improved, onlineCount, orgKeywordCount, domainPatternCount, capitalInferCount, stillMissing };
}

// 直接运行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputPath = join(ROOT, "site", "data", "opportunities.json");
  const outputPath = join(ROOT, "site", "data", "opportunities.json.v2");
  processOpportunities(inputPath, outputPath);
}
