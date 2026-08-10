import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('./site/data/opportunities.json', 'utf8'));
const opportunities = data.opportunities || [];

function isThirdParty(url) {
  const aggregators = ['artconnect.com', 'curatorspace.com', 'transartists.org', 'chinaresidencies.com', 'e-flux.com', 'resartis.org'];
  if (!url) return false;
  return aggregators.some(a => url.includes(a));
}

function isPastRec(o) {
  if (o.status === 'expired') return true;
  if (!o.deadline) return false;
  const d = new Date(o.deadline + 'T23:59:59');
  return !isNaN(d) && d < Date.now();
}

function officialUrl(o) {
  if (o.official_url && !isThirdParty(o.official_url)) return o.official_url;
  if (o.url && !isThirdParty(o.url)) return o.url;
  return null;
}

function isOppCat(c) {
  return c === 'opencall' || c === 'residency' || c === 'award' || c === 'workshop';
}

function isVisible(o) {
  // 模拟前端过滤逻辑
  if (isOppCat(o.category) && o.trust !== 'user' && !officialUrl(o)) return false;
  return true;
}

let visibleAll = 0;       // 所有可见（不过滤过期）
let visibleActive = 0;    // 只看活跃
let hiddenExpired = 0;    // 因过期被隐藏
let hiddenNoUrl = 0;      // 因无官方URL被隐藏

for (const item of opportunities) {
  const canShow = isVisible(item);
  const isExpired = isPastRec(item);
  const hasUrl = isOppCat(item.category) && item.trust !== 'user' && !officialUrl(item);
  
  if (canShow) visibleAll++;
  if (canShow && !isExpired) visibleActive++;
  if (!canShow && hasUrl) hiddenNoUrl++;
  if (canShow && isExpired) hiddenExpired++;
}

console.log('=== 前端可见性分析（模拟默认过滤）===');
console.log(`总机会数: ${opportunities.length}`);
console.log('');
console.log('【不过滤过期】:');
console.log(`  可见: ${visibleAll}`);
console.log(`  被过滤(无官方URL): ${hiddenNoUrl}`);
console.log('');
console.log('【默认过滤过期】:');
console.log(`  可见: ${visibleActive}`);
console.log(`  被过滤(已过期): ${hiddenExpired}`);
console.log(`  被过滤(无官方URL): ${hiddenNoUrl}`);
console.log('');
console.log(`可见率（默认设置）: ${((visibleActive / opportunities.length) * 100).toFixed(1)}%`);
