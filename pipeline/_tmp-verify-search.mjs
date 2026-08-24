// verify searchWeb fallback now returns links via Bing RSS
import { searchWeb } from "./lib/websearch.mjs";
const r = await searchWeb("2026 全国美术 作品展 征稿 报名", { gl: "cn", hl: "zh-cn", who: "user" });
console.log("searchWeb links:", r.length, r.slice(0, 5));