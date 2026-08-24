// _tmp-bing-can.mjs —— 诊断 Bing RSS 对国内官方征稿词的返回质量
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const qs = [
  "美术馆 作品征集 通知 2026",
  "全国美术作品展览 征稿",
  "驻留计划 招募 申请 2026",
  "摄影 大展 征稿启事",
  "书法 篆刻展 征稿",
];
for (const q of qs) {
  const u = "https://www.bing.com/search?format=rss&mkt=zh-CN&q=" + encodeURIComponent(q);
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" }, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    const items = [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map(it => {
      const link = (it[1].match(/<link>([^<]+)<\/link>/) || ["", ""])[1].replace(/&amp;/g, "&");
      const title = (it[1].match(/<title>([^<]*)<\/title>/) || ["", ""])[1].trim().slice(0, 60);
      return { title, link };
    });
    console.log("Q:", q);
    console.log("  status", r.status, "items", items.length);
    for (const it of items.slice(0, 6)) console.log("   -", it.title, "||", it.link);
  } catch (e) { console.log("Q:", q, "ERR", e.message); }
  await new Promise(rr => setTimeout(rr, 1500));
}