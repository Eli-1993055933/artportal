// quick serper check
(async () => {
  const key = process.env.SERPER_API_KEY;
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify({ q: "全国美术 作品展 征稿 报名", num: 10, gl: "cn", hl: "zh-cn" }),
      signal: AbortSignal.timeout(15000)
    });
    const t = await r.text();
    console.log("serper status", r.status);
    if (r.ok) { const j = JSON.parse(t); console.log("organic", (j.organic || []).length); }
    else console.log(t.slice(0, 200));
  } catch (e) { console.log("err", e.message); }
})();