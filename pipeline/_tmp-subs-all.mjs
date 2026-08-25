// _tmp-subs-all.mjs —— 批量给所有既有用户开启周报订阅(在服务器运行,操作 state/users.json)
// 用法:node _tmp-subs-all.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, writeFile, rename } from "node:fs/promises";
const __dir = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dir, "state", "users.json");

const raw = await readFile(FILE, "utf8");
const d = JSON.parse(raw);
const list = Array.isArray(d.users) ? d.users : [];
const withEmail = list.filter(u => u.email);
const beforeSub = withEmail.filter(u => u.newsletter).length;
let changed = 0;
for (const u of list) { if (!u.newsletter) { u.newsletter = true; changed++; } }
const tmp = FILE + ".tmp-" + process.pid;
await writeFile(tmp, JSON.stringify(d, null, 2), "utf8");
await rename(tmp, FILE);
process.stdout.write("[subs] users=" + list.length + " 含邮箱=" + withEmail.length +
  " 订阅(改前)=" + beforeSub + " 本次开启=" + changed +
  " 订阅(改后)=" + withEmail.filter(u => u.newsletter).length + "\n");
process.exit(0);