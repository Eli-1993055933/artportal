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
      CREATE TABLE IF NOT EXISTS follows (
        follower TEXT NOT NULL, followee TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (follower, followee)
      );
      CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee);
      CREATE TABLE IF NOT EXISTS blocks (
        blocker TEXT NOT NULL, blocked TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (blocker, blocked)
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT,
        refkey TEXT,
        ref TEXT,
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notif_uid ON notifications(uid, read);
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, target TEXT NOT NULL,
        uid TEXT NOT NULL, email TEXT,
        parent INTEGER,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        mod TEXT, likes INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, decided_at TEXT, decide_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(kind, target);
      CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
      CREATE TABLE IF NOT EXISTS comment_likes (
        uid TEXT NOT NULL, cid INTEGER NOT NULL,
        PRIMARY KEY (uid, cid)
      );
      CREATE TABLE IF NOT EXISTS work_likes (
        uid TEXT NOT NULL, wid INTEGER NOT NULL,
        PRIMARY KEY (uid, wid)
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT, contact TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        page TEXT, ip_region TEXT,
        ai TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        note TEXT,
        created_at TEXT NOT NULL, decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);
      CREATE TABLE IF NOT EXISTS works (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uid TEXT NOT NULL, email TEXT,
        title TEXT NOT NULL, description TEXT,
        images TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        mod TEXT, reports INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, decided_at TEXT, decide_note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_works_uid ON works(uid);
      CREATE INDEX IF NOT EXISTS idx_works_status ON works(status);
      CREATE TABLE IF NOT EXISTS newsletter_sends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wid TEXT NOT NULL, email TEXT NOT NULL,
        ok INTEGER NOT NULL, err TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nl_wid ON newsletter_sends(wid);
      CREATE TABLE IF NOT EXISTS agent_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        ok INTEGER NOT NULL,
        summary TEXT,
        metrics TEXT,
        took_ms INTEGER,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_log ON agent_log(agent, id);
      CREATE TABLE IF NOT EXISTS zero_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        q TEXT NOT NULL, who TEXT, gl TEXT, hl TEXT,
        probed INTEGER, candidates INTEGER,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_zero_q ON zero_queries(q);
    `);
    // v0.66.0:作品加艺术门类标签(作者自选 ≤3,tags.js 的 23 门类 slug)。
    // 旧库无此列 → ALTER 补上;已有则报"duplicate column"忽略即可。
    try { db.exec("ALTER TABLE works ADD COLUMN tags TEXT"); } catch (e) {}
    // v0.79.0:IP 属地合规展示(发布/评论存创建时属地,JSON {country,province,city,disp})
    try { db.exec("ALTER TABLE works ADD COLUMN ip_region TEXT"); } catch (e) {}
    try { db.exec("ALTER TABLE comments ADD COLUMN ip_region TEXT"); } catch (e) {}
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

// 检索一无所获(P5,补源信号):谁/搜了什么词/在哪个区域/探了多少候选,一条都没收进来。
// 便宜的长期信号——同一词反复零结果,说明这类源现在库里是空白,指导人工补源方向。不影响检索主流程,写失败静默跳过。
export async function logZeroQuery({ q, who, gl, hl, probed, candidates }) {
  try {
    const d = await getDb();
    d.prepare("INSERT INTO zero_queries(q,who,gl,hl,probed,candidates,at) VALUES(?,?,?,?,?,?,?)")
      .run(String(q || "").slice(0, 200), who || null, gl || null, hl || null, probed || 0, candidates || 0, new Date().toISOString());
  } catch (e) {}
}
// 近 N 天零结果检索词,按出现次数排序(补源看板用)
export async function topZeroQueries(days = 30, limit = 20) {
  try {
    const d = await getDb();
    const since = new Date(Date.now() - days * 86400e3).toISOString();
    return d.prepare(
      "SELECT q, COUNT(*) n, MAX(at) last_at FROM zero_queries WHERE at >= ? GROUP BY q ORDER BY n DESC, last_at DESC LIMIT ?"
    ).all(since, limit);
  } catch (e) { return []; }
}

// 某用户已通过审核的投稿(用户主页"投稿"tab;对应机会 id = "submit-" + 投稿id)
export async function userApprovedSubmissions(uid) {
  const d = await getDb();
  return d.prepare("SELECT id, payload, decided_at FROM submissions WHERE uid=? AND status='approved' ORDER BY id DESC LIMIT 100")
    .all(uid)
    .map(r => {
      let title = null; try { title = JSON.parse(r.payload).title || null; } catch (e) {}
      return { oid: "submit-" + r.id, title, decided_at: r.decided_at };
    });
}

// ---------- 拉黑(8.4 二期):拉黑后对方无法关注你/评论你的内容,已有互相关注解除 ----------
export async function blockSet(blocker, blocked, on) {
  const d = await getDb();
  if (on) {
    d.prepare("INSERT OR IGNORE INTO blocks(blocker,blocked,created_at) VALUES(?,?,?)").run(blocker, blocked, new Date().toISOString());
    d.prepare("DELETE FROM follows WHERE (follower=? AND followee=?) OR (follower=? AND followee=?)").run(blocker, blocked, blocked, blocker);
  } else {
    d.prepare("DELETE FROM blocks WHERE blocker=? AND blocked=?").run(blocker, blocked);
  }
}
// blocker 是否拉黑了 blocked
export async function isBlocked(blocker, blocked) {
  const d = await getDb();
  return !!d.prepare("SELECT 1 FROM blocks WHERE blocker=? AND blocked=?").get(blocker, blocked);
}
export async function blockedSetOf(uid) {
  const d = await getDb();
  return new Set(d.prepare("SELECT blocked FROM blocks WHERE blocker=?").all(uid).map(r => r.blocked));
}

// ---------- 站内通知(8.4 一期):被关注/被回复/被点赞/内容审核结果 ----------
// refkey 用于去重(如反复点赞只留最新一条):同 uid+type+actor+refkey 先删旧再插新。
export async function notify({ uid, type, actor, refkey, ref }) {
  if (!uid || uid === actor) return;                  // 不给自己发通知
  const d = await getDb();
  if (refkey) d.prepare("DELETE FROM notifications WHERE uid=? AND type=? AND actor IS ? AND refkey=?").run(uid, type, actor || null, refkey);
  d.prepare("INSERT INTO notifications(uid,type,actor,refkey,ref,created_at) VALUES(?,?,?,?,?,?)")
    .run(uid, type, actor || null, refkey || null, ref ? JSON.stringify(ref) : null, new Date().toISOString());
  // 每人最多留 300 条,老的裁掉
  d.prepare("DELETE FROM notifications WHERE uid=? AND id NOT IN (SELECT id FROM notifications WHERE uid=? ORDER BY id DESC LIMIT 300)").run(uid, uid);
}
// 广播通知(如新周刊出刊):给一批 uid 各发一条系统通知(actor 空),同 refkey 去重,事务批量。
export async function notifyBroadcast(uids, { type, refkey, ref }) {
  const d = await getDb();
  if (!d || !uids || !uids.length) return 0;
  const refStr = ref ? JSON.stringify(ref) : null;
  const now = new Date().toISOString();
  const del = d.prepare("DELETE FROM notifications WHERE uid=? AND type=? AND actor IS NULL AND refkey=?");
  const ins = d.prepare("INSERT INTO notifications(uid,type,actor,refkey,ref,created_at) VALUES(?,?,NULL,?,?,?)");
  const trim = d.prepare("DELETE FROM notifications WHERE uid=? AND id NOT IN (SELECT id FROM notifications WHERE uid=? ORDER BY id DESC LIMIT 300)");
  const tx = d.transaction((list) => {
    for (const uid of list) {
      if (refkey) del.run(uid, type, refkey);
      ins.run(uid, type, refkey || null, refStr, now);
      trim.run(uid, uid);
    }
  });
  tx(uids);
  return uids.length;
}
export async function notifList(uid, limit = 50) {
  const d = await getDb();
  return d.prepare("SELECT * FROM notifications WHERE uid=? ORDER BY id DESC LIMIT ?").all(uid, limit)
    .map(r => ({ ...r, ref: r.ref ? JSON.parse(r.ref) : null }));
}
export async function notifUnread(uid) {
  const d = await getDb();
  return d.prepare("SELECT COUNT(*) n FROM notifications WHERE uid=? AND read=0").get(uid).n;
}
export async function notifMarkAllRead(uid) {
  const d = await getDb();
  d.prepare("UPDATE notifications SET read=1 WHERE uid=? AND read=0").run(uid);
}

// ---------- 评论(路线图第 2 项):四类内容通用(opportunity/news/job/work),扁平+一层回复 ----------
const parseJsonCol = s => { if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } };
const parseCmt = r => ({ ...r, mod: r.mod ? JSON.parse(r.mod) : null, ip_region: parseJsonCol(r.ip_region) });
export async function insertComment({ kind, target, uid, email, parent, content, mod, status, ip_region }) {
  const d = await getDb();
  const r = d.prepare("INSERT INTO comments(kind,target,uid,email,parent,content,mod,status,ip_region,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(kind, target, uid, email || null, parent || null, content, mod ? JSON.stringify(mod) : null, status,
      ip_region ? JSON.stringify(ip_region) : null, new Date().toISOString());
  return Number(r.lastInsertRowid);
}
// 某条内容下的评论:公开的(approved)+ 查看者自己的待审(让作者看到"审核中")
export async function commentsFor(kind, target, viewer) {
  const d = await getDb();
  const rows = viewer
    ? d.prepare("SELECT * FROM comments WHERE kind=? AND target=? AND (status='approved' OR (status='pending' AND uid=?)) ORDER BY id ASC LIMIT 500").all(kind, target, viewer)
    : d.prepare("SELECT * FROM comments WHERE kind=? AND target=? AND status='approved' ORDER BY id ASC LIMIT 500").all(kind, target);
  return rows.map(parseCmt);
}
export async function getComment(id) {
  const d = await getDb();
  const r = d.prepare("SELECT * FROM comments WHERE id=?").get(id);
  return r ? parseCmt(r) : null;
}
// 点赞开关:comment_likes 保证一人一赞;返回最新状态与计数
export async function commentLikeToggle(uid, cid) {
  const d = await getDb();
  const had = d.prepare("SELECT 1 FROM comment_likes WHERE uid=? AND cid=?").get(uid, cid);
  if (had) {
    d.prepare("DELETE FROM comment_likes WHERE uid=? AND cid=?").run(uid, cid);
    d.prepare("UPDATE comments SET likes=MAX(0,likes-1) WHERE id=?").run(cid);
  } else {
    d.prepare("INSERT INTO comment_likes(uid,cid) VALUES(?,?)").run(uid, cid);
    d.prepare("UPDATE comments SET likes=likes+1 WHERE id=?").run(cid);
  }
  return { liked: !had, likes: d.prepare("SELECT likes FROM comments WHERE id=?").get(cid).likes };
}
// 作品点赞(v0.82.1,IG/小红书式查看器):work_likes 一人一赞,计数即时 COUNT(免加列迁移)
export async function workLikeToggle(uid, wid) {
  const d = await getDb();
  const had = d.prepare("SELECT 1 FROM work_likes WHERE uid=? AND wid=?").get(uid, wid);
  if (had) d.prepare("DELETE FROM work_likes WHERE uid=? AND wid=?").run(uid, wid);
  else d.prepare("INSERT INTO work_likes(uid,wid) VALUES(?,?)").run(uid, wid);
  const likes = d.prepare("SELECT COUNT(*) c FROM work_likes WHERE wid=?").get(wid).c;
  return { liked: !had, likes };
}
// 批量取一组作品的点赞数 + 观察者是否已赞(feed / 个人主页列表用)
export async function workLikesFor(wids, uid) {
  const d = await getDb();
  const counts = {}, liked = new Set();
  if (!wids.length) return { counts, liked };
  const ph = wids.map(() => "?").join(",");
  for (const r of d.prepare(`SELECT wid, COUNT(*) c FROM work_likes WHERE wid IN (${ph}) GROUP BY wid`).all(...wids)) counts[r.wid] = r.c;
  if (uid) for (const r of d.prepare(`SELECT wid FROM work_likes WHERE uid=? AND wid IN (${ph})`).all(uid, ...wids)) liked.add(r.wid);
  return { counts, liked };
}

// ---------- 反馈信箱(v0.83.0):用户反馈/求助 + 被举报内容聚合 ----------
const parseFb = r => r ? ({ ...r, ip_region: parseJsonCol(r.ip_region), ai: r.ai ? JSON.parse(r.ai) : null }) : null;
export async function insertFeedback({ uid, contact, type, content, page, ip_region }) {
  const d = await getDb();
  const r = d.prepare("INSERT INTO feedback(uid,contact,type,content,page,ip_region,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(uid || null, contact || null, type, content, page || null,
      ip_region ? JSON.stringify(ip_region) : null, new Date().toISOString());
  return Number(r.lastInsertRowid);
}
export async function feedbackList(limit = 300) {
  const d = await getDb();
  return d.prepare("SELECT * FROM feedback ORDER BY (status='new') DESC, id DESC LIMIT ?").all(limit).map(parseFb);
}
export async function decideFeedback(id, status, note) {
  const d = await getDb();
  d.prepare("UPDATE feedback SET status=?, note=?, decided_at=? WHERE id=?")
    .run(status, note || null, new Date().toISOString(), id);
}
export async function feedbackPendingAI(limit = 30) {
  const d = await getDb();
  return d.prepare("SELECT * FROM feedback WHERE ai IS NULL ORDER BY id ASC LIMIT ?").all(limit).map(parseFb);
}
export async function setFeedbackAI(id, ai) {
  const d = await getDb();
  d.prepare("UPDATE feedback SET ai=? WHERE id=?").run(JSON.stringify(ai), id);
}
export async function feedbackNewCount() {
  const d = await getDb();
  return d.prepare("SELECT COUNT(*) n FROM feedback WHERE status='new'").get().n;
}
// 被举报且仍公开的内容(评论/作品),按举报数倒序,交「信箱」聚合与人工裁决
export async function reportedContent() {
  const d = await getDb();
  const comments = d.prepare("SELECT * FROM comments WHERE reports>0 AND status='approved' ORDER BY reports DESC, id DESC LIMIT 50").all().map(parseCmt);
  const works = d.prepare("SELECT * FROM works WHERE reports>0 AND status='approved' ORDER BY reports DESC, id DESC LIMIT 50").all().map(parseWork);
  return { comments, works };
}
// 「保留」裁决:内容没问题,举报计数清零(免得永远挂在被举报列表里)
export async function clearReports(kind, id) {
  const d = await getDb();
  d.prepare(kind === "work" ? "UPDATE works SET reports=0 WHERE id=?" : "UPDATE comments SET reports=0 WHERE id=?").run(id);
}
export async function likedSet(uid, kind, target) {
  const d = await getDb();
  return new Set(d.prepare("SELECT cid FROM comment_likes WHERE uid=? AND cid IN (SELECT id FROM comments WHERE kind=? AND target=?)")
    .all(uid, kind, target).map(r => r.cid));
}
export async function deleteComment(id) {
  const d = await getDb();
  const r = d.prepare("SELECT * FROM comments WHERE id=?").get(id);
  if (!r) return null;
  // 删主评论连带删其回复(界面上回复挂在主评论下,主评论没了回复无处安放)
  d.prepare("DELETE FROM comments WHERE id=? OR parent=?").run(id, id);
  d.prepare("DELETE FROM comment_likes WHERE cid=?").run(id);
  return parseCmt(r);
}
export async function commentReport(id) {
  const d = await getDb();
  d.prepare("UPDATE comments SET reports=reports+1 WHERE id=?").run(id);
}
export async function commentsAdminList(limit = 300) {
  const d = await getDb();
  return d.prepare("SELECT * FROM comments ORDER BY (status='pending') DESC, id DESC LIMIT ?").all(limit).map(parseCmt);
}
export async function decideComment(id, status, note) {
  const d = await getDb();
  const row = d.prepare("SELECT * FROM comments WHERE id=?").get(id);
  if (!row) return null;
  d.prepare("UPDATE comments SET status=?,decided_at=?,decide_note=? WHERE id=?")
    .run(status, new Date().toISOString(), note || null, id);
  return parseCmt(row);
}
export async function countPendingComments() {
  try { const d = await getDb(); return d.prepare("SELECT COUNT(*) n FROM comments WHERE status='pending'").get().n; }
  catch (e) { return 0; }
}
export async function commentRateOk(uid, max = 30) {   // 单用户 24 小时 30 条
  const d = await getDb();
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  return d.prepare("SELECT COUNT(*) n FROM comments WHERE uid=? AND created_at>?").get(uid, since).n < max;
}

// ---------- 关注关系(路线图 8.2) ----------
export async function followSet(follower, followee, on) {
  const d = await getDb();
  if (on) d.prepare("INSERT OR IGNORE INTO follows(follower,followee,created_at) VALUES(?,?,?)")
    .run(follower, followee, new Date().toISOString());
  else d.prepare("DELETE FROM follows WHERE follower=? AND followee=?").run(follower, followee);
}
// 某用户的 粉丝数/关注数 + 当前查看者是否已关注 TA
export async function followInfo(uid, viewer) {
  const d = await getDb();
  return {
    followers: d.prepare("SELECT COUNT(*) n FROM follows WHERE followee=?").get(uid).n,
    following: d.prepare("SELECT COUNT(*) n FROM follows WHERE follower=?").get(uid).n,
    is_following: viewer ? !!d.prepare("SELECT 1 FROM follows WHERE follower=? AND followee=?").get(viewer, uid) : false
  };
}
export async function followList(uid, kind, limit = 200) {
  const d = await getDb();
  return kind === "followers"
    ? d.prepare("SELECT follower AS uid FROM follows WHERE followee=? ORDER BY created_at DESC LIMIT ?").all(uid, limit)
    : d.prepare("SELECT followee AS uid FROM follows WHERE follower=? ORDER BY created_at DESC LIMIT ?").all(uid, limit);
}
// 防滥用:单用户 24 小时内新增关注上限(现存关注的 created_at 即计数依据)
export async function followRateOk(uid, max = 100) {
  const d = await getDb();
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  return d.prepare("SELECT COUNT(*) n FROM follows WHERE follower=? AND created_at>?").get(uid, since).n < max;
}

// ---------- 作品集(路线图 8.3):图片人工审核通过才公开 ----------
const parseWork = r => ({ ...r, images: JSON.parse(r.images || "[]"), tags: JSON.parse(r.tags || "[]"),
  mod: r.mod ? JSON.parse(r.mod) : null, ip_region: parseJsonCol(r.ip_region) });
export async function insertWork({ uid, email, title, description, tags, mod, ip_region }) {
  const d = await getDb();
  const r = d.prepare("INSERT INTO works(uid,email,title,description,tags,mod,ip_region,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(uid, email || null, title, description || null, JSON.stringify(tags || []), mod ? JSON.stringify(mod) : null,
      ip_region ? JSON.stringify(ip_region) : null, new Date().toISOString());
  return Number(r.lastInsertRowid);
}
export async function setWorkImages(id, paths) {
  const d = await getDb();
  d.prepare("UPDATE works SET images=? WHERE id=?").run(JSON.stringify(paths), id);
}
export async function getWork(id) {
  const d = await getDb();
  const r = d.prepare("SELECT * FROM works WHERE id=?").get(id);
  return r ? parseWork(r) : null;
}
// 某用户的作品:公开视角只出 approved;本人视角全出(前端标"审核中/未通过")
export async function worksByUser(uid, includeAll) {
  const d = await getDb();
  const rows = includeAll
    ? d.prepare("SELECT * FROM works WHERE uid=? ORDER BY id DESC LIMIT 200").all(uid)
    : d.prepare("SELECT * FROM works WHERE uid=? AND status='approved' ORDER BY id DESC LIMIT 200").all(uid);
  return rows.map(parseWork);
}
// 按 id 批量取已过审作品(收藏解析用:把 work:<id> 收藏还原成可渲染对象)
export async function worksByIds(ids) {
  const list = (ids || []).map(Number).filter(n => Number.isFinite(n));
  if (!list.length) return [];
  const d = await getDb();
  if (!d) return [];
  const qs = list.map(() => "?").join(",");
  return d.prepare("SELECT * FROM works WHERE status='approved' AND id IN (" + qs + ")").all(...list).map(parseWork);
}
// 作品广场:全站已过审作品,最新在前(第四频道)
export async function worksFeed(limit = 200) {
  const d = await getDb();
  return d.prepare("SELECT * FROM works WHERE status='approved' ORDER BY id DESC LIMIT ?").all(limit).map(parseWork);
}
// 关注动态:只看我关注的人的已过审作品(作品频道"关注"过滤)
export async function worksFeedFollowing(uid, limit = 200) {
  const d = await getDb();
  return d.prepare("SELECT w.* FROM works w JOIN follows f ON f.followee=w.uid WHERE f.follower=? AND w.status='approved' ORDER BY w.id DESC LIMIT ?")
    .all(uid, limit).map(parseWork);
}
export async function worksCountApproved(uid) {
  const d = await getDb();
  return d.prepare("SELECT COUNT(*) n FROM works WHERE uid=? AND status='approved'").get(uid).n;
}
export async function worksAdminList(limit = 300) {
  const d = await getDb();
  return d.prepare("SELECT * FROM works ORDER BY (status='pending') DESC, id DESC LIMIT ?").all(limit).map(parseWork);
}
export async function decideWork(id, status, note) {
  const d = await getDb();
  const row = d.prepare("SELECT * FROM works WHERE id=?").get(id);
  if (!row) return null;
  d.prepare("UPDATE works SET status=?,decided_at=?,decide_note=? WHERE id=?")
    .run(status, new Date().toISOString(), note || null, id);
  return parseWork(row);
}
// 恢复期已过的下架/拒绝作品(v0.100.0):它们的图片还占着非公开目录,交由清理任务删。
// 只挑 decided_at 明确早于截止时间的,decided_at 为空的老数据不动(宁可留着也别误删)。
export async function worksRejectedBefore(isoCutoff) {
  const d = await getDb();
  return d.prepare("SELECT * FROM works WHERE status='rejected' AND decided_at IS NOT NULL AND decided_at < ?")
    .all(isoCutoff).map(parseWork);
}
export async function deleteWork(id) {
  const d = await getDb();
  const row = d.prepare("SELECT * FROM works WHERE id=?").get(id);
  if (!row) return null;
  d.prepare("DELETE FROM works WHERE id=?").run(id);
  return parseWork(row);
}
export async function workReport(id) {
  const d = await getDb();
  d.prepare("UPDATE works SET reports=reports+1 WHERE id=?").run(id);
}
export async function workRateOk(uid, max = 10) {   // 单用户 24 小时最多 10 组作品
  const d = await getDb();
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  return d.prepare("SELECT COUNT(*) n FROM works WHERE uid=? AND created_at>?").get(uid, since).n < max;
}
export async function countPendingWorks() {
  try { const d = await getDb(); return d.prepare("SELECT COUNT(*) n FROM works WHERE status='pending'").get().n; }
  catch (e) { return 0; }
}

// ---------- 周报发送记录(第 5 项):群发留痕 + 断点续发(同期已成功的不重发) ----------
export async function nlLogSend(wid, email, ok, err) {
  try {
    const d = await getDb();
    d.prepare("INSERT INTO newsletter_sends(wid,email,ok,err,at) VALUES(?,?,?,?,?)")
      .run(wid, email, ok ? 1 : 0, err ? String(err).slice(0, 200) : null, new Date().toISOString());
  } catch (e) {}
}
// 某期已发送成功的邮箱集合(重跑群发时跳过,防重复打扰)
export async function nlSentSet(wid) {
  try {
    const d = await getDb();
    return new Set(d.prepare("SELECT DISTINCT email FROM newsletter_sends WHERE wid=? AND ok=1").all(wid).map(r => r.email));
  } catch (e) { return new Set(); }
}
export async function nlRecent(limit = 100) {
  const d = await getDb();
  return d.prepare("SELECT * FROM newsletter_sends ORDER BY id DESC LIMIT ?").all(limit);
}
export async function nlStats(wid) {
  try {
    const d = await getDb();
    const r = d.prepare("SELECT SUM(ok) ok, COUNT(*) total FROM newsletter_sends WHERE wid=?").get(wid);
    return { ok: r.ok || 0, total: r.total || 0 };
  } catch (e) { return { ok: 0, total: 0 }; }
}

// ---------- Agent 打卡簿(v0.72.0 巡视台):每个 agent 干完活上报一条,后台按岗巡视 ----------
export async function agentLog({ agent, ok, summary, metrics, took_ms }) {
  try {
    const d = await getDb();
    d.prepare("INSERT INTO agent_log(agent,ok,summary,metrics,took_ms,at) VALUES(?,?,?,?,?,?)")
      .run(String(agent).slice(0, 40), ok ? 1 : 0, summary ? String(summary).slice(0, 400) : null,
           metrics ? JSON.stringify(metrics).slice(0, 1000) : null, Number(took_ms) || null, new Date().toISOString());
    // 每个 agent 留最近 200 条,老的裁掉
    d.prepare("DELETE FROM agent_log WHERE agent=? AND id NOT IN (SELECT id FROM agent_log WHERE agent=? ORDER BY id DESC LIMIT 200)")
      .run(agent, agent);
  } catch (e) {}
}
// 各 agent 的最近一次打卡(巡视台卡片用)
export async function agentLastAll() {
  const d = await getDb();
  return d.prepare("SELECT a.* FROM agent_log a JOIN (SELECT agent, MAX(id) mid FROM agent_log GROUP BY agent) m ON a.id=m.mid")
    .all().map(r => ({ ...r, metrics: r.metrics ? JSON.parse(r.metrics) : null }));
}
export async function agentRecent(agent, limit = 20) {
  const d = await getDb();
  return d.prepare("SELECT * FROM agent_log WHERE agent=? ORDER BY id DESC LIMIT ?").all(agent, limit)
    .map(r => ({ ...r, metrics: r.metrics ? JSON.parse(r.metrics) : null }));
}
// 今日审核工作量(北京日,一线审核员卡片用):moderation_log 按动作聚合
export async function moderationToday() {
  try {
    const d = await getDb();
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const rows = d.prepare("SELECT action, COUNT(*) n FROM moderation_log WHERE at>? GROUP BY action").all(since);
    const sum = { auto: 0, pending: 0, decided: 0, reported: 0, total: 0 };
    for (const r of rows) {
      sum.total += r.n;
      if (r.action.startsWith("auto-approved")) sum.auto += r.n;
      else if (r.action.startsWith("created:review") || r.action.startsWith("created:reject")) sum.pending += r.n;
      else if (r.action.startsWith("decided:")) sum.decided += r.n;
      else if (r.action === "reported") sum.reported += r.n;
    }
    return sum;
  } catch (e) { return null; }
}

// 单用户 24 小时内最多 5 条(防灌水)
export async function submissionRateOk(uid) {
  const d = await getDb();
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  return d.prepare("SELECT COUNT(*) n FROM submissions WHERE uid=? AND created_at>?").get(uid, since).n < 5;
}
