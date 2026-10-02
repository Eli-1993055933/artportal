#!/bin/bash
# backup-weekly.sh —— 每周加密备份
#   服务器 state/ → 本地快照 → AES-256 加密 → 推送私有仓库
#
# 用法:
#   bash pipeline/backup-weekly.sh            # 立刻备份一次
#   bash pipeline/backup-weekly.sh --dry      # 只做到加密，不推送 GitHub
#   bash pipeline/backup-weekly.sh --install  # 安装每周一 10:00 定时任务（装到 ~/.artportal-backup）
#
# 依赖: ssh / scp / openssl / git / gh(已登录)，不需要 Node
# 口令: <备份目录>/.backup-passphrase —— 唯一钥匙，务必另存密码管理器；丢失则加密包永久无法解密
# 说明: 明文 state.tar.gz 只留本地（不进 git），上 GitHub 的永远是加密包。
#       macOS 隐私保护禁止 launchd 访问桌面，所以定时任务跑的是安装到 ~/.artportal-backup 的副本。

set -euo pipefail

SELFDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$SELFDIR/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$SELFDIR/.." && pwd)"
BACKUPS="$ROOT/backups"

SERVER="admin@60.205.212.195"
BASE="/home/admin/artportal"
REPO="Eli-1993055933/artportal-data-backup"
PASSFILE="$BACKUPS/.backup-passphrase"
WORK="$BACKUPS/.data-backup-repo"
LOG="$BACKUPS/backup-weekly.log"

INSTALL_DIR="$HOME/.artportal-backup"
PLIST="$HOME/Library/LaunchAgents/com.artportal.weekly-backup.plist"

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
unset GH_TOKEN 2>/dev/null || true

# ---------- 安装定时任务 ----------
install_agent() {
  # 保持与仓库一致的布局: <根>/pipeline/脚本 + <根>/backups/数据
  mkdir -p "$INSTALL_DIR/pipeline" "$INSTALL_DIR/backups"
  cp "$SELF" "$INSTALL_DIR/pipeline/weekly-backup.sh"
  chmod +x "$INSTALL_DIR/pipeline/weekly-backup.sh"
  if [ -f "$PASSFILE" ]; then
    cp "$PASSFILE" "$INSTALL_DIR/backups/.backup-passphrase"
    chmod 600 "$INSTALL_DIR/backups/.backup-passphrase"
  else
    echo "警告: 未找到 $PASSFILE，安装副本缺少口令，请手动放入 $INSTALL_DIR/backups/.backup-passphrase"
  fi

  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.artportal.weekly-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/pipeline/weekly-backup.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>10</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/backups/weekly-backup.out.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/backups/weekly-backup.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLISTEOF

  launchctl bootout "gui/$(id -u)/com.artportal.weekly-backup" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "已安装定时任务: 每周一 10:00"
  echo "  脚本: $INSTALL_DIR/pipeline/weekly-backup.sh"
  echo "  备份: $INSTALL_DIR/backups/"
  echo "  日志: $INSTALL_DIR/backups/backup-weekly.log"
  exit 0
}

[ "${1:-}" = "--install" ] && install_agent

DRY=0
[ "${1:-}" = "--dry" ] && DRY=1

STAMP="$(date +%Y-%m-%d_%H%M%S)"
DAY="$(date +%Y-%m-%d)"
DEST="$BACKUPS/snapshot_$STAMP"
ENC="$BACKUPS/artportal-state-$DAY.enc"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "===== 每周加密备份开始 ====="

# 0) 前置检查
command -v openssl >/dev/null || { log "错误: 缺少 openssl"; exit 1; }
[ -f "$PASSFILE" ] || { log "错误: 找不到口令文件 $PASSFILE"; exit 1; }
PASS="$(cat "$PASSFILE")"
[ -n "$PASS" ] || { log "错误: 口令文件为空"; exit 1; }
mkdir -p "$DEST"

# 1) 从服务器拉 state/ 与 .env
RTGZ="/tmp/artportal_state_$STAMP.tar.gz"
RENV="/tmp/artportal_env_$STAMP"
log "[1/4] 拉取服务器 state/ ..."
ssh -o BatchMode=yes -o ConnectTimeout=15 "$SERVER" \
  "cd $BASE && tar czf $RTGZ pipeline/state/ && cp pipeline/.env $RENV 2>/dev/null; true"
scp -q "$SERVER:$RTGZ" "$DEST/state.tar.gz"
if scp -q "$SERVER:$RENV" "$DEST/env" 2>/dev/null; then
  log "  .env 已保存"
else
  log "  警告: .env 拉取失败（继续）"
fi
ssh -o BatchMode=yes "$SERVER" "rm -f $RTGZ $RENV" || true
log "  state.tar.gz: $(du -h "$DEST/state.tar.gz" | cut -f1)"

# 2) 加密（明文只留本地）
log "[2/4] AES-256-CBC (PBKDF2 200k) 加密 ..."
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$DEST/state.tar.gz" -out "$ENC" -pass "pass:$PASS"
log "  加密包: $(basename "$ENC") $(du -h "$ENC" | cut -f1)"

# 3) 校验和
( cd "$DEST" && shasum -a 256 state.tar.gz > MANIFEST.sha256 )
( cd "$BACKUPS" && shasum -a 256 "$(basename "$ENC")" >> "$DEST/MANIFEST.sha256" )

# 4) 推送私有仓库（走 git，避免 gh api 的 ARG_MAX 上限）
log "[3/4] 推送私有仓库 $REPO ..."
if [ "$DRY" = "1" ]; then
  log "  [dry] 跳过推送"
else
  if [ -d "$WORK/.git" ]; then
    git -C "$WORK" fetch -q origin
    git -C "$WORK" reset -q --hard origin/main
  else
    rm -rf "$WORK"
    git clone -q "https://github.com/$REPO.git" "$WORK"
  fi
  cp "$ENC" "$WORK/"
  git -C "$WORK" add -A
  git -C "$WORK" -c user.name="ArtPortal Backup" -c user.email="backup@artportal.local" \
    commit -q -m "weekly encrypted backup $DAY" || log "  无新变更"
  git -C "$WORK" -c credential.helper='!gh auth git-credential' push -q origin HEAD:main
  log "  已上传 $(basename "$ENC")"
fi

log "[4/4] 完成。本地快照: $DEST"
log "===== 每周加密备份结束 ====="