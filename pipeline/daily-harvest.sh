#!/bin/bash
# daily-harvest.sh —— ArtPortal 每日例行(macOS launchd 定时任务用,Windows 旧机对应 run-daily.bat)
#
# 【重要:职责怎么分】(2026-10-03 更正)
#   机会采集(run.mjs)**早已搬上服务器**,由服务器常驻的 server.mjs 内部定时器负责
#   (.env 的 DAILY_CRAWL=1,每天北京时间 3 点 spawn `run.mjs --cap 12`),不依赖本机开机、不依赖本机余额。
#   所以本机**不再重复跑全量机会采集**(那会与服务器撞车、白烧一份 AI 钱、还要 7 小时);
#   本机只做服务器做不了的事:
#     · 截图封面(SCREENSHOT_BACKFILL 未在服务器开启;历史上 mShots 封过服务器 IP)
#     · 封面审计、类型均衡巡检
#     · 本机 ↔ 服务器双向数据同步(sync-server.mjs)
#   需要本机兜底跑一次全量采集时用 --full(服务器采集长时间不正常时用)。
#
# 每晚流程:
#   1. ca-bootstrap.mjs  —— 自愈 TLS 中间证书缺失(国内官网只发叶子证书,Node 不做 AIA 补链)
#   2. sync-server.mjs   —— 先拉一次:把服务器昨晚抓到的条目同步下来,本机才知道哪些还缺封面
#   3. 本机专属任务      —— backfill-screenshots / backfill-channel-covers / cover-audit / balance
#   4. sync-server.mjs   —— 再推一次:把本机新截好的封面推回服务器
#
# 【联网就绪 + 重试】(2026-10-03 新增)
#   launchd 在 04:17 把机器从睡眠唤醒后**立刻**执行本脚本,此时网络栈还没就绪,同步里的
#   ssh/scp 会一律报 `Can't assign requested address`(见 state/daily-2026-10-03.log:三个
#   数据文件同步全败、退出码 1)。故现在:跑联网步骤前先 wait_net 等网络,同步步骤失败再
#   退避重试(立刻 / +20s / +60s),避免"唤醒即跑、整晚白跑"。
#
# 用法:
#   bash pipeline/daily-harvest.sh               # 立刻跑一遍夜间例行(在仓库里跑也行)
#   bash pipeline/daily-harvest.sh --full        # 例外:本机也跑一次全量机会采集(兜底用,约 7 小时)
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
FULL=0
[ "${1:-}" = "--full" ] && FULL=1

cd "$SELFDIR"
export NODE_EXTRA_CA_CERTS="$SELFDIR/state/ca-intermediates.pem"
export PATH="$HOME/.local/lib/node-current/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

log "===== 每日例行开始($([ "$SELFCHECK" = 1 ] && echo 自检模式 || echo 常规模式)) ====="

# ---------- 联网就绪等待 + 退避重试(2026-10-03,见文件头说明) ----------
# 用 TCP 连服务器 22 端口判断(比 ping 准:阿里云可能屏蔽 ICMP)。最多等 120 秒。
wait_net() {
  local i
  for i in $(seq 1 60); do
    if nc -z -G 3 60.205.212.195 22 >/dev/null 2>&1; then
      [ "$i" -gt 1 ] && log "  网络就绪(等了 $(( (i - 1) * 2 )) 秒)"
      return 0
    fi
    sleep 2
  done
  log "  警告: 等网络 120 秒仍未就绪,仍继续尝试"
  return 1
}

# 带退避重试跑一次双向同步:立刻 → 等 20s → 等 60s,每次前先 wait_net。成功返回 0。
run_sync() {
  local desc="$1" n=0 d
  for d in 0 20 60; do
    if [ "$d" -gt 0 ]; then log "  等 ${d}s 后重试 ..."; sleep "$d"; fi
    wait_net
    n=$((n + 1))
    if "$NODE" sync-server.mjs >> "$LOG" 2>&1; then
      log "  $desc 成功(第 $n 次)"
      return 0
    fi
    log "  ! $desc 第 $n 次失败"
  done
  log "  ! $desc 三次均失败(数据不丢:两边各自完整,下次跑或手动 sync 会补上)"
  return 1
}

wait_net

log "[1/4] TLS 中间证书补全(ca-bootstrap) ..."
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

# 机会采集默认不跑:那是服务器 server.mjs 每日 3 点(DAILY_CRAWL)的活。--full 时才在本机兜底跑一次。
if [ "$FULL" = 1 ]; then
  log "[!] --full:本机兜底跑一次全量机会采集(run.mjs,约 7 小时) ..."
  "$NODE" --env-file=.env run.mjs >> "$LOG" 2>&1
  RUN_RC=$?
  log "  run.mjs 退出码 $RUN_RC(非 0 不阻断后续)"
fi

log "[2/4] 拉取同步(sync-server:合并一次,把服务器昨晚抓到的条目同步下来,本机才知道哪些还缺封面) ..."
run_sync "拉取同步"
PULL_RC=$?
log "  sync-server 退出码 $PULL_RC(非 0 不阻断后续,但封面任务会基于旧清单)"

log "[3/4] 本机专属任务(服务器未开启或做不了的部分) ..."
for step in backfill-screenshots backfill-channel-covers cover-audit balance; do
  log "  -> $step.mjs"
  "$NODE" --env-file=.env "$step.mjs" >> "$LOG" 2>&1
  log "     退出码 $?"
done

log "[4/4] 推送同步(sync-server:把本机新截好的封面推回服务器) ..."
run_sync "推送同步"
SYNC_RC=$?
log "  sync-server 退出码 $SYNC_RC"

log "===== 每日例行结束 ====="
exit "$SYNC_RC"