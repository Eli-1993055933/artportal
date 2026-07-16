@echo off
rem ArtPortal 每日抓取脚本(供 Windows 任务计划调用)。
rem key 从同目录 .env 读取,不写在这里。输出追加到 state\cron.log 便于排查。
cd /d "D:\Claude Code\pipeline"
echo ==== run at %date% %time% ==== >> "D:\Claude Code\pipeline\state\cron.log"
"D:\Node.js\node.exe" --env-file=.env run.mjs >> "D:\Claude Code\pipeline\state\cron.log" 2>&1
rem 给当日新增/重抽的条目补英文翻译(缺才补、源文变了重译;详见 backfill-en.mjs)
"D:\Node.js\node.exe" --env-file=.env backfill-en.mjs >> "D:\Claude Code\pipeline\state\cron.log" 2>&1
rem 给"前往官网"仍指向第三方的条目定位主办方真官网(详见 backfill-official.mjs)
"D:\Node.js\node.exe" --env-file=.env backfill-official.mjs >> "D:\Claude Code\pipeline\state\cron.log" 2>&1
rem 给没有封面图的条目强制截取官网页面作封面(详见 backfill-screenshots.mjs;在本机跑,截图存本站)
"D:\Node.js\node.exe" --env-file=.env backfill-screenshots.mjs >> "D:\Claude Code\pipeline\state\cron.log" 2>&1
echo ==== done at %date% %time% ==== >> "D:\Claude Code\pipeline\state\cron.log"
