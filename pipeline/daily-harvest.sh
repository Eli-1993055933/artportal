#!/bin/bash
# daily-harvest.sh —— ArtPortal 每日采集(macOS launchd 定时任务用,Windows 旧机用 run-daily.bat)
#
# 每晚流程:
#   1. ca-bootstrap.mjs  —— 自愈 TLS 中间证书缺失(国内官网只发叶子证书,Node 不做 AIA 补链)
#   2. run.mjs           —— 全量信源采集(哈希未变自动跳过,日常轮很快;AI 提取需 .env 里的 key)
#   3. sync-server.mjs   —— 双向按条合并上线(服务器先备份,谁的数据都不丢)
#
# 用法:
#   bash pipeline/daily-harvest.sh               # 立刻完整跑一遍(在仓库里跑也行)
#   bash pipeline/daily-harvest.sh --selfcheck   # 快速自检(不调 AI、不写服务器):证书+单源抓取+SSH 干跑
#   bash pipeline/daily-harvest.sh --install     # 安装每日 04:17 定时任务(装到 ~/.artportal-harvest)
#
# 为什么要装副本:macOS 隐私保护(TCC)禁止 launchd 启动的进程访问 ~/Desktop,
#   所以定时任务跑的是安装到 ~/.artportal-harvest 的独立副本(代码+node_modules+.env+state+site/data)。
#   代码更新后重跑 --install 刷新代码;state/(哈希续跑缓存)与 site/data/ 只在首次安装时复制,之后副本自己演化。
#   副本与服务器靠 sync-server.mjs 双向合并收敛,桌面仓库与副本两份都不会丢数据。

set -uo pipefail

SELFDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELFDIR/.." && pwd)"

NODE="$HOME/.local/lib/node-current/bin/node"
INSTALL_DIR="$HOME/.artportal-harvest"
PLIST="$HOME/Library/LaunchAgents/com.artportal.daily-harvest.plist"
HOUR=4
MINUTE=17

# ---------- 安装定时任务 ----------
install_agent() {
  echo "[install] 部署副本到 $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR/pipeline/lib" "$INSTALL_DIR/pipeline/state" "$INSTALL_DIR/site/data" "$INSTALL_DIR/logs"

  # 1) 代码与配置(每次 --install 都刷新成仓库当前版本;_tmp-* 是一次性调试脚本,不带入)
  for f in "$SELFDIR"/*.mjs; do
    case "$(basename "$f")" in _tmp*) ;; *) cp "$f" "$INSTALL_DIR/pipeline/";; esac
  done
  cp "$SELFDIR"/daily-harvest.sh "$INSTALL_DIR/pipeline/daily-harvest.sh"
  chmod +x "$INSTALL_DIR/pipeline/daily-harvest.sh"
  cp -R "$SELFDIR/lib/." "$INSTALL_DIR/pipeline/lib/"
  for j in sources.json sources-news.json sources-jobs.json sources-candidates-v2.json regions.json package.json package-lock.json; do
    [ -f "$SELFDIR/$j" ] && cp "$SELFDIR/$j" "$INSTALL_DIR/pipeline/$j"
  done

  # 2) 依赖(50MB,只增不删;package 版本变了重跑会补齐差异文件)
  if [ -d "$SELFDIR/node_modules" ]; then
    rsync -a "$SELFDIR/node_modules/" "$INSTALL_DIR/pipeline/node_modules/"
  else
    echo "  警告: 仓库里没有 node_modules,副本将无法运行(先在仓库 pipeline/ 下 npm install)"
  fi

  # 3) 密钥(每次以仓库 .env 为准;权限 600)
  if [ -f "$SELFDIR/.env" ]; then
    cp "$SELFDIR/.env" "$INSTALL_DIR/pipeline/.env"
    chmod 600 "$INSTALL_DIR/pipeline/.env"
  else
    echo "  警告: 未找到 $SELFDIR/.env,采集无法调 AI"
  fi

  # 4) 续跑缓存与数据 —— 只在副本缺失时复制,绝不覆盖副本每晚自己的演化
  [ -f "$INSTALL_DIR/pipeline/state/hashes.json" ] || cp "$SELFDIR/state/hashes.json" "$INSTALL_DIR/pipeline/state/hashes.json" 2>/dev/null || true
  [ -f "$INSTALL_DIR/pipeline/state/tombstones.json" ] || cp "$SELFDIR/state/tombstones.json" "$INSTALL_DIR/pipeline/state/tombstones.json" 2>/dev/null || true
  [ -f "$INSTALL_DIR/pipeline/state/ca-intermediates.pem" ] || cp "$SELFDIR/state/ca-intermediates.pem" "$INSTALL_DIR/pipeline/state/ca-intermediates.pem" 2>/dev/null || true
  for d in opportunities.json news.json jobs.json; do
    [ -f "$INSTALL_DIR/site/data/$d" ] || cp "$ROOT/site/data/$d" "$INSTALL_DIR/site/data/$d" 2>/dev/null || true
  done

  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.artportal.daily-harvest</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$INSTALL_DIR/pipeline/daily-harvest.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR/pipeline</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$INSTALL_DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_DIR/logs/launchd.err.log</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
PLISTEOF

  launchctl bootout "gui/$(id -u)/com.artportal.daily-harvest" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "[install] 已安装定时任务: 每天 $HOUR:$MINUTE(电脑关机/睡眠错过时,唤醒后 launchd 自动补跑一次)"
  echo "  副本:   $INSTALL_DIR/pipeline"
  echo "  日志:   $INSTALL_DIR/pipeline/state/daily-YYYY-MM-DD.log"
  echo "  自检:   bash $INSTALL_DIR/pipeline/daily-harvest.sh --selfcheck"
  exit 0
}

[ "${1:-}" = "--install" ] && install_agent

# ---------- 正常运行(仓库或副本通用) ----------
[ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ -z "${NODE:-}" ] || [ ! -x "$NODE" ]; then
  echo "错误: 找不到 node(需要 $HOME/.local/lib/node-current/bin/node)" >&2
  exit 1
fi

DAY="$(date +%Y-%m-%d)"
LOG="$SELFDIR/state/daily-$DAY.log"
mkdir -p "$SELFDIR/state"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

SELFCHECK=0
[ "${1:-}" = "--selfcheck" ] && SELFCHECK=1

cd "$SELFDIR"
export NODE_EXTRA_CA_CERTS="$SELFDIR/state/ca-intermediates.pem"
export PATH="$HOME/.local/lib/node-current/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log "===== 每日采集开始($([ "$SELFCHECK" = 1 ] && echo 自检模式 || echo 完整模式)) ====="

log "[1/3] TLS 中间证书补全(ca-bootstrap) ..."
"$NODE" ca-bootstrap.mjs >> "$LOG" 2>&1
log "  ca-bootstrap 退出码 $?"

if [ "$SELFCHECK" = 1 ]; then
  log "[2/3] 单源抓取自检(--only cafa-tzgg --fetch-only,不调 AI) ..."
  "$NODE" --env-file=.env run.mjs --only cafa-tzgg --fetch-only >> "$LOG" 2>&1
  log "  run.mjs 自检退出码 $?"
  log "[3/3] 同步干跑(sync-server --dry,只验证 SSH 与合并) ..."
  "$NODE" sync-server.mjs --dry >> "$LOG" 2>&1
  RC=$?
  log "  sync --dry 退出码 $RC"
  log "===== 自检结束 ====="
  exit $RC
fi

log "[2/3] 全量信源采集(run.mjs) ..."
"$NODE" --env-file=.env run.mjs >> "$LOG" 2>&1
RUN_RC=$?
# run.mjs 即使部分失败(单源异常/AI 余额不足)也可能已写盘,继续同步把成果推上去
log "  run.mjs 退出码 $RUN_RC(非 0 不阻断同步)"

log "[3/3] 双向同步上线(sync-server) ..."
"$NODE" sync-server.mjs >> "$LOG" 2>&1
SYNC_RC=$?
log "  sync-server 退出码 $SYNC_RC"

log "===== 每日采集结束 ====="
exit "$SYNC_RC"