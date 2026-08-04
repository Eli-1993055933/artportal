@echo off
chcp 65001>nul
rem ArtPortal 每日抓取脚本(供 Windows 任务计划调用)。
rem key 从同目录 .env 读取,不写在这里。输出追加到 state\cron.log 便于排查。
rem 注:每条命令都用绝对路径,不依赖当前目录(计划任务默认从 System32 启动,曾导致 sync-server.mjs 一步找不到模块)。
set PIPE=D:\Claude Code\pipeline
cd /d "%PIPE%"
echo ==== run at %date% %time% ==== >> "%PIPE%\state\cron.log"
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\run.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 给当日新增/重抽的条目补英文翻译(缺才补、源文变了重译;详见 backfill-en.mjs)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\backfill-en.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 给"前往官网"仍指向第三方的条目定位主办方真官网(详见 backfill-official.mjs)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\backfill-official.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 给没有封面图的条目强制截取官网页面作封面(详见 backfill-screenshots.mjs;在本机跑,截图存本站)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\backfill-screenshots.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 资讯/招聘频道每日抓取(信源见 sources-news.json / sources-jobs.json,同一套 evidence 校验)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\run-channels.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 资讯/招聘补中英双语(每日新增大多已自带双语,这里兜底补缺)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\backfill-channel-i18n.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 资讯/招聘无封面条目截图(mShots,本机跑,存本站 assets/covers)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\backfill-channel-covers.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 封面审核 agent:雷同/错放封面审计(URL 共用/截图同内容/第三方图),重找官网封面,找不到宁缺毋滥(cover-audit.mjs)
"D:\Node.js\node.exe" --env-file="%PIPE%\.env" "%PIPE%\cover-audit.mjs" >> "%PIPE%\state\cron.log" 2>&1
rem 与服务器按条合并双向同步(数据+封面):当晚新抓的自动上线,线上检索/UGC 数据绝不丢(sync-server.mjs)
"D:\Node.js\node.exe" "%PIPE%\sync-server.mjs" >> "%PIPE%\state\cron.log" 2>&1
echo ==== done at %date% %time% ==== >> "%PIPE%\state\cron.log"
