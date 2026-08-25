// _tmp-weekly-enable.mjs —— 在服务器打开周报全自动(出刊+邮件群发)并重启服务验证
// 用法:node _tmp-weekly-enable.mjs
// 备案已通过,故同时开启:
//   WEEKLY_REPORT=1      自动出刊(每月一 9 点后)
//   NEWSLETTER_BULK=1    群发闸口(备案后开放)
//   NEWSLETTER_AUTO=1    出刊后自动群发
import { execFileSync } from "node:child_process";
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
const HOST = "admin@60.205.212.195";
function ssh(cmd) { return execFileSync("ssh", [...SSH_OPTS, HOST, cmd], { encoding: "utf8", timeout: 90000 }).trim(); }

const ENV = "~/artportal/pipeline/.env";
// 每个开关:无则追加,有则原地改写为指定值
function ensureLine(key, val) {
  return `grep -q '^${key}=' ${ENV} && sed -i 's/^${key}=.*/${key}=${val}/' ${ENV} || echo '${key}=${val}' >> ${ENV}`;
}
const SET = [ensureLine("WEEKLY_REPORT", "1"), ensureLine("NEWSLETTER_BULK", "1"), ensureLine("NEWSLETTER_AUTO", "1")].join(" && ");
process.stderr.write("[tmp-weekly-enable] 设置三个开关 ...\n");
process.stderr.write("结果:\n" + ssh(SET + ` && grep -E '^(WEEKLY_REPORT|NEWSLETTER_BULK|NEWSLETTER_AUTO)=' ${ENV} | sed 's/\\(PASS\\|SECRET\\)=.*/\\1=<已配置(不显示值)>/'`) + "\n");
// 顺带检查 SMTP/发信是否已配置(只看键是否存在,不显示任何值)
process.stderr.write("[tmp-weekly-enable] 检查 SMTP 发信配置(只看键名):\n");
process.stderr.write(ssh(`grep -oE '^[A-Z][A-Z0-9_]*(HOST|USER|FROM|TLS)' ${ENV} | sort -u`) + "\n");
process.stderr.write("[tmp-weekly-enable] 重启服务并验证 HTTP ...\n");
process.stderr.write(ssh(`sudo systemctl restart artportal && sleep 2 && echo ACTIVE=$(sudo systemctl is-active artportal) && curl -so /dev/null -w HTTP=%{http_code} http://localhost:8080/`) + "\n");
process.exit(0);