const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const q = "2026 全国美术 作品展 征稿 报名";
for (const base of ["https://www.bing.com", "https://cn.bing.com"]) {
  const u = base + "/search?format=rss&q=" + encodeURIComponent(q) + "&mkt=zh-CN";
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" }, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    const links = [...t.matchAll(/<link>([^<]+)<\/link>/g)].map(m => m[1]).slice(0, 15);
    console.log(base, "status", r.status, "rss len", t.length, "links", links.length, links.slice(0,3));
  } catch (e) { console.log(base, "ERR", e.message); }
}