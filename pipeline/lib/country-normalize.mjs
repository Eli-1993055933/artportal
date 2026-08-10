// country-normalize.mjs —— 国家名统一映射(v1.8.0)
//
// 解决问题:同一国家在数据中有多种写法(美国/United States/USA),
// 导致前端聚合展示时无法正确合并。
//
// 策略:建立统一映射表,所有存储和展示都走这个映射。

// 国家名统一映射表:各种别名 -> 标准中文名
export const COUNTRY_NORMALIZE_MAP = {
  // 中国
  "中国": "中国", "China": "中国", "中國": "中国", "PRC": "中国",
  "People's Republic of China": "中国",
  "中国香港": "中国香港", "香港": "中国香港", "Hong Kong": "中国香港",
  "中国澳门": "中国澳门", "澳门": "中国澳门", "Macau": "中国澳门", "Macao": "中国澳门",
  "中国台湾": "中国台湾", "台湾": "中国台湾", "Taiwan": "中国台湾",
  // 美国
  "美国": "美国", "United States": "美国", "USA": "美国", "US": "美国",
  "United States of America": "美国", "America": "美国",
  // 英国
  "英国": "英国", "United Kingdom": "英国", "UK": "英国", "Britain": "英国",
  "Great Britain": "英国", "England": "英国", "Scotland": "英国",
  // 法国
  "法国": "法国", "France": "法国", "French": "法国",
  // 德国
  "德国": "德国", "Germany": "德国", "Deutschland": "德国",
  // 意大利
  "意大利": "意大利", "Italy": "意大利", "Italia": "意大利",
  // 西班牙
  "西班牙": "西班牙", "Spain": "西班牙", "España": "西班牙", "Espana": "西班牙",
  // 荷兰
  "荷兰": "荷兰", "Netherlands": "荷兰", "Holland": "荷兰", "Nederland": "荷兰",
  // 比利时
  "比利时": "比利时", "Belgium": "比利时", "Belgique": "比利时",
  // 瑞士
  "瑞士": "瑞士", "Switzerland": "瑞士", "Schweiz": "瑞士", "Suisse": "瑞士",
  // 奥地利
  "奥地利": "奥地利", "Austria": "奥地利", "Österreich": "奥地利",
  // 日本
  "日本": "日本", "Japan": "日本", "JPN": "日本", "Nihon": "日本",
  // 韩国
  "韩国": "韩国", "South Korea": "韩国", "Korea": "韩国",
  "Republic of Korea": "韩国", "Corea del Sur": "韩国",
  // 朝鲜
  "朝鲜": "朝鲜", "North Korea": "朝鲜", "DPRK": "朝鲜",
  // 新加坡
  "新加坡": "新加坡", "Singapore": "新加坡", "SGP": "新加坡",
  // 泰国
  "泰国": "泰国", "Thailand": "泰国", "Thai": "泰国", "Siam": "泰国",
  // 越南
  "越南": "越南", "Vietnam": "越南", "Viet Nam": "越南",
  // 印度
  "印度": "印度", "India": "印度", "Inde": "印度",
  // 印度尼西亚
  "印度尼西亚": "印度尼西亚", "Indonesia": "印度尼西亚",
  // 马来西亚
  "马来西亚": "马来西亚", "Malaysia": "马来西亚",
  // 菲律宾
  "菲律宾": "菲律宾", "Philippines": "菲律宾", "Filipinas": "菲律宾",
  // 阿联酋
  "阿联酋": "阿联酋", "United Arab Emirates": "阿联酋", "UAE": "阿联酋", "Emirates": "阿联酋",
  // 沙特
  "沙特阿拉伯": "沙特阿拉伯", "Saudi Arabia": "沙特阿拉伯", "Saudi": "沙特阿拉伯",
  // 卡塔尔
  "卡塔尔": "卡塔尔", "Qatar": "卡塔尔",
  // 以色列
  "以色列": "以色列", "Israel": "以色列", "Israël": "以色列",
  // 土耳其
  "土耳其": "土耳其", "Turkey": "土耳其", "Türkiye": "土耳其",
  // 加拿大
  "加拿大": "加拿大", "Canada": "加拿大", "CAN": "加拿大",
  // 澳大利亚
  "澳大利亚": "澳大利亚", "Australia": "澳大利亚", "AUS": "澳大利亚",
  // 新西兰
  "新西兰": "新西兰", "New Zealand": "新西兰", "NZL": "新西兰",
  // 巴西
  "巴西": "巴西", "Brazil": "巴西", "Brasil": "巴西",
  // 墨西哥
  "墨西哥": "墨西哥", "Mexico": "墨西哥", "México": "墨西哥",
  // 阿根廷
  "阿根廷": "阿根廷", "Argentina": "阿根廷",
  // 智利
  "智利": "智利", "Chile": "智利",
  // 哥伦比亚
  "哥伦比亚": "哥伦比亚", "Colombia": "哥伦比亚",
  // 秘鲁
  "秘鲁": "秘鲁", "Peru": "秘鲁", "Perú": "秘鲁",
  // 俄罗斯
  "俄罗斯": "俄罗斯", "Russia": "俄罗斯", "Russian Federation": "俄罗斯",
  // 葡萄牙
  "葡萄牙": "葡萄牙", "Portugal": "葡萄牙",
  // 希腊
  "希腊": "希腊", "Greece": "希腊", "Hellas": "希腊",
  // 爱尔兰
  "爱尔兰": "爱尔兰", "Ireland": "爱尔兰", "Eire": "爱尔兰",
  // 北欧
  "丹麦": "丹麦", "Denmark": "丹麦", "Danmark": "丹麦",
  "瑞典": "瑞典", "Sweden": "瑞典", "Sverige": "瑞典",
  "挪威": "挪威", "Norway": "挪威", "Norge": "挪威",
  "芬兰": "芬兰", "Finland": "芬兰", "Suomi": "芬兰",
  "冰岛": "冰岛", "Iceland": "冰岛", "Ísland": "冰岛",
  // 东欧
  "波兰": "波兰", "Poland": "波兰", "Polska": "波兰",
  "捷克": "捷克", "Czech Republic": "捷克", "Czechia": "捷克", "Česko": "捷克",
  "匈牙利": "匈牙利", "Hungary": "匈牙利", "Magyarország": "匈牙利",
  "斯洛伐克": "斯洛伐克", "Slovakia": "斯洛伐克",
  "斯洛文尼亚": "斯洛文尼亚", "Slovenia": "斯洛文尼亚",
  "克罗地亚": "克罗地亚", "Croatia": "克罗地亚",
  "乌克兰": "乌克兰", "Ukraine": "乌克兰",
  // 非洲
  "埃及": "埃及", "Egypt": "埃及",
  "南非": "南非", "South Africa": "南非", "ZA": "南非",
  "尼日利亚": "尼日利亚", "Nigeria": "尼日利亚",
  "肯尼亚": "肯尼亚", "Kenya": "肯尼亚",
  "摩洛哥": "摩洛哥", "Morocco": "摩洛哥", "Maroc": "摩洛哥",
  "埃塞俄比亚": "埃塞俄比亚", "Ethiopia": "埃塞俄比亚",
  "加纳": "加纳", "Ghana": "加纳",
  "坦桑尼亚": "坦桑尼亚", "Tanzania": "坦桑尼亚",
  // 其他
  "卢森堡": "卢森堡", "Luxembourg": "卢森堡", "Luxemburg": "卢森堡",
  "列支敦士登": "列支敦士登", "Liechtenstein": "列支敦士登",
  "摩纳哥": "摩纳哥", "Monaco": "摩纳哥",
  "安道尔": "安道尔", "Andorra": "安道尔",
  "圣马力诺": "圣马力诺", "San Marino": "圣马力诺",
  "梵蒂冈": "梵蒂冈", "Vatican": "梵蒂冈", "Vatican City": "梵蒂冈",
  "塞浦路斯": "塞浦路斯", "Cyprus": "塞浦路斯",
  "马耳他": "马耳他", "Malta": "马耳他",
  "罗马尼亚": "罗马尼亚", "Romania": "罗马尼亚", "Roumanie": "罗马尼亚",
  "保加利亚": "保加利亚", "Bulgaria": "保加利亚",
  "塞尔维亚": "塞尔维亚", "Serbia": "塞尔维亚",
  "立陶宛": "立陶宛", "Lithuania": "立陶宛",
  "拉脱维亚": "拉脱维亚", "Latvia": "拉脱维亚",
  "爱沙尼亚": "爱沙尼亚", "Estonia": "爱沙尼亚",
  "印度": "印度", "Bharat": "印度",
  "哈萨克斯坦": "哈萨克斯坦", "Kazakhstan": "哈萨克斯坦",
  "乌兹别克斯坦": "乌兹别克斯坦", "Uzbekistan": "乌兹别克斯坦",
  "巴基斯坦": "巴基斯坦", "Pakistan": "巴基斯坦",
  "孟加拉国": "孟加拉国", "Bangladesh": "孟加拉国",
  "斯里兰卡": "斯里兰卡", "Sri Lanka": "斯里兰卡",
  "尼泊尔": "尼泊尔", "Nepal": "尼泊尔",
  "柬埔寨": "柬埔寨", "Cambodia": "柬埔寨",
  "缅甸": "缅甸", "Myanmar": "缅甸", "Burma": "缅甸",
  "老挝": "老挝", "Laos": "老挝",
  "蒙古": "蒙古", "Mongolia": "蒙古",
  // 特殊
  "未知": "未知", "Unknown": "未知",
  "其他": "未知", "Other": "未知"
};

/**
 * 统一国家名
 * @param {string|null} name - 原始国家名
 * @returns {string} 标准化后的国家名
 */
export function normalizeCountry(name) {
  if (!name || name.trim() === "") return "未知";
  const trimmed = name.trim();
  // 直接命中
  if (COUNTRY_NORMALIZE_MAP[trimmed]) return COUNTRY_NORMALIZE_MAP[trimmed];
  // 小写匹配
  const lower = trimmed.toLowerCase();
  for (const [key, value] of Object.entries(COUNTRY_NORMALIZE_MAP)) {
    if (key.toLowerCase() === lower) return value;
  }
  // 模糊匹配:检查是否包含
  for (const [key, value] of Object.entries(COUNTRY_NORMALIZE_MAP)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return value;
    }
  }
  // 无法识别,返回原值(而不是"未知",避免误合并)
  return trimmed;
}

/**
 * 检查国家名是否需要标准化
 * @param {string|null} name
 * @returns {boolean}
 */
export function needsNormalization(name) {
  if (!name) return false;
  const normalized = normalizeCountry(name);
  return normalized !== name.trim();
}

/**
 * 获取所有标准国家名列表
 * @returns {string[]}
 */
export function getAllStandardCountries() {
  const set = new Set(Object.values(COUNTRY_NORMALIZE_MAP));
  return Array.from(set).sort();
}
