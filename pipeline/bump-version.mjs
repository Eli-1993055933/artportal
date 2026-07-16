/* 版本升级脚本(SemVer 2.0.0)。用法:
     node bump-version.mjs patch|minor|major [--dry]
   语义:patch=修 bug/微调;minor=新功能/界面变化;major=不兼容大改(1.0.0 留给备案正式上线)。
   做的事(单一版本源=根 VERSION):
     1. VERSION 按语义递增;
     2. site/index.html 全部 ?v=、<meta name="app-version">、页脚 #appVer 同步为新版本;
     3. pipeline/package.json 的 version 同步;
     4. CHANGELOG.md 的插入标记行后新增版本段(说明留空,升完手动补一句)。
   之后手动:补 CHANGELOG 说明 → git commit → git tag v<版本> → 部署。
   --dry 只打印将发生什么,不写任何文件。
   注:变更说明不做命令行参数——Windows 下 shell 传中文会乱码,统一升完编辑 CHANGELOG。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const kind = args.filter((a) => a !== "--dry")[0];

if (!["patch", "minor", "major"].includes(kind)) {
  console.error("用法: node bump-version.mjs patch|minor|major [--dry]");
  process.exit(1);
}

// 1. VERSION 递增
const vFile = path.join(ROOT, "VERSION");
const cur = fs.readFileSync(vFile, "utf8").trim();
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
if (!m) { console.error("VERSION 内容不是 x.y.z 格式:" + cur); process.exit(1); }
let [maj, min, pat] = m.slice(1).map(Number);
if (kind === "major") { maj++; min = 0; pat = 0; }
else if (kind === "minor") { min++; pat = 0; }
else { pat++; }
const next = `${maj}.${min}.${pat}`;

// 2. site/index.html:?v= / meta / 页脚
const htmlFile = path.join(ROOT, "site", "index.html");
let html = fs.readFileSync(htmlFile, "utf8");
const nAssets = (html.match(/\?v=[^"']+/g) || []).length;
if (!nAssets) { console.error("index.html 里没找到任何 ?v= 资源引用,拒绝继续"); process.exit(1); }
html = html.replace(/\?v=[^"']+/g, "?v=" + next);
const hadMeta = /<meta name="app-version"/.test(html);
html = html.replace(/(<meta name="app-version" content=")[^"]*(")/, `$1${next}$2`);
const hadFoot = /id="appVer"/.test(html);
html = html.replace(/(<span id="appVer"[^>]*>)[^<]*(<\/span>)/, `$1v${next}$2`);

// 3. pipeline/package.json 同步
const pkgFile = path.join(ROOT, "pipeline", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
pkg.version = next;

// 4. CHANGELOG 插入新版本段(在标记行之后)
const clFile = path.join(ROOT, "CHANGELOG.md");
let cl = fs.readFileSync(clFile, "utf8");
const MARK = /^<!-- bump-version\.mjs 会在本注释的下一行插入新版本段.*-->$/m;
if (!MARK.test(cl)) { console.error("CHANGELOG.md 缺插入标记行,拒绝继续"); process.exit(1); }
const d = new Date(); // 本地日期(toISOString 是 UTC,北京时间早上会差一天)
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
cl = cl.replace(MARK, (line) => `${line}\n\n## [${next}] - ${today}\n- (待补充变更说明)`);

console.log(`${cur} → ${next}(${kind}${dry ? ",dry-run 未写盘" : ""})`);
console.log(`  index.html:${nAssets} 处 ?v=;meta app-version ${hadMeta ? "已同步" : "⚠ 未找到"};页脚 ${hadFoot ? "已同步" : "⚠ 未找到"}`);
if (!dry) {
  fs.writeFileSync(vFile, next + "\n");
  fs.writeFileSync(htmlFile, html);
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + "\n");
  fs.writeFileSync(clFile, cl);
  console.log("接下来:① 编辑 CHANGELOG.md 补变更说明 ② git commit ③ git tag v" + next + " ④ 部署");
}
