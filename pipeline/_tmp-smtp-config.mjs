// _tmp-smtp-config.mjs —— 服务器 .env 写入 SMTP_PASS 并重启(授权码经环境变量传入,不写进代码/聊天)
// 用法(需先设置环境变量 AP_SMTP_PASS):
//   PowerShell: $env:AP_SMTP_PASS='<授权码>'; node _tmp-smtp-config.mjs
import { execFileSync } from "node:child_process";
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
const HOST = "admin@60.205.212.195";
function ssh(cmd) { return execFileSync("ssh", [...SSH_OPTS, HOST, cmd], { encoding: "utf8", timeout: 90000 }).trim(); }

const val = process.env.AP_SMTP_PASS || "";
if (!val) { process.stderr.write("[smtp] 未提供 AP_SMTP_PASS\n"); process.exit(1); }
const ENV = "~/artportal/pipeline/.env";
// 已存在则改写,否则追加(值仅含小写字母数字,安全用于 sed 替换)
const SET = `grep -q '^SMTP_PASS=' ${ENV} && sed -i 's|^SMTP_PASS=.*|SMTP_PASS=${val}|' ${ENV} || echo 'SMTP_PASS=${val}' >> ${ENV}`;
process.stderr.write("[smtp] 写入 SMTP_PASS(不回显)...\n");
ssh(SET);
process.stderr.write("[smtp] 校验键已写入(不显示值):\n" + ssh(`grep -c '^SMTP_PASS=' ${ENV}`) + "\n");
process.stderr.write("[smtp] 重启服务...\n");
process.stderr.write(ssh(`sudo systemctl restart artportal && sleep 2 && echo ACTIVE=$(sudo systemctl is-active artportal) && curl -so /dev/null -w HTTP=%{http_code} http://localhost:8080/`) + "\n");
process.exit(0);