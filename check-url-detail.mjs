import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('./site/data/opportunities.json', 'utf8'));
const opportunities = data.opportunities || [];

let noUrlAtAll = 0;  // 完全没有 url
let hasOfficial = 0;  // 有 official_url
let hasOnlyUrl = 0;  // 只有 url，没有 official_url
let thirdPartyUrl = 0;  // url 是第三方
let nonThirdPartyUrl = 0;  // url 不是第三方

const aggregators = ['artconnect.com', 'curatorspace.com', 'transartists.org', 'chinaresidencies.com', 'e-flux.com', 'resartis.org'];

function isThirdParty(url) {
  if (!url) return false;
  return aggregators.some(a => url.includes(a));
}

for (const item of opportunities) {
  const official = item.official_url;
  const url = item.url;
  
  if (official) {
    hasOfficial++;
  } else if (!url) {
    noUrlAtAll++;
  } else {
    hasOnlyUrl++;
    if (isThirdParty(url)) {
      thirdPartyUrl++;
    } else {
      nonThirdPartyUrl++;
    }
  }
}

console.log('=== 机会数据 URL 分析 ===');
console.log(`总条目: ${opportunities.length}`);
console.log(`有 official_url: ${hasOfficial} (可显示)`);
console.log(`无 official_url 分析:`);
console.log(`  - 完全没有 url: ${noUrlAtAll}`);
console.log(`  - 只有 url (非第三方): ${nonThirdPartyUrl} (可显示但没有官网)`);
console.log(`  - 只有 url (第三方): ${thirdPartyUrl} (被过滤)`);
console.log('');
console.log(`预期可见: ${hasOfficial + nonThirdPartyUrl}`);
console.log(`被过滤: ${thirdPartyUrl + noUrlAtAll}`);

// 检查 status 字段
let expired = 0;
let active = 0;
for (const item of opportunities) {
  if (item.status === 'expired' || (item.deadline && new Date(item.deadline) < new Date())) {
    expired++;
  } else {
    active++;
  }
}
console.log('');
console.log(`=== 过期状态 ===`);
console.log(`已过期: ${expired}`);
console.log(`活跃: ${active}`);
