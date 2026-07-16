import { locateOfficial } from "./lib/locate-official.mjs";
import { readFile } from "node:fs/promises";
const items = JSON.parse(await readFile(process.env.TEMP + "/relocate-items.json", "utf8"));
// 挑代表性样本:各类型各一个
const pick = ["curatorspace.com","artconnect.com","chinaresidencies.com","shejijingsai.com","news.qq.com","resartis.org"];
const samples = pick.map(h => items.find(i => i.host === h)).filter(Boolean);
for (const s of samples) {
  process.stderr.write(`\n[${s.host}] ${s.org} — ${String(s.title).slice(0,30)}\n  旧: ${s.cur}\n`);
  const t0 = Date.now();
  const r = await locateOfficial(s);
  process.stderr.write(`  新: ${r ? r.url + "  ("+r.level+")" : "未找到"}  (${Date.now()-t0}ms)\n`);
}
