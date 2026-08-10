import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("../site/data/opportunities.json", "utf8"));
const items = data.opportunities || [];

// 读取前端的城市/国家映射
const globeCode = readFileSync("../site/js/globe-data.js", "utf8");

// 提取城市映射
const cityNames = new Set();
const cityRegex = /"([^"]+)":\s*\[\s*[-\d.]+\s*,\s*[-\d.]+\s*\]/g;
let m;
while ((m = cityRegex.exec(globeCode)) !== null) {
  cityNames.add(m[1]);
}

// 提取国家映射  
const countryNames = new Set();
const countrySection = globeCode.match(/var COUNTRY = \{([^}]+)\}/s);
if (countrySection) {
  const cRegex = /"([^"]+)":\s*\[\s*[-\d.]+\s*,\s*[-\d.]+\s*\]/g;
  while ((m = cRegex.exec(countrySection[1])) !== null) {
    countryNames.add(m[1]);
  }
}

console.log("前端已配置城市数:", cityNames.size);
console.log("前端已配置国家数:", countryNames.size);

// 检查数据中的城市覆盖率
const missingCities = new Set();
const missingCountries = new Set();
let cityFound = 0, countryFound = 0;
let cityMissingCount = 0, countryMissingCount = 0;

items.forEach(item => {
  const city = item.city_zh;
  const country = item.country_zh;
  
  if (city && city !== "未知") {
    if (cityNames.has(city)) cityFound++;
    else { missingCities.add(city); cityMissingCount++; }
  }
  
  if (country && country !== "未知") {
    if (countryNames.has(country)) countryFound++;
    else { missingCountries.add(country); countryMissingCount++; }
  }
});

console.log("\n城市匹配:");
console.log("  已匹配:", cityFound);
console.log("  未匹配:", cityMissingCount);
console.log("  缺失城市名:", [...missingCities].slice(0, 40));

console.log("\n国家匹配:");
console.log("  已匹配:", countryFound);
console.log("  未匹配:", countryMissingCount);
console.log("  缺失国家名:", [...missingCountries].slice(0, 40));

// 按国家分组统计数据量
const countryStats = {};
items.forEach(item => {
  const c = item.country_zh || "未知";
  if (!countryStats[c]) countryStats[c] = 0;
  countryStats[c]++;
});

console.log("\n数据分布 (按国家):");
Object.entries(countryStats).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
  const hasMapping = countryNames.has(k);
  console.log(`  ${k}: ${v} 条 ${hasMapping ? '✓' : '✗ 无坐标'}`);
});
