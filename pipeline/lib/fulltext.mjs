// fulltext.mjs —— 官网原文双语存档:入库时把抓到的页面正文(精简成 summary 之前的原文)
// 翻译成中英双语一并存好;前端"详情"原地展开时直接读静态 JSON,零现场检索、零现场翻译。
//
// 存放:site/data/fulltext/<安全化id>.json = { src:"zh"|"en", zh:"...", en:"..." }
//   原文是哪种语言,那一侧就是原文(不调 LLM);另一侧用 DeepSeek 忠实翻译(入库时做,一次调用)。
//   翻译失败不阻断入库:缺失侧存 null,前端回退显示已有侧。
// 文件属生成物,git 忽略,由 sync-server.mjs 增量同步上线;老数据由 backfill-fulltext.mjs 补档。

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { llmExtract } from "./extract.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dir, "..", "..", "site", "data", "fulltext");
const MAX_IN = 5000;      // 送翻原文上限(DeepSeek 输出上限内留足余量)
const MAX_STORE = 12000;  // 原文侧存档上限

let dirReady = false;
function safeName(id) { return String(id).replace(/[^\w一-鿿-]/g, "_").slice(0, 120); }
// 语言检测:中日韩字符占比超过 20% 视为中文原文
function isZhText(s) {
  const str = String(s || "");
  if (!str) return false;
  const cjk = (str.match(/[一-鿿]/g) || []).length;
  return cjk / str.length > 0.2;
}

// 忠实翻译(与速览面板同一理念:只翻译,绝不增删)。失败返回 null。
async function translateTo(text, to) {
  try {
    const sys = "你是忠实的网页翻译器。把用户给的【网页正文】翻译成" + (to === "en" ? "英文" : "简体中文") +
      "。只翻译,绝不增删信息、不解释、不评论、不补全;保留段落结构(段落间用 \\n 分隔);" +
      "数字、日期、金额、邮箱、URL、专有名词原文照抄。" +
      '只输出一个 JSON:{"text":"译文"}';
    const r = await llmExtract(sys, "【网页正文】\n\n" + String(text).slice(0, MAX_IN), 4000);
    const out = typeof r.data.text === "string" ? r.data.text.trim() : "";
    return out || null;
  } catch (e) { return null; }
}

// 存双语原文档,返回记录应写入的相对路径(失败返回 null,绝不让存档失败阻断入库)
export async function saveFulltext(id, sourceText) {
  try {
    const text = String(sourceText || "").slice(0, MAX_STORE).trim();
    if (!text || text.length < 100) return null;
    if (!dirReady) { await mkdir(DIR, { recursive: true }); dirReady = true; }
    const src = isZhText(text) ? "zh" : "en";
    const other = src === "zh" ? "en" : "zh";
    const doc = { src, zh: null, en: null };
    doc[src] = text;
    doc[other] = await translateTo(text, other);   // 入库时就翻好;失败留 null,前端回退原文侧
    const name = safeName(id) + ".json";
    await writeFile(join(DIR, name), JSON.stringify(doc), "utf8");
    return "data/fulltext/" + name;
  } catch (e) { return null; }
}
