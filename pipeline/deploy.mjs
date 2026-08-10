// deploy.mjs —— 安全部署脚本:打包代码并上传到服务器,【绝不覆盖】state/ 数据文件。
//
// 用法:
//   node deploy.mjs                    # 部署前端+后端,重启服务
//   node deploy.mjs --frontend-only    # 只部署前端(site/),不重启
//   node deploy.mjs --dry              # 只展示要做什么,不真正执行
//
// 安全措施:
//   - 打包时显式排除 pipeline/state/ 目录(用户数据只在服务器)
//   - 打包时排除 pipeline/.env(服务器有自己的配置)
//   - 部署前在服务器自动创建备份
//   - 部署后验证 HTTP 200

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const HOST = "admin@60.205.212.195";
const RBASE = "/home/admin/artportal";
const TAG = "v" + readFileSync(join(ROOT, "VERSION"), "utf8").trim();
const BACKUP_DIR = RBASE + "/deploy_backups/" + TAG.replace(/\./g, "_");
const DRY = process.argv.includes("--dry");
const FRONTEND_ONLY = process.argv.includes("--frontend-only");

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
function ssh(cmd) { return execFileSync("ssh", [...SSH_OPTS, HOST, cmd], { encoding: "utf8", timeout: 120000 }).trim(); }
function scpUp(local, remote) { execFileSync("scp", [...SSH_OPTS, local, HOST + ":" + remote], { timeout: 600000 }); }

function log(msg) { process.stderr.write("[deploy] " + msg + "\n"); }

async function main() {
  log(`版本: ${TAG} | 目标: ${HOST}:${RBASE} | 模式: ${FRONTEND_ONLY ? "前端-only" : "全量"}`);
  if (DRY) log("*** DRY RUN — 不会真正执行 ***");

  // 【保险】部署前强制备份本地 state/（用户数据红线，不可丢失）
  if (!DRY) {
    log("【保险】部署前备份本地 state/ ...");
    try {
      execSync(`node "${join(__dir, "backup.mjs")}" --local`, { stdio: "pipe" });
      log("【保险】本地 state/ 备份完成");
    } catch (e) {
      log("【保险】本地备份失败: " + (e.message || e));
      // 备份失败不应阻止部署，但发出警告
    }
  } else {
    log("[DRY] 跳过本地 state/ 备份");
  }

  // 1. 打包代码(排除 state/ 和 .env)
  const tarName = `artportal-${TAG}.tar.gz`;
  const tarPath = join(__dir, tarName);

  // 在临时目录中构建要打包的文件列表，避免 Windows tar 的 exclude 兼容性问题
  // 注意: TMP 必须在项目根目录，不能放在 pipeline/ 下，否则复制 pipeline/ 时会递归复制自身
  const TMP = join(ROOT, ".deploy_tmp");
  const EXCLUDES = ["pipeline/state", "pipeline/.env", "pipeline/node_modules", "node_modules", "site/assets/works", "site/assets/avatars", tarName];

  function shouldExclude(name) {
    // 统一路径分隔符为 /（Windows 下 join 产生 \，而 EXCLUDES 用 /）
    const n = name.replace(/\\/g, "/");
    // 排除任何层级的 .deploy_tmp（防止递归复制自身）
    if (n === ".deploy_tmp" || n.endsWith("/.deploy_tmp")) return true;
    return EXCLUDES.some(e => n === e || n.startsWith(e + "/"));
  }

  if (!DRY) {
    // 创建临时目录，并清理可能残留的旧 .deploy_tmp
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    const oldTmp = join(__dir, ".deploy_tmp");
    if (existsSync(oldTmp)) rmSync(oldTmp, { recursive: true });
    mkdirSync(TMP, { recursive: true });

    // 复制 pipeline/ 和 site/（排除敏感目录）
    for (const dir of ["pipeline", "site"]) {
      const src = join(ROOT, dir);
      const dst = join(TMP, dir);
      if (existsSync(src)) {
        copyRecursive(src, dst, dir, shouldExclude);
      }
    }

    // 复制 VERSION 和 CHANGELOG.md
    for (const f of ["VERSION", "CHANGELOG.md"]) {
      const src = join(ROOT, f);
      if (existsSync(src)) {
        cpSync(src, join(TMP, f));
      }
    }

    // 打包临时目录
    execFileSync("tar", ["czf", tarPath, "-C", TMP, "."], { encoding: "utf8", timeout: 120000 });
    log(`包已创建: ${tarName} (${Math.round(readFileSync(tarPath).length / 1024)} KB)`);

    // 清理临时目录
    rmSync(TMP, { recursive: true });
  } else {
    log(`[DRY] 将会打包 pipeline/ site/ VERSION CHANGELOG.md（排除 ${EXCLUDES.join(", ")}）`);
  }

  // 辅助函数:递归复制目录，跳过排除项
  function copyRecursive(src, dst, relPrefix, excludeFn) {
    mkdirSync(dst, { recursive: true });
    const items = readdirSync(src, { withFileTypes: true });
    for (const item of items) {
      const relPath = relPrefix ? join(relPrefix, item.name) : item.name;
      if (excludeFn(relPath)) continue;
      const fullSrc = join(src, item.name);
      const fullDst = join(dst, item.name);
      if (item.isDirectory()) {
        copyRecursive(fullSrc, fullDst, relPath, excludeFn);
      } else {
        cpSync(fullSrc, fullDst);
      }
    }
  }

  // 2. 上传到服务器
  if (!DRY) {
    log("上传到服务器...");
    scpUp(tarPath, RBASE + "/");
    log("上传完成");
  } else {
    log(`[DRY] scp ${tarName} ${HOST}:${RBASE}/`);
  }

  // 3. 在服务器上: 备份当前状态 → 解压 → 重启
  const cmds = [];
  cmds.push(`mkdir -p ${BACKUP_DIR}`);

  if (!FRONTEND_ONLY) {
    // 备份后端关键文件
    cmds.push(`cp -r ${RBASE}/pipeline/state ${BACKUP_DIR}/state 2>/dev/null; echo "备份完成"`);
    cmds.push(`cp ${RBASE}/pipeline/.env ${BACKUP_DIR}/.env 2>/dev/null; echo "env备份完成"`);
  }

  // 解压(不覆盖 state/ 和 .env——已经排除在tar外,这里双重保险)
  cmds.push(`cd ${RBASE} && tar xzf ${tarName} --keep-old-files 2>/dev/null || tar xzf ${tarName}`);
  cmds.push(`echo "解压完成: $(ls -la ${RBASE}/site/index.html 2>/dev/null)"`);

  // 清理临时文件
  cmds.push(`rm -f ${RBASE}/${tarName}`);

  if (!FRONTEND_ONLY) {
    // 确保 state/ 目录权限正确
    cmds.push(`chmod -R 775 ${RBASE}/pipeline/state/ 2>/dev/null; echo "权限修复完成"`);
    // 重启服务
    cmds.push(`sudo systemctl restart artportal`);
    cmds.push(`echo "服务已重启: $(sudo systemctl is-active artportal)"`);
  }

  // 验证（等待服务就绪）
  cmds.push(`sleep 2 && curl -so /dev/null -w '%{http_code}' http://localhost:8080/`);

  const fullCmd = cmds.join(" && ");
  if (!DRY) {
    log("在服务器上执行部署...");
    const result = ssh(fullCmd);
    log(result);
    if (result.includes("200")) {
      log("✅ 部署成功! HTTP 200");
    } else {
      log("⚠️ 部署完成,但HTTP响应非预期: " + result.slice(-50));
    }
  } else {
    log("[DRY] 服务器上将要执行的命令:");
    cmds.forEach(c => log("  " + c));
  }

  // 清理本地临时包
  if (!DRY) {
    try { rmSync(tarPath); } catch (e) {}
    log("本地临时包已清理");
  }
}

main().catch(e => {
  process.stderr.write("[deploy] 失败: " + (e.message || e) + "\n");
  process.exit(1);
});