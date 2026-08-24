// try bing variants
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const q = "全国美术 作品展 征稿 报名";
const urls = [
  "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&setmkt=zh-CN&setlang=zh-hans&cc=cn",
  "https://cn.bing.com/search?q=" + encodeURIComponent(q) + "&ensearch=0",
  "https://www.bing.com/search?q=" + encodeURIComponent(q) + "&mkt=zh-CN",
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", "Accept": "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    const links = [...t.matchAll(/<a\s+href="(https?:\/\/[^"]+)"[^>]*>/g)].map(m => m[1]);
    console.log("status", r.status, "len", t.length, "b_algo:", t.includes("b_algo"), "links:", links.length, links.slice(0,3));
  } catch (e) { console.log("ERR", e.message); }
}