// dev-server.mjs —— 本地开发启动包装:server.mjs 本身不读 .env(注释里写的是
// `set -a && . ./.env && set +a && node server.mjs` 这种 shell 用法),Windows/PowerShell
// 环境下不方便这么起,这个文件负责先把 .env 灌进 process.env 再拉起真正的 server.mjs。
// 只在本机开发用,生产环境用原来 systemd + 已导出环境变量的方式,不受影响。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
try {
  const text = readFileSync(join(__dir, ".env"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
} catch (e) { process.stderr.write("[dev-server] 未找到 .env,跳过(" + e.message + ")\n"); }

await import("./server.mjs");
