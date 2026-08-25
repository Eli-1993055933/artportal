// _tmp-subs-all-run.mjs —— 上传并运行批量开订阅脚本,然后重启服务并核验邮件群发名单
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
const HOST = "admin@60.205.212.195";
const REMOTE = "~/artportal/pipeline/_tmp-subs-all.mjs";
execFileSync("scp", [...SSH_OPTS, join(__dir, "_tmp-subs-all.mjs"), HOST + ":" + REMOTE], { timeout: 120000 });
execFileSync("ssh", [...SSH_OPTS, HOST, "cd ~/artportal/pipeline && node _tmp-subs-all.mjs"], { stdio: "inherit", timeout: 60000 });
// 服务常驻内存里的 users 数组也要刷新:重启服务
execFileSync("ssh", [...SSH_OPTS, HOST, "sudo systemctl restart artportal && sleep 2 && curl -so /dev/null -w 'HTTP=%{http_code}\n' http://localhost:8080/"], { stdio: "inherit", timeout: 60000 });
// 重跑群发逻辑里只统计数字,不真发:直接读 newsletterCount
const cnt = execFileSync("ssh", [...SSH_OPTS, HOST, "cd ~/artportal/pipeline && node --input-type=module -e \"import('./lib/auth.mjs').then(a=>console.log('SUBS='+a.newsletterCount()));\""], { encoding: "utf8", timeout: 60000 });
process.stdout.write(cnt);
process.exit(0);