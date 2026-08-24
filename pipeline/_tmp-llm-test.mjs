// _tmp-llm-test.mjs —— 验证 AI 提取链路是否可用(DeepSeek/GLM/Anthropic)
import { fetchSource } from "./lib/fetch.mjs";
import { extract } from "./lib/extract.mjs";
const url = "https://www.namoc.cn/namoc/gonggao/202606/1787136724c542bea53e3e70bbe6efd6.shtml";
const f = await fetchSource({ url, domain: "namoc.cn", type: "html" }, null);
console.log("fetch: skipped=", f.skipped, "len=", f.text ? f.text.length : 0, "reason=", f.reason || "");
if (!f.skipped && f.text) {
  try {
    const ex = await extract(f.text, { org_zh: "", domain: "namoc.cn", url, source_url: url, sourceText: f.text });
    if (ex && ex.data) {
      console.log("extract OK: applicable=", ex.data.applicable, "title=", (ex.data.title_zh || ex.data.title || "?"));
      console.log("usage=", JSON.stringify(ex.usage));
    } else console.log("extract r=", JSON.stringify(ex));
  } catch (e) { console.log("extract THREW:", e.message); }
}
console.log("env keys: DEEPSEEK=", !!process.env.DEEPSEEK_API_KEY, "MOD=", !!process.env.MOD_API_KEY, "ANTHROPIC=", !!process.env.ANTHROPIC_API_KEY);