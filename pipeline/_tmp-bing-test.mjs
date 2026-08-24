// quick bing parse check
(async () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const q = "全国美术 作品展 征稿 报名";
  const url = "https://cn.bing.com/search?q=" + encodeURIComponent(q);
  const r = await fetch(url, { headers: { "User-Agent": ua, "Accept-Language": "zh-CN,zh;q=0.9" }, signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  console.log("status", r.status, "len", t.length);
  const links = [...t.matchAll(/<a\s+href="(https?:\/\/[^"]+)"[^>]*>/g)].map(m => m[1]);
  console.log("anchor links:", links.length, links.slice(0, 5));
  console.log("has b_algo:", t.includes("b_algo"));
})();