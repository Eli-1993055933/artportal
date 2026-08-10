// backup.mjs —— 创建服务器状态快照并保存到本地 backups/ 目录
// 用法: node pipeline/backup.mjs
// 效果: 从服务器拉取 state/ 和关键代码文件，保存到 backups/YYYY-MM-DD_HHmmss/ 目录
// 回档: 将 backups/ 中的对应目录 scp 回服务器即可

import { execSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const BACKUPS = join(__dir, "..", "backups");
const SERVER = "admin@60.205.212.195";
const BASE = "/home/admin/artportal";
const SITE = join(__dir, "..", "site");

const ts = new Date();
const stamp = ts.getFullYear() + "-" +
  String(ts.getMonth() + 1).padStart(2, "0") + "-" +
  String(ts.getDate()).padStart(2, "0") + "_" +
  String(ts.getHours()).padStart(2, "0") +
  String(ts.getMinutes()).padStart(2, "0") +
  String(ts.getSeconds()).padStart(2, "0");
const DEST = join(BACKUPS, "snapshot_" + stamp);

// 检测是否有 ssh/scp
function have(cmd) {
  try { execSync("where " + cmd, { stdio: "ignore" }); return true; } catch (e) { return false; }
}

const hasSSH = have("ssh");
const hasSCP = have("scp");

async function run() {
  console.log("=== 备份 ArtPortal 服务器状态 ===");
  console.log("目标:", DEST);
  console.log("时间:", ts.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));
  console.log("");

  if (!hasSSH || !hasSCP) {
    console.error("错误: 需要 ssh 和 scp 命令");
    process.exit(1);
  }

  await mkdir(DEST, { recursive: true });

  // 1. 拉取服务器 state/ 压缩包
  console.log("[1/3] 拉取服务器 state/ ...");
  const remoteTgz = "/tmp/artportal_state_" + stamp + ".tar.gz";
  try {
    execSync(`ssh ${SERVER} "cd ${BASE} && tar czf ${remoteTgz} pipeline/state/"`, { stdio: "pipe" });
    execSync(`scp ${SERVER}:${remoteTgz} "${join(DEST, "state.tar.gz")}"`, { stdio: "pipe" });
    execSync(`ssh ${SERVER} "rm -f ${remoteTgz}"`, { stdio: "pipe" });
    console.log("  -> state.tar.gz 已保存");
  } catch (e) {
    console.error("  !! 拉取 state 失败:", e.message);
  }

  // 2. 拉取服务器 pipeline/ 代码（排除 node_modules 和 state）
  console.log("[2/3] 拉取服务器代码 ...");
  try {
    execSync(
      `ssh ${SERVER} "cd ${BASE} && tar czf /tmp/artportal_code_${stamp}.tar.gz --exclude=pipeline/node_modules --exclude=pipeline/state --exclude=site/node_modules pipeline/ site/"`,
      { stdio: "pipe" }
    );
    execSync(
      `scp ${SERVER}:/tmp/artportal_code_${stamp}.tar.gz "${join(DEST, "code.tar.gz")}"`,
      { stdio: "pipe" }
    );
    execSync(`ssh ${SERVER} "rm -f /tmp/artportal_code_${stamp}.tar.gz"`, { stdio: "pipe" });
    console.log("  -> code.tar.gz 已保存");
  } catch (e) {
    console.error("  !! 拉取代码失败:", e.message);
  }

  // 3. 记录版本信息
  console.log("[3/3] 记录版本信息 ...");
  let gitInfo = {};
  try {
    const log = execSync("git log --oneline -1", { cwd: join(__dir, ".."), encoding: "utf8" }).trim();
    const ver = execSync("type VERSION", { cwd: join(__dir, ".."), encoding: "utf8" }).trim();
    gitInfo = { commit: log, version: ver, time: stamp };
    await writeFile(join(DEST, "version.json"), JSON.stringify(gitInfo, null, 2), "utf8");
    console.log("  -> version.json 已保存:", ver);
  } catch (e) {
    console.error("  !! 获取版本信息失败:", e.message);
  }

  // 4. 写入恢复说明
  const restoreScript = `#!/bin/bash
# 恢复 ArtPortal 到 ${stamp} 快照
# 用法: 将本目录 scp 到服务器，然后运行此脚本

SERVER_BASE="${BASE}"
BACKUP_DIR="$(dirname "$0")"

echo "=== 恢复 ArtPortal 快照 ${stamp} ==="

# 恢复 state
if [ -f "\${BACKUP_DIR}/state.tar.gz" ]; then
  echo "[1/2] 恢复 state/ ..."
  cd "\${SERVER_BASE}"
  tar xzf "\${BACKUP_DIR}/state.tar.gz"
  echo "  state/ 已恢复"
fi

# 恢复代码
if [ -f "\${BACKUP_DIR}/code.tar.gz" ]; then
  echo "[2/2] 恢复代码 ..."
  cd "\${SERVER_BASE}"
  tar xzf "\${BACKUP_DIR}/code.tar.gz"
  echo "  代码已恢复"
fi

# 重启服务
echo "重启服务 ..."
sudo systemctl restart artportal 2>/dev/null || pm2 restart artportal 2>/dev/null || (pkill -f 'server.mjs' 2>/dev/null; sleep 1; cd "\${SERVER_BASE}/pipeline" && nohup node server.mjs > /tmp/artportal.log 2>&1 &)
echo "完成"
`;

  await writeFile(join(DEST, "restore.sh"), restoreScript, "utf8");
  console.log("  -> restore.sh 已生成");

  console.log("\n=== 备份完成 ===");
  console.log("备份路径:", DEST);
  console.log("回档命令: scp -r", DEST, `${SERVER}:${BASE}/backups/`);
  console.log("然后在服务器上运行: bash backups/snapshot_${stamp}/restore.sh");
}

run().catch(e => { console.error("备份失败:", e.message); process.exit(1); });