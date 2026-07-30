// seed-known-institutions.mjs —— 把口播视频调研出来的"四门类顶级机构"真实候选加入 sources.json。
//
// 与 discover-sources.mjs 的区别:那个是"搜索发现候选";这个是"用户/调研已经点名的具体机构",
// 直接给出候选域名,但同样一条不改地遵守反幻觉纪律:
//   ① 只是把 URL 加进【待抓取信源列表】,不写任何"机会"记录——具体有没有真机会、机会详情是什么,
//      仍由 run.mjs 的 discoverDetailLinks → extract → verifyRecord(evidence 逐字校验)决定,本脚本不碰。
//   ② 每个候选域名必须真实 robots+抓取校验通过(可达、非空壳)才收录,通不过就诚实丢弃,不猜测。
//   ③ 域名部分是调研 agent 报告里给出的已核实链接,部分是我对知名机构官网的推测——推测的一律要
//      过真实抓取校验这一关,校验不过就不收录,绝不会有猜错的域名进 sources.json 冒充"已核实信源"。
//
// 用法:node seed-known-institutions.mjs [--dry]

import { readFile, writeFile, rename, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSource } from "./lib/fetch.mjs";
import { unsafeHost } from "./lib/websearch.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(__dir, "sources.json");
const DRY = process.argv.includes("--dry");

// { name, url, region_hint, discipline_hint, note }
// url 标"(核实链接)"的来自今晚 4 路调研 agent 报告里给出的真实来源;标"(推测)"的是我对知名机构官网的
// 推断,未在调研报告里直接给出——两者一视同仁,都要过下面的真实抓取校验才会被收录。
const CANDIDATES = [
  // —— 美术类 ——
  { name: "中国美术家协会(全国美展)", url: "https://www.caanet.org.cn", region_hint: "cn-tier1", discipline_hint: ["绘画", "雕塑"], note: "全国美术作品展览主办方" },
  { name: "上海当代艺术博物馆(上海双年展)", url: "https://www.powerstationofart.com", region_hint: "cn-tier1", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "广东美术馆(广州三年展)", url: "https://www.gdmoa.org", region_hint: "cn-tier1", discipline_hint: ["跨媒介"], note: "核实链接(调研)" },
  { name: "威尼斯双年展", url: "https://www.labiennale.org", region_hint: "intl-central-europe", discipline_hint: ["跨媒介"], note: "核实链接(调研)" },
  { name: "卡塞尔文献展(documenta)", url: "https://www.documenta.de", region_hint: "intl-central-europe", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "MacDowell", url: "https://www.macdowell.org", region_hint: "intl-na-east", discipline_hint: ["绘画", "雕塑", "跨媒介"], note: "推测域名" },
  { name: "Skowhegan", url: "https://www.skowheganart.org", region_hint: "intl-na-east", discipline_hint: ["绘画", "雕塑"], note: "推测域名" },
  { name: "ISCP纽约国际工作室与策展项目", url: "https://iscp-nyc.org", region_hint: "intl-na-east", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "Yaddo", url: "https://yaddo.org", region_hint: "intl-na-east", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "Rijksakademie", url: "https://www.rijksakademie.nl", region_hint: "intl-west-europe", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "OCAT深圳", url: "https://www.ocat.org.cn", region_hint: "cn-tier1", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "CCAA中国当代艺术奖", url: "https://www.ccaa-artaward.org", region_hint: "cn-tier1", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "泰特美术馆(特纳奖)", url: "https://www.tate.org.uk", region_hint: "intl-west-europe", discipline_hint: ["绘画", "跨媒介"], note: "推测域名" },
  { name: "ADIAF(杜尚奖)", url: "https://www.adiaf.com", region_hint: "intl-west-europe", discipline_hint: ["跨媒介"], note: "推测域名" },
  { name: "Vermont Studio Center", url: "https://vermontstudiocenter.org", region_hint: "intl-na-east", discipline_hint: ["绘画", "雕塑"], note: "推测域名" },

  // —— 音乐/声音类 ——
  { name: "IRCAM", url: "https://www.ircam.fr", region_hint: "intl-west-europe", discipline_hint: ["音乐", "声音艺术"], note: "核实链接(调研)" },
  { name: "Civitella Ranieri Foundation", url: "https://civitella.org", region_hint: "intl-central-europe", discipline_hint: ["音乐", "跨媒介"], note: "核实链接(调研)" },
  { name: "Akademie Schloss Solitude", url: "https://www.akademie-solitude.de", region_hint: "intl-central-europe", discipline_hint: ["音乐", "跨媒介"], note: "核实链接(调研)" },
  { name: "Royaumont", url: "https://www.royaumont.com", region_hint: "intl-west-europe", discipline_hint: ["音乐"], note: "核实链接(调研)" },
  { name: "impuls Graz", url: "https://www.impuls.cc", region_hint: "intl-central-europe", discipline_hint: ["音乐"], note: "核实链接(调研)" },
  { name: "ISCM世界新音乐日", url: "https://iscm.org", region_hint: "intl-central-europe", discipline_hint: ["音乐"], note: "核实链接(调研)" },
  { name: "达姆施塔特新音乐暑期班", url: "https://internationales-musikinstitut.de", region_hint: "intl-central-europe", discipline_hint: ["音乐"], note: "核实链接(调研)" },
  { name: "格文美尔作曲奖", url: "https://grawemeyer.org", region_hint: "intl-na-east", discipline_hint: ["音乐"], note: "核实链接(调研)" },
  { name: "恩斯特·冯·西门子音乐奖", url: "https://evs-musikstiftung.ch", region_hint: "intl-central-europe", discipline_hint: ["音乐"], note: "核实链接(调研)" },
  { name: "北京现代音乐节", url: "https://bmmf.ccom.edu.cn", region_hint: "cn-tier1", discipline_hint: ["音乐"], note: "核实链接(调研)" },
  { name: "中国-东盟音乐周", url: "https://camwn.gxau.edu.cn", region_hint: "cn-south", discipline_hint: ["音乐"], note: "核实链接(调研)" },

  // —— 影视/剧作类 ——
  { name: "上海国际电影节(金爵奖)", url: "https://www.siff.com", region_hint: "cn-tier1", discipline_hint: ["电影", "动画"], note: "核实链接(调研)" },
  { name: "北京国际电影节(天坛奖)", url: "https://www.bjiff.com", region_hint: "cn-tier1", discipline_hint: ["电影"], note: "核实链接(调研)" },
  { name: "戛纳国际电影节", url: "https://www.festival-cannes.com", region_hint: "intl-west-europe", discipline_hint: ["电影"], note: "核实链接(调研)" },
  { name: "柏林国际电影节", url: "https://www.berlinale.de", region_hint: "intl-central-europe", discipline_hint: ["电影"], note: "核实链接(调研)" },
  { name: "圣丹斯电影节/学院", url: "https://www.sundance.org", region_hint: "intl-na-west", discipline_hint: ["电影"], note: "核实链接(调研)" },
  { name: "厦门大学电影学院(青年编剧大会)", url: "https://film.xmu.edu.cn", region_hint: "cn-east", discipline_hint: ["电影", "戏剧"], note: "核实链接(调研)" },
  { name: "香港亚洲电影投资会HAF", url: "https://industry.hkiff.org.hk", region_hint: "cn-hkmotw", discipline_hint: ["电影"], note: "核实链接(调研)" },

  // —— 舞蹈/戏剧类 ——
  { name: "ImPulsTanz维也纳国际舞蹈节", url: "https://www.impulstanz.com", region_hint: "intl-central-europe", discipline_hint: ["舞蹈"], note: "推测域名" },
  { name: "Jacob's Pillow Dance Festival", url: "https://www.jacobspillow.org", region_hint: "intl-na-east", discipline_hint: ["舞蹈"], note: "推测域名" },
  { name: "阿维尼翁戏剧节", url: "https://www.festival-avignon.com", region_hint: "intl-west-europe", discipline_hint: ["戏剧"], note: "核实链接(调研)" },
  { name: "爱丁堡艺穗节", url: "https://www.edfringe.com", region_hint: "intl-west-europe", discipline_hint: ["戏剧"], note: "核实链接(调研)" },
  { name: "乌镇戏剧节", url: "https://www.wuzhenfestival.com", region_hint: "cn-east", discipline_hint: ["戏剧"], note: "推测域名" },
  { name: "Baryshnikov Arts Center", url: "https://bacnyc.org", region_hint: "intl-na-east", discipline_hint: ["舞蹈", "戏剧"], note: "推测域名" },
  { name: "PACT Zollverein", url: "https://www.pact-zollverein.de", region_hint: "intl-central-europe", discipline_hint: ["舞蹈"], note: "推测域名" },
  { name: "Royal Court Theatre", url: "https://royalcourttheatre.com", region_hint: "intl-west-europe", discipline_hint: ["戏剧"], note: "推测域名" },
  { name: "Prix de Lausanne", url: "https://www.prixdelausanne.org", region_hint: "intl-central-europe", discipline_hint: ["舞蹈"], note: "推测域名" }
];

function domainOf(u) { try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch (e) { return null; } }
// 纯中文机构名(如"卡塞尔文献展")经 ASCII-only 正则会被整个滤空,原实现统一兜底成 "src" 导致所有
// 中文名候选互相撞车、后来者被误判重复静默丢弃(实测丢了 6 个已通过真实校验的真实信源)。
// 改为:能提取 ASCII 就用 ASCII;提取不到就用原字符串算简单哈希兜底,保证不同名字不会撞同一个 id。
function slug(s) {
  const base = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 24);
  if (base) return base;
  let h = 0; for (const ch of String(s || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return "cn-" + h.toString(36).slice(0, 8);
}
const STORAGE_HOST = /(^|\.)(s3[.-][a-z0-9-]+\.amazonaws\.com|amazonaws\.com|cloudfront\.net|googleusercontent\.com|blob\.core\.windows\.net|storage\.googleapis\.com|wixsite\.com|weebly\.com)$/i;

async function main() {
  const raw = JSON.parse(await readFile(SRC_PATH, "utf8"));
  const arr = Array.isArray(raw) ? raw : (raw.sources || []);
  const existingDomains = new Set(arr.map(s => s.domain));
  const existingIds = new Set(arr.map(s => s.id));

  const added = [], skipped = [], failed = [];
  for (const c of CANDIDATES) {
    const dom = domainOf(c.url);
    if (!dom) { skipped.push(c.name + "(URL 解析失败)"); continue; }
    if (existingDomains.has(dom)) { skipped.push(c.name + "(" + dom + " 已在库,大概率已被之前的调研/发现流程收录)"); continue; }
    if (unsafeHost(dom) || STORAGE_HOST.test(dom)) { skipped.push(c.name + "(域名闸拦下)"); continue; }

    let fr;
    try { fr = await fetchSource({ url: c.url, type: "html" }); }
    catch (e) { fr = { skipped: true, reason: "error:" + e.message }; }
    if (fr.skipped) { failed.push(`${c.name} → ${dom}(${fr.reason})`); continue; }
    if (!fr.text || fr.text.length < 200) { failed.push(`${c.name} → ${dom}(正文过短,疑似空壳/JS渲染)`); continue; }

    const id = slug(c.name.replace(/[\(\)（）].*$/, "")) + "-known";
    if (existingIds.has(id)) { skipped.push(c.name + "(id 撞车)"); continue; }
    const entry = {
      id, org_zh: c.name, name_zh: "机器发现·用户点名机构",
      url: c.url, domain: dom, type: "html", rss: null,
      org_type: "official", category_hint: ["opencall", "residency", "award", "workshop"],
      reachable: true, robots: fr.robots || "unknown", confirmed: false,
      notes: `v0.99.1 用户口播视频调研点名的行业顶级机构(${c.note}),已过真实可达性校验;是否真有可申请机会仍由 discoverDetailLinks + evidence 校验决定`,
      region_hint: c.region_hint, discipline_hint: c.discipline_hint
    };
    arr.push(entry); existingDomains.add(dom); existingIds.add(id);
    added.push(entry);
    console.log(`✓ ${c.name} → ${dom}`);
  }

  console.log(`\n新增 ${added.length} 个信源;跳过(已在库/闸掉)${skipped.length} 个;校验不通过 ${failed.length} 个`);
  if (skipped.length) console.log("跳过明细:\n  " + skipped.join("\n  "));
  if (failed.length) console.log("\n校验不通过明细(诚实丢弃,不猜测):\n  " + failed.join("\n  "));

  if (DRY || !added.length) { console.log(DRY ? "\n[--dry] 未写盘。" : "\n无新增,未写盘。"); return; }
  await copyFile(SRC_PATH, SRC_PATH + ".bak-known");
  const out = Array.isArray(raw) ? arr : raw;
  const tmp = SRC_PATH + ".tmp-" + process.pid;
  await writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
  await rename(tmp, SRC_PATH);
  console.log(`\n已写回 sources.json(信源总数 ${arr.length},备份 sources.json.bak-known)`);
}
main().catch(e => { console.error("失败:", e); process.exit(1); });
