// _tmp-caanet-scan.mjs —— 免费直连扫描中国美协 newsdetail 页区间,挑出「征稿/征集/招募」类详情页
// 只读:仅输出候选 URL 清单到文件,绝不改动 site/data/opportunities.json
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const getOpt = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const LO = parseInt(getOpt("--lo") || "10150", 10);
const HI = parseInt(getOpt("--hi") || "10430", 10);
const OUT = join(__dir, getOpt("--out") || "_tmp-caanet-candidates.txt");
const CONC = Math.max(1, parseInt(getOpt("--conc") || "3", 10));
const DELAY = Math.max(0, parseInt(getOpt("--delay") || "250", 10));

const HIT = /(征稿|征集|征选|招募|启事|申报|投稿|报送)/;
const NEG = /(展览开幕|巡展|座谈|研讨|工作会议|表彰|讣告|公示|结果|名单|开班|培训|招标|采购)/;

async function get(id) {
  const url = `https://www.caanet.org.cn/newsdetail.mx?id=${id}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    const html = new TextDecoder("utf-8").decode(buf);
    if (!/<article/i.test(html) && html.length < 3000) return null;
    const m = html.match(/<title>([^<]*)<\/title>/i);
    let title = m ? m[1].replace(/中国美术家协会\s*$/, "").trim() : "";
    if (!title || title === "中国美术家协会") return null;
    return { id, url, title, len: html.length };
  } catch (e) { return { id, url, err: String(e.message || e).slice(0, 40) }; }
}

async function main() {
  const ids = [];
  for (let i = LO; i <= HI; i++) ids.push(i);
  const hits = [];
  const fails = [];
  let idx = 0, done = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (idx < ids.length) {
      const id = ids[idx++];
      const r = await get(id);
      if (DELAY) await new Promise(s => setTimeout(s, DELAY));
      done++;
      if (done % 40 === 0) console.log(`  进度 ${done}/${ids.length} 命中 ${hits.length} 失败 ${fails.length}`);
      if (!r) continue;
      if (r.err) { fails.push(r); continue; }
      if (HIT.test(r.title) && !NEG.test(r.title)) { hits.push(r); console.log(`✓ ${r.id} ${r.title}`); }
    }
  });
  await Promise.all(workers);
  if (fails.length) console.log("失败样例:", fails.slice(0, 5).map(f => f.id + ":" + f.err).join(" | "));
  const lines = ["# 中国美协 newsdetail 扫描候选(" + LO + "-" + HI + ") 共" + hits.length + "条", ...hits.map(h => h.url)];
  await writeFile(OUT, lines.join("\n") + "\n", "utf8");
  console.log(`\n扫描完成 ${LO}-${HI},命中征稿类 ${hits.length},已写 ${OUT}`);
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });