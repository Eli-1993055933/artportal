// cleanup.mjs —— 清理测试用户和假数据，仅在首次部署时执行一次
// 用法: node pipeline/cleanup.mjs
// 安全: 先备份再清理，备份存到 backups/pre-cleanup-<timestamp>/

import { execSync } from "node:child_process";
import { mkdir, writeFile, readFile, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dir, "state");
const BACKUPS = join(__dir, "..", "backups");
const ts = new Date();
const stamp = ts.getFullYear() + "-" +
  String(ts.getMonth() + 1).padStart(2, "0") + "-" +
  String(ts.getDate()).padStart(2, "0") + "_" +
  String(ts.getHours()).padStart(2, "0") +
  String(ts.getMinutes()).padStart(2, "0") +
  String(ts.getSeconds()).padStart(2, "0");
const DEST = join(BACKUPS, "pre-cleanup-" + stamp);

// 真实用户邮箱
const REAL_EMAILS = ["3471483657@qq.com"];
const REAL_UID = "ufef005d0d370";

async function run() {
  console.log("=== 清理测试用户和假数据 ===");
  console.log("时间:", ts.toLocaleString("zh-CN"));
  console.log("备份路径:", DEST);
  console.log("");

  // 1. 备份当前 state/
  console.log("[1/5] 备份当前 state/ ...");
  await mkdir(DEST, { recursive: true });
  for (const f of ["users.json", "sessions.json", "events.jsonl", "artportal.db", "artportal.db-wal", "artportal.db-shm", "review-queue.json", "tombstones.json", "search-cache.json", "hashes.json", "hashes-channels.json", "regions-report.json", "seed-provenance.json", "survey-emails.json", "mail-secret"]) {
    const src = join(STATE, f);
    if (existsSync(src)) {
      await copyFile(src, join(DEST, f));
      console.log("  备份:", f);
    }
  }
  console.log("  备份完成");

  // 2. 清理 users.json —— 只保留真实用户
  console.log("[2/5] 清理 users.json ...");
  const usersRaw = await readFile(join(STATE, "users.json"), "utf8");
  const usersData = JSON.parse(usersRaw);
  const originalCount = usersData.users.length;
  usersData.users = usersData.users.filter(u => REAL_EMAILS.includes(u.email));
  const removedCount = originalCount - usersData.users.length;
  await writeFile(join(STATE, "users.json"), JSON.stringify(usersData, null, 2), "utf8");
  console.log("  删除 " + removedCount + " 个测试用户, 保留 " + usersData.users.length + " 个真实用户");

  // 3. 清理 sessions.json —— 只保留真实用户的会话
  console.log("[3/5] 清理 sessions.json ...");
  const sessionsRaw = await readFile(join(STATE, "sessions.json"), "utf8");
  const sessionsData = JSON.parse(sessionsRaw);
  const sessionKeys = Object.keys(sessionsData.sessions);
  let removedSessions = 0;
  for (const key of sessionKeys) {
    if (sessionsData.sessions[key].uid !== REAL_UID) {
      delete sessionsData.sessions[key];
      removedSessions++;
    }
  }
  await writeFile(join(STATE, "sessions.json"), JSON.stringify(sessionsData, null, 2), "utf8");
  console.log("  删除 " + removedSessions + " 个测试会话, 保留 " + Object.keys(sessionsData.sessions).length + " 个会话");

  // 4. 清理数据库中的测试数据
  console.log("[4/5] 清理数据库 test data ...");
  try {
    const { default: Database } = await import("better-sqlite3");
    const dbPath = join(STATE, "artportal.db");
    if (existsSync(dbPath)) {
      const db = new Database(dbPath);
      // 删除所有测试用户相关的数据
      // 获取所有测试用户 UID
      const testUIDs = [];
      for (const u of usersData.users) {
        // 这些是真实用户UID，保留他们的数据
      }
      // 从原始数据中提取所有测试UID
      const allUsers = JSON.parse(usersRaw).users;
      const testUsers = allUsers.filter(u => !REAL_EMAILS.includes(u.email));
      const testUIDList = testUsers.map(u => u.id);

      // 逐个表清理
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      for (const t of tables) {
        const tableName = t.name;
        // 跳过系统表
        if (tableName === "sqlite_sequence") continue;

        // 查找是否有 uid 或 author_email 列
        const cols = db.prepare("PRAGMA table_info(" + tableName + ")").all();
        const hasUid = cols.some(c => c.name === "uid");
        const hasEmail = cols.some(c => c.name === "author_email");
        const hasFollower = cols.some(c => c.name === "follower");
        const hasFollowee = cols.some(c => c.name === "followee");

        let deleted = 0;
        if (hasUid) {
          for (const tuid of testUIDList) {
            const info = db.prepare("DELETE FROM " + tableName + " WHERE uid = ?").run(tuid);
            deleted += info.changes;
          }
        }
        if (hasEmail) {
          for (const tu of testUsers) {
            const info = db.prepare("DELETE FROM " + tableName + " WHERE author_email = ?").run(tu.email);
            deleted += info.changes;
          }
        }
        // 清理 follows 表（双向关系）
        if (hasFollower) {
          for (const tuid of testUIDList) {
            const info = db.prepare("DELETE FROM " + tableName + " WHERE follower = ? OR followee = ?").run(tuid, tuid);
            deleted += info.changes;
          }
        }
        // 清理 notifications 中 TESTUID 之类的
        if (tableName === "notifications") {
          const info = db.prepare("DELETE FROM " + tableName + " WHERE uid = 'TESTUID'").run();
          deleted += info.changes;
        }

        if (deleted > 0) {
          console.log("  表 " + tableName + ": 删除 " + deleted + " 行");
        }
      }
      db.close();
      console.log("  数据库清理完成");
    } else {
      console.log("  数据库文件不存在，跳过");
    }
  } catch (e) {
    console.log("  数据库清理跳过（better-sqlite3 不可用）:", e.message);
  }

  // 5. 清理 events.jsonl —— 删除测试用户相关事件
  console.log("[5/5] 清理 events.jsonl ...");
  const eventsPath = join(STATE, "events.jsonl");
  if (existsSync(eventsPath)) {
    const eventsRaw = await readFile(eventsPath, "utf8");
    const lines = eventsRaw.split("\n").filter(Boolean);
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        // 保留真实用户事件，删除测试用户事件
        if (ev.email && REAL_EMAILS.includes(ev.email)) {
          kept.push(line);
        } else if (ev.uid === REAL_UID) {
          kept.push(line);
        } else {
          removed++;
        }
      } catch (e) {
        kept.push(line); // 无法解析的保留
      }
    }
    await writeFile(eventsPath, kept.join("\n") + (kept.length > 0 ? "\n" : ""), "utf8");
    console.log("  删除 " + removed + " 条事件, 保留 " + kept.length + " 条");
  } else {
    console.log("  events.jsonl 不存在，跳过");
  }

  console.log("\n=== 清理完成 ===");
  console.log("备份位置:", DEST);
  console.log("如需回滚: 将备份文件复制回 pipeline/state/");
}

run().catch(e => { console.error("清理失败:", e.message); process.exit(1); });