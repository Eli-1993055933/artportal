// db.mjs —— UGC 数据层(SQLite / better-sqlite3,WAL)。路线图前置 C:
// 评论/投稿这类写入频繁的 UGC 从第一天就进 SQLite,免得 JSON 文件并发写与日后迁移之痛。
// 账号/会话仍留在 auth.mjs 的 JSON(低频,已稳定运行)。
//
// 懒加载:better-sqlite3 缺失时服务照常启动,只有 UGC 接口报"暂不可用",绝不拖垮整站。
// 库文件:pipeline/state/artportal.db(state/ 不入 git、不参与部署与同步;UGC 只在服务器生长)。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dir, "..", "state", "artportal.db");
let db = null, loadErr = null;

export async function getDb() {
  if (db) return db;
  if (loadErr) throw loadErr;
  try {
    const { default: Database } = await import("better-sqlite3");
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL, email TEXT NOT NULL,
        payload TEXT NOT NULL,
        mod TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        ip TEXT, created_at TEXT NOT NULL,
        decided_at TEXT, decide_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sub_status ON submissions(status);
      CREATE TABLE IF NOT EXISTS moderation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, ref_id TEXT, action TEXT NOT NULL,
        detail TEXT, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recycle (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL, record_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS search_ingest (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL, record_id TEXT NOT NULL, title TEXT,
        q TEXT, uid TEXT, email TEXT, ip TEXT, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ingest_rec ON search_ingest(record_id);
    `);
    return db;
  } catch (e) {
    loadErr = new Error("SQLite 不可用(better-sqlite3 未安装?): " + (e.message || e));
    throw loadErr;
  }
}

export async function insertSubmission({ uid, email, payload, mod, ip }) {
  const d = await getDb();
  const r = d.prepare("INSERT INTO submissions(uid,email,payload,mod,ip,created_at) VALUES(?,?,?,?,?,?)")
    .run(uid, email, JSON.stringify(payload), JSON.stringify(mod), ip || null, new Date().toISOString());
  return Number(r.lastInsertRowid);
}
export async function listSubmissions(limit = 200) {
  const d = await getDb();
  return d.prepare("SELECT * FROM submissions ORDER BY (status='pending') DESC, id DESC LIMIT ?").all(limit)
    .map(r => ({ ...r, payload: JSON.parse(r.payload), mod: r.mod ? JSON.parse(r.mod) : null }));
}
export async function decideSubmission(id, status, note) {
  const d = await getDb();
  const row = d.prepare("SELECT * FROM submissions WHERE id=?").get(id);
  if (!row) return null;
  d.prepare("UPDATE submissions SET status=?,decided_at=?,decide_note=? WHERE id=?")
    .run(status, new Date().toISOString(), note || null, id);
  return { ...row, payload: JSON.parse(row.payload) };
}
// 审计日志:谁投的、机审结论、人工处置,全程留痕备查(合规要求)
export async function logModeration(kind, refId, action, detail) {
  try {
    const d = await getDb();
    d.prepare("INSERT INTO moderation_log(kind,ref_id,action,detail,at) VALUES(?,?,?,?,?)")
      .run(kind, String(refId), action, detail ? JSON.stringify(detail).slice(0, 2000) : null, new Date().toISOString());
  } catch (e) {}
}
export async function countPending() {
  try { const d = await getDb(); return d.prepare("SELECT COUNT(*) n FROM submissions WHERE status='pending'").get().n; }
  catch (e) { return 0; }
}
// ---------- 回收站(后台删除的展览项目信息,可恢复/可彻底删除) ----------
export async function recycleInsert(channel, record) {
  const d = await getDb();
  d.prepare("INSERT INTO recycle(channel,record_id,payload,deleted_at) VALUES(?,?,?,?)")
    .run(channel, record.id, JSON.stringify(record), new Date().toISOString());
}
export async function recycleList(limit = 300) {
  const d = await getDb();
  return d.prepare("SELECT * FROM recycle ORDER BY id DESC LIMIT ?").all(limit)
    .map(r => ({ ...r, payload: JSON.parse(r.payload) }));
}
export async function recycleTake(id) {
  const d = await getDb();
  const row = d.prepare("SELECT * FROM recycle WHERE id=?").get(id);
  if (!row) return null;
  d.prepare("DELETE FROM recycle WHERE id=?").run(id);
  return { ...row, payload: JSON.parse(row.payload) };
}

// ---------- 检索入库溯源(哪个用户的哪次检索把这条信息带进了库) ----------
export async function ingestInsert({ channel, record_id, title, q, uid, email, ip }) {
  try {
    const d = await getDb();
    d.prepare("INSERT INTO search_ingest(channel,record_id,title,q,uid,email,ip,at) VALUES(?,?,?,?,?,?,?,?)")
      .run(channel, record_id, title || null, q || null, uid || null, email || null, ip || null, new Date().toISOString());
  } catch (e) {}
}
export async function ingestList(limit = 300) {
  const d = await getDb();
  return d.prepare("SELECT * FROM search_ingest ORDER BY id DESC LIMIT ?").all(limit);
}
// record_id -> 最近一次检索者(email 或 访客ip),供内容管理列表标注
export async function ingestMap() {
  try {
    const d = await getDb();
    const rows = d.prepare("SELECT record_id, email, ip FROM search_ingest ORDER BY id ASC").all();
    const m = {};
    for (const r of rows) m[r.record_id] = r.email || ("访客 " + String(r.ip || "").slice(0, 18));
    return m;
  } catch (e) { return {}; }
}

// 单用户 24 小时内最多 5 条(防灌水)
export async function submissionRateOk(uid) {
  const d = await getDb();
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  return d.prepare("SELECT COUNT(*) n FROM submissions WHERE uid=? AND created_at>?").get(uid, since).n < 5;
}
