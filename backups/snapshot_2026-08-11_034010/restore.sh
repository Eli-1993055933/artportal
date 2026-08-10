#!/bin/bash
# 恢复 ArtPortal 到 2026-08-11_034010 快照
# 用法: 将本目录 scp 到服务器，然后运行此脚本

SERVER_BASE="/home/admin/artportal"
BACKUP_DIR="$(dirname "$0")"

echo "=== 恢复 ArtPortal 快照 2026-08-11_034010 ==="

# 恢复 state
if [ -f "${BACKUP_DIR}/state.tar.gz" ]; then
  echo "[1/2] 恢复 state/ ..."
  cd "${SERVER_BASE}"
  tar xzf "${BACKUP_DIR}/state.tar.gz"
  echo "  state/ 已恢复"
fi

# 恢复代码
if [ -f "${BACKUP_DIR}/code.tar.gz" ]; then
  echo "[2/2] 恢复代码 ..."
  cd "${SERVER_BASE}"
  tar xzf "${BACKUP_DIR}/code.tar.gz"
  echo "  代码已恢复"
fi

# 重启服务
echo "重启服务 ..."
sudo systemctl restart artportal 2>/dev/null || pm2 restart artportal 2>/dev/null || (pkill -f 'server.mjs' 2>/dev/null; sleep 1; cd "${SERVER_BASE}/pipeline" && nohup node server.mjs > /tmp/artportal.log 2>&1 &)
echo "完成"
