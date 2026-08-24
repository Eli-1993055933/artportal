const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const q = "全国美术 作品展 征稿 报名";
const u = "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&mkt=zh-CN";
const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(15000) });
const t = await r.text();
const idx = t.indexOf("b_algo");
console.log("b_algo idx", idx);
// print a 600-char window after first b_algo, showing h2/a tag
console.log(t.slice(idx, idx + 700));
// count href= occurrences and forms
const dq = [...t.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
console.log("double-quote href count", dq.length, "sample", dq.slice(0,8));
const sq = [...t.matchAll(/href='([^']*)'/g)].map(m => m[1]);
console.log("single-quote href count", sq.length, "sample", sq.slice(0,5));