@echo off
REM 恢复本地 state/ 到 2026-08-11_043117 快照
REM 用法: 将备份目录中的文件复制回 pipeline/state/

echo === 恢复本地 state/ 快照 2026-08-11_043117 ===
echo 备份路径: D:\Vibe Coding\Trae\backups\predeploy_2026-08-11_043117
echo.
echo 手动恢复步骤:
echo 1. cd pipeline/state/
echo 2. 将 backups\predeploy_2026-08-11_043117\ 中的文件复制过来
echo.
echo 或使用: copy /Y backups\predeploy_2026-08-11_043117\* pipeline\state\
echo ===
