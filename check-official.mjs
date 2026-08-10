import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('./site/data/opportunities.json', 'utf8'));
const opportunities = data.opportunities || [];

let hasOfficial = 0;
let noOfficial = 0;
let byCategory = {};

for (const item of opportunities) {
  const hasUrl = !!(item.official_url || item.official_located);
  if (hasUrl) {
    hasOfficial++;
  } else {
    noOfficial++;
  }
  
  const cat = item.category || 'unknown';
  if (!byCategory[cat]) byCategory[cat] = { total: 0, hasOfficial: 0 };
  byCategory[cat].total++;
  if (hasUrl) byCategory[cat].hasOfficial++;
}

console.log('=== 机会数据统计 ===');
console.log(`总条目: ${opportunities.length}`);
console.log(`有 official_url: ${hasOfficial}`);
console.log(`无 official_url: ${noOfficial}`);
console.log(`可见比例: ${((hasOfficial / opportunities.length) * 100).toFixed(1)}%`);
console.log('');
console.log('=== 按分类统计 ===');
for (const [cat, info] of Object.entries(byCategory)) {
  console.log(`${cat}: 总计 ${info.total}, 有官网 ${info.hasOfficial}, 可见 ${((info.hasOfficial / info.total) * 100).toFixed(1)}%`);
}
