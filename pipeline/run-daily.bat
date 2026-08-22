@echo off
chcp 65001>nul
rem ArtPortal 每日抓取脚本(供 Windows 任务计划调用)。
rem key 从同目录 .env 读取,不写在这里。输出追加到 state\cron.log 便于排查。
rem 注:每条命令都用绝对路径,不依赖当前目录(计划任务默认从 System32 启动,曾导致 sync-server.mjs 一步找不到模块)。
rem
rem 2026-08-04:抓取/双语/官网定位已搬上服务器(不依赖本机夜间开机,见 server.mjs 的
rem DAILY_CRAWL/CHANNELS_CRAWL/BACKFILL_EN),本机只保留 mShots 服务器端会被 403 拦截、
rem 必须本机跑的截图相关步骤,以及负责本机↔服务器双向同步的 sync-server.mjs。
set PIPE=D:\Vibe Coding\Trae\pipeline
cd /d "%PIPE%"
echo ==== run at %date% %time% ==== >> "%PIPE%\state\cron.log"
rem 先同步一次:把服务器夜里抓到的新条目拉下来,本机才知道哪些还缺封面
"D:\Node.js\node.exe" "%PIPE%\sync-server.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 给没有封面图的条目强制截取官网页面作封面(mShots,本机跑,截图存本站)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\backfill-screenshots.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 资讯/招聘无封面条目截图(同上,mShots 本机跑)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\backfill-channel-covers.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 封面审核 agent:雷同/错放封面审计(URL 共用/截图同内容/第三方图),重找官网封面,找不到宁缺毋滥(cover-audit.mjs)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\cover-audit.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 再同步一次:把本机新截好的封面推回服务器
"D:\Node.js\node.exe" "%PIPE%\sync-server.mjs" >> "%PIPE%\state\cron.log" 2>&1
echo ==== done at %date% %time% ==== >> "%PIPE%\state\cron.log"
