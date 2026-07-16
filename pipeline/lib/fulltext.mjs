// fulltext.mjs —— 官网原文存档:入库时把抓到的页面正文(精简成 summary 之前的原文)存成
// 静态文本文件,前端"详情"按钮直接读取秒开——不再需要点击时实时抓官网+机翻。
//
// 存放:site/data/fulltext/<安全化id>.txt(UTF-8 纯文本,截 12000 字)。
// 记录上写 fulltext 字段(相对路径),前端有该字段就 fetch 静态文件;没有(老数据)走
// /api/pagetrans&to=raw 实时抓原文兜底。文件属生成物,git 忽略,由 sync-server.mjs 增量同步上线。

import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dir, "..", "..", "site", "data", "fulltext");
const MAX = 12000;

let dirReady = false;
function safeName(id) { return String(id).replace(/[^\w一-鿿-]/g, "_").slice(0, 120); }

// 存原文,返回记录应写入的相对路径(失败返回 null,绝不让存档失败阻断入库)
export async function saveFulltext(id, sourceText) {
  try {
    const text = String(sourceText || "").slice(0, MAX).trim();
    if (!text || text.length < 100) return null;
    if (!dirReady) { await mkdir(DIR, { recursive: true }); dirReady = true; }
    const name = safeName(id) + ".txt";
    await writeFile(join(DIR, name), text, "utf8");
    return "data/fulltext/" + name;
  } catch (e) { return null; }
}
