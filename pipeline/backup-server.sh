#!/bin/bash
# 服务器端自动备份脚本 —— 每天备份 state/，保留最近 7 天
# 由 cron 调用，无需外部依赖

BASE=/home/admin/artportal
BACKUP_DIR=$BASE/deploy_backups/auto
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# 备份 state/（包含用户数据 — 最高优先级！）
cd $BASE
tar czf $BACKUP_DIR/state_$TIMESTAMP.tar.gz pipeline/state/ 2>/dev/null

# 备份 .env（敏感配置）
cp pipeline/.env $BACKUP_DIR/env_$TIMESTAMP 2>/dev/null

# 记录版本和备份时间
echo "{\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"version\":\"$(cat VERSION 2>/dev/null)\"}" > $BACKUP_DIR/meta_$TIMESTAMP.json

# 清理 7 天前的旧备份
find $BACKUP_DIR -name 'state_*.tar.gz' -mtime +7 -delete 2>/dev/null
find $BACKUP_DIR -name 'env_*' -mtime +7 -delete 2>/dev/null
find $BACKUP_DIR -name 'meta_*.json' -mtime +7 -delete 2>/dev/null

echo "备份完成: $TIMESTAMP"