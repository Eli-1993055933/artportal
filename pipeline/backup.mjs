// backup.mjs —— 创建服务器状态快照并保存到本地 backups/ 目录
// 用法:
//   node pipeline/backup.mjs              # 远程:从服务器拉取 state/ + 代码
//   node pipeline/backup.mjs --local      # 本地:备份本地 pipeline/state/（部署前保险）
//   node pipeline/backup.mjs --remote     # 同默认，远程备份
// 效果: 将数据保存到 backups/YYYY-MM-DD_HHmmss/ 目录
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
const STATE = join(__dir, "state");
const MODE = process.argv.includes("--local") ? "local" : "remote";

const ts = new Date();
const stamp = ts.getFullYear() + "-" +
  String(ts.getMonth() + 1).padStart(2, "0") + "-" +
  String(ts.getDate()).padStart(2, "0") + "_" +
  String(ts.getHours()).padStart(2, "0") +
  String(ts.getMinutes()).padStart(2, "0") +
  String(ts.getSeconds()).padStart(2, "0");
const DEST = join(BACKUPS, MODE === "local" ? "predeploy_" + stamp : "snapshot_" + stamp);

// 检测是否有 ssh/scp（仅远程模式需要）
function have(cmd) {
  try { execSync("where " + cmd, { stdio: "ignore" }); return true; } catch (e) { return false; }
}
const hasSSH = have("ssh");
const hasSCP = have("scp");

async function remoteBackup() {
  console.log("=== 远程备份: 从服务器拉取 state/ ===");
  if (!hasSSH || !hasSCP) {
    console.error("错误: 需要 ssh 和 scp 命令");
    process.exit(1);
  }
  await mkdir(DEST, { recursive: true });

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

  console.log("[3/3] 记录版本信息 ...");
  await writeVersionInfo();

  // 写入恢复说明
  const restoreScript = `#!/bin/bash
# 恢复 ArtPortal 到 ${stamp} 快照
SERVER_BASE="${BASE}"
BACKUP_DIR="$(dirname "$0")"
echo "=== 恢复 ArtPortal 快照 ${stamp} ==="
if [ -f "\${BACKUP_DIR}/state.tar.gz" ]; then
  echo "[1/2] 恢复 state/ ..."
  cd "\${SERVER_BASE}"
  tar xzf "\${BACKUP_DIR}/state.tar.gz"
  echo "  state/ 已恢复"
fi
if [ -f "\${BACKUP_DIR}/code.tar.gz" ]; then
  echo "[2/2] 恢复代码 ..."
  cd "\${SERVER_BASE}"
  tar xzf "\${BACKUP_DIR}/code.tar.gz"
  echo "  代码已恢复"
fi
echo "重启服务 ..."
sudo systemctl restart artportal 2>/dev/null || pm2 restart artportal 2>/dev/null || (pkill -f 'server.mjs' 2>/dev/null; sleep 1; cd "\${SERVER_BASE}/pipeline" && nohup node server.mjs > /tmp/artportal.log 2>&1 &)
echo "完成"
`;
  await writeFile(join(DEST, "restore.sh"), restoreScript, "utf8");
  console.log("  -> restore.sh 已生成");

  console.log("\n=== 远程备份完成 ===");
  console.log("备份路径:", DEST);
  console.log("回档: scp -r", DEST, `${SERVER}:${BASE}/backups/`, "&& ssh ${SERVER} bash backups/snapshot_${stamp}/restore.sh");
}

async function localBackup() {
  console.log("=== 本地备份: 备份本地 state/（部署前保险） ===");
  console.log("目标:", DEST);
  console.log("时间:", ts.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }));
  console.log("");

  await mkdir(DEST, { recursive: true });

  // 备份 state/ 目录
  console.log("[1/3] 备份本地 state/ ...");
  const stateFiles = [
    "users.json", "sessions.json", "events.jsonl",
    "artportal.db", "artportal.db-wal", "artportal.db-shm",
    "review-queue.json", "tombstones.json", "search-cache.json",
    "hashes.json", "hashes-channels.json", "regions-report.json",
    "seed-provenance.json", "survey-emails.json", "mail-secret"
  ];
  let count = 0;
  for (const f of stateFiles) {
    const src = join(STATE, f);
    if (existsSync(src)) {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(src, join(DEST, f));
      count++;
    }
  }
  console.log("  已备份 " + count + " 个文件");

  // 记录版本信息
  console.log("[2/3] 记录版本信息 ...");
  await writeVersionInfo();

  // 写入恢复说明
  const restoreScript = `@echo off
REM 恢复本地 state/ 到 ${stamp} 快照
REM 用法: 将备份目录中的文件复制回 pipeline/state/

echo === 恢复本地 state/ 快照 ${stamp} ===
echo 备份路径: ${DEST}
echo.
echo 手动恢复步骤:
echo 1. cd pipeline/state/
echo 2. 将 backups\\predeploy_${stamp}\\ 中的文件复制过来
echo.
echo 或使用: copy /Y backups\\predeploy_${stamp}\\* pipeline\\state\\
echo ===
`;
  await writeFile(join(DEST, "restore.cmd"), restoreScript, "utf8");
  console.log("  -> restore.cmd 已生成");

  console.log("\n=== 本地备份完成 ===");
  console.log("备份路径:", DEST);
  console.log("恢复: 将备份文件复制回 pipeline/state/");
}

async function writeVersionInfo() {
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
}

async function run() {
  if (MODE === "local") {
    await localBackup();
  } else {
    await remoteBackup();
  }
}

run().catch(e => { console.error("备份失败:", e.message); process.exit(1); });