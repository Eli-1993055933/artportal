import { readFileSync } from 'fs';

const files = [
  './site/data/opportunities.json',
  './site/data/jobs.json',
  './site/data/news.json'
];

for (const f of files) {
  try {
    const data = JSON.parse(readFileSync(f, 'utf8'));
    const key = f.includes('jobs') ? 'jobs' : (f.includes('news') ? 'items' : 'opportunities');
    const items = data[key] || [];
    console.log(`${f}:`);
    console.log(`  generated_at: ${data.generated_at}`);
    console.log(`  count: ${data.count}`);
    console.log(`  actual items: ${items.length}`);
    console.log('');
  } catch (e) {
    console.log(`${f}: error - ${e.message}`);
  }
}
