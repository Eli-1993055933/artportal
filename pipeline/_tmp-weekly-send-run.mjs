// _tmp-weekly-send-run.mjs —— 上传发信脚本到服务器并执行(试发或群发)
// 用法:node _tmp-weekly-send-run.mjs test|bulk [email]
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dir = dirname(fileURLToPath(import.meta.url));
const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20"];
const HOST = "admin@60.205.212.195";

const mode = process.argv[2] || "test";
const email = process.argv[3] || "";
const local = join(__dir, "_tmp-weekly-send.mjs");
const REMOTE = "~/artportal/pipeline/_tmp-weekly-send.mjs";

execFileSync("scp", [...SSH_OPTS, local, HOST + ":" + REMOTE], { timeout: 120000 });
process.stderr.write("[run] 已上传 " + REMOTE + "\n");
const args = [mode, email].filter(Boolean);
const out = execFileSync("ssh", [...SSH_OPTS, HOST, "cd ~/artportal/pipeline && node _tmp-weekly-send.mjs " + args.join(" ")], { encoding: "utf8", timeout: 600000 });
process.stdout.write(out);
process.exit(0);