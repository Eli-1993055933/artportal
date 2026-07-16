// auth.mjs —— 账号 / 会话 / 事件统计 / 在线追踪(供 server.mjs 挂载)。
//
// 设计原则(与全站一致:零第三方依赖、文件存储、写串行 + 原子替换):
// - 用户数据存 pipeline/state/(绝不放 site/,那是公开静态目录)。
// - 只收最少信息:邮箱 + 密码哈希(scrypt+盐),昵称等资料留待社区功能上线再渐进补全。
// - 会话:HttpOnly Cookie,180 天;重启不掉线(sessions.json 持久化)。
// - 事件:events.jsonl 追加(visit/outbound/search/register/login),心跳只进内存不落盘。

import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { wordHits, moderateText } from "./moderation.mjs";
import { logModeration } from "./db.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dir, "..", "state");
const AVATARS = join(__dir, "..", "..", "site", "assets", "avatars");
const USERS_FILE = join(STATE, "users.json");
const SESS_FILE = join(STATE, "sessions.json");
const EVENTS_FILE = join(STATE, "events.jsonl");

const SESS_TTL = 180 * 24 * 3600 * 1000;      // 会话 180 天
const ONLINE_WINDOW = 5 * 60 * 1000;          // 最近 5 分钟有心跳 = 在线
const ADMIN_TTL = 12 * 3600 * 1000;           // 管理会话 12 小时
const SECURE = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";   // 上 HTTPS 后设 COOKIE_SECURE=1
// 北京时区的"今天"(YYYY-MM-DD)。事件时间戳存 UTC ISO,统计口径要按本地日,否则凌晨 8 点前算错天。
const CN_OFFSET = 8 * 3600 * 1000;
function beijingDay(iso) { return new Date((iso ? Date.parse(iso) : Date.now()) + CN_OFFSET).toISOString().slice(0, 10); }

// ---------- 存储 ----------
let users = [];                                // {id,email,salt,hash,nickname,created_at,last_seen,favorites,profile}
let byEmail = new Map();
let sessions = new Map();                      // token -> {uid, created_at, last_seen}
const online = new Map();                      // key -> {kind:'user'|'anon', label, last}
const adminTokens = new Map();                 // token -> expiry

export async function initAuth() {
  await mkdir(STATE, { recursive: true });
  try {
    const d = JSON.parse(await readFile(USERS_FILE, "utf8"));
    users = Array.isArray(d.users) ? d.users : [];
  } catch (e) { users = []; }
  byEmail = new Map(users.map(u => [u.email, u]));
  rebuildNickIndex();
  try {
    const d = JSON.parse(await readFile(SESS_FILE, "utf8"));
    const now = Date.now();
    sessions = new Map(Object.entries(d.sessions || {}).filter(([, s]) => now - s.created_at < SESS_TTL));
  } catch (e) { sessions = new Map(); }
  process.stderr.write(`[auth] 已加载 ${users.length} 个用户,${sessions.size} 个会话\n`);
}

// 写串行 + 临时文件 rename 原子替换(和 opportunities.json 同一套纪律)
let saveChain = Promise.resolve();
function queueSave(file, dataFn) {
  saveChain = saveChain.then(async () => {
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify(dataFn(), null, 2), "utf8");
    await rename(tmp, file);
  }).catch(e => process.stderr.write("[auth] 保存失败 " + file + ": " + e.message + "\n"));
  return saveChain;
}
const saveUsers = () => queueSave(USERS_FILE, () => ({ users }));
const saveSessions = () => queueSave(SESS_FILE, () => ({ sessions: Object.fromEntries(sessions) }));

// ---------- 事件日志(低频事件才落盘;心跳只进内存) ----------
// 粗略累计写入字节;超过上限就轮转(events.jsonl → events.jsonl.1,只保留一代),防磁盘被刷爆。
let evtBytes = 0;
const EVT_ROTATE_AT = 20 * 1024 * 1024;   // 20MB
export function logEvent(type, extra) {
  const line = JSON.stringify({ t: new Date().toISOString(), type, ...extra }) + "\n";
  evtBytes += line.length;
  if (evtBytes > EVT_ROTATE_AT) {
    evtBytes = 0;
    rename(EVENTS_FILE, EVENTS_FILE + ".1").then(() => appendFile(EVENTS_FILE, line, "utf8")).catch(() => {});
    return;
  }
  appendFile(EVENTS_FILE, line, "utf8").catch(() => {});
}
const MAX_USERS = 100000;                  // 批量注册安全阀(早期远够;到量再迁库)
const MAX_ONLINE = 5000;                   // 在线表条目上限,防伪造 anon 灌爆内存

// ---------- 密码 ----------
function hashPassword(pw, salt) { return scryptSync(String(pw), salt, 64).toString("hex"); }
function checkPassword(pw, u) {
  try {
    const h = Buffer.from(hashPassword(pw, u.salt), "hex");
    return timingSafeEqual(h, Buffer.from(u.hash, "hex"));
  } catch (e) { return false; }
}
// 邮箱不存在时也跑一次等价 scrypt,抹平"已注册/未注册"的响应时间差(防计时枚举)
const DUMMY_SALT = randomBytes(16).toString("hex");
function burnPassword(pw) { try { scryptSync(String(pw), DUMMY_SALT, 64); } catch (e) {} }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- 会话 ----------
function newSession(uid) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { uid, created_at: Date.now(), last_seen: Date.now() });
  saveSessions();
  return token;
}
export function userOf(req) {
  const token = cookieOf(req, "ap_sess");
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || Date.now() - s.created_at > SESS_TTL) { if (s) { sessions.delete(token); saveSessions(); } return null; }
  const u = users.find(x => x.id === s.uid);
  return u || null;
}
function cookieOf(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
// 站点目前跑在 HTTP(IP 直访);上 HTTPS 后在这里补 "; Secure"
function sessionCookie(token) { return `ap_sess=${token}; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=${SESS_TTL / 1000}`; }
const CLEAR_COOKIE = "ap_sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

// ---------- 认证接口限频(比检索更严:防爆破/批量注册) ----------
const authHits = new Map();                    // ip -> [ts...]
function authLimited(ip, max = 10, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const arr = (authHits.get(ip) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { authHits.set(ip, arr); return true; }
  arr.push(now); authHits.set(ip, arr);
  return false;
}

// ---------- 公开 API 处理器(返回 {code, body, headers?}) ----------
function publicUser(u) {
  const p = u.profile || {};
  return {
    id: u.id,                                  // 自己的 uid(用于打开"我的主页" #/u/<id>;uid 本就出现在主页链接里,非敏感)
    email: u.email, nickname: u.nickname || null, avatar: u.avatar || null,
    favorites: u.favorites || [], created_at: u.created_at,
    bio: p.bio || "", identity: p.identity || "", location: p.location || "",
    website: p.website || "", fields: p.fields || "",
    fav_public: p.fav_public !== false,        // 收藏默认公开,可在编辑资料里关闭
    nickname_changed_at: u.nickname_changed_at || null,
    needs_profile: !(u.nickname && u.avatar)   // 昵称+头像必填;缺任一,前端强制补全
  };
}

// 用户公开主页(8.1):任何人可看。只出公开字段——绝不含邮箱/收藏之外的任何隐私(红线)。
export function publicProfile(uid, ip) {
  if (authLimited("pub:" + ip, 60, 60 * 1000)) return { code: 429, body: { error: "请求太频繁,请稍后再试" } };
  const u = users.find(x => x.id === uid);
  if (!u || !u.nickname) return { code: 404, body: { error: "用户不存在" } };   // 资料未完成的暂不展示
  const p = u.profile || {};
  const pub = p.fav_public !== false;
  return { code: 200, body: { user: {
    id: u.id, nickname: u.nickname, avatar: u.avatar || null,
    bio: p.bio || "", identity: p.identity || "", location: p.location || "",
    website: p.website || "", fields: p.fields || "",
    joined: String(u.created_at || "").slice(0, 10),
    fav_public: pub, fav_count: (u.favorites || []).length,
    favorites: pub ? (u.favorites || []) : []
  } } };
}

// ---------- 用户资料:昵称(全站唯一) + 头像(必填) ----------
// 昵称规范(学习成熟社区经验):2–20 字符,中英文/数字/_-·;
// 唯一性按"小写+去空白"归一比对(防 "张 三"/"张三" 混淆);保留词与敏感词拒绝。
const NICK_RE = /^[一-鿿A-Za-z0-9_\-·]{2,20}$/;
const NICK_RESERVED = /(官方|管理员|管理|客服|站长|admin|artportal|official|moderator|system)/i;
function nickKey(n) { return String(n).toLowerCase().replace(/\s+/g, ""); }
let byNick = new Map();   // nickKey -> uid(initAuth 时建,更新时维护)
function rebuildNickIndex() {
  byNick = new Map(users.filter(u => u.nickname).map(u => [nickKey(u.nickname), u.id]));
}
const NICK_COOLDOWN = 7 * 24 * 3600 * 1000;   // 改名冷静期 7 天(防冒充/骚扰式换名;首次设置不算)
export async function setProfile(req, body, ip) {
  const u = userOf(req);
  if (!u) return { code: 401, body: { error: "未登录" } };
  if (authLimited("profile:" + u.id, 12, 10 * 60 * 1000)) return { code: 429, body: { error: "操作太频繁,请稍后再试" } };
  const nickname = String((body || {}).nickname || "").trim().replace(/\s+/g, " ");
  if (!NICK_RE.test(nickname.replace(/ /g, ""))) return { code: 400, body: { error: "昵称需 2–20 字,可用中英文、数字、_-·" } };
  if (NICK_RESERVED.test(nickname)) return { code: 400, body: { error: "该昵称包含保留词,请换一个" } };
  const changingNick = !!(u.nickname && nickname !== u.nickname);
  if (changingNick) {
    const wait = NICK_COOLDOWN - (Date.now() - (Date.parse(u.nickname_changed_at || 0) || 0));
    if (wait > 0) return { code: 429, body: { error: "昵称每 7 天可修改一次,还需等 " + Math.ceil(wait / 86400000) + " 天" } };
  }
  const hits = await wordHits(nickname);
  if (hits.hard.length || hits.soft.length) return { code: 400, body: { error: "昵称包含不允许的词,请换一个" } };
  const key = nickKey(nickname);
  const holder = byNick.get(key);
  if (holder && holder !== u.id) {
    const suggest = nickname + String(100 + Math.floor(Math.random() * 900));
    return { code: 409, body: { error: "该昵称已被使用,试试「" + suggest + "」", suggest } };
  }
  // —— 扩展资料(8.1 用户主页,均选填):简介/身份/创作领域/所在地/个人网站/收藏公开 ——
  const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const b = body || {};
  const bio = str(b.bio, 300), location = str(b.location, 40), fields = str(b.fields, 60);
  const website = str(b.website, 200);
  if (website) {
    if (!/^https?:\/\/.{4,}$/i.test(website)) return { code: 400, body: { error: "个人网站需以 http(s):// 开头" } };
    try { new URL(website); } catch (e) { return { code: 400, body: { error: "个人网站链接格式不正确" } }; }
  }
  const identity = ["artist", "curator", "student", "org", "fan"].includes(b.identity) ? b.identity : "";
  // 简介等自由文本是 UGC:变更时过敏感词 + AI 机审(明显违规拒;可疑放行但留审计日志,后台可查)
  const p = u.profile || (u.profile = {});
  const freeText = [bio, fields, location].filter(Boolean).join("\n");
  if (freeText && freeText !== [p.bio, p.fields, p.location].filter(Boolean).join("\n")) {
    const mod = await moderateText(freeText);
    if (mod.verdict === "reject") return { code: 400, body: { error: "资料内容包含不允许的词句,请修改后再试" } };
    if (mod.verdict === "review") logModeration("profile", u.id, "review", { bio, fields, location, hits: mod.hits, ai: mod.ai }).catch(() => {});
  }
  // 头像:必须有(新传的 base64,或此前已设置过)
  const avatar = typeof (body || {}).avatar === "string" ? body.avatar : "";
  if (!avatar && !u.avatar) return { code: 400, body: { error: "请设置头像(上传图片或使用默认头像)" } };
  if (avatar) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar) || avatar.length > 300000) {
      return { code: 400, body: { error: "头像图片无效或过大" } };
    }
    let buf;
    try { buf = Buffer.from(avatar.slice(23), "base64"); } catch (e) { return { code: 400, body: { error: "头像图片无效" } }; }
    if (buf.length < 100 || buf.length > 220000) return { code: 400, body: { error: "头像图片无效或过大" } };
    await mkdir(AVATARS, { recursive: true });
    await writeFile(join(AVATARS, u.id + ".jpg"), buf);
    u.avatar = "assets/avatars/" + u.id + ".jpg";
  }
  if (u.nickname) byNick.delete(nickKey(u.nickname));
  if (changingNick) u.nickname_changed_at = new Date().toISOString();
  u.nickname = nickname;
  byNick.set(key, u.id);
  p.bio = bio; p.identity = identity; p.fields = fields; p.location = location; p.website = website;
  if (typeof b.fav_public === "boolean") p.fav_public = b.fav_public;
  saveUsers();
  logEvent("profile", { uid: u.id, email: u.email, ip, nickname });
  return { code: 200, body: { user: publicUser(u) } };
}

export function register(email, password, ip) {
  if (authLimited(ip)) return { code: 429, body: { error: "尝试太频繁,请稍后再试" } };
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");
  if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
  if (password.length < 6 || password.length > 72) return { code: 400, body: { error: "密码需 6–72 位" } };
  if (byEmail.has(email)) return { code: 409, body: { error: "该邮箱已注册,请直接登录" } };
  if (users.length >= MAX_USERS) return { code: 503, body: { error: "注册暂时关闭,请稍后再试" } };
  const salt = randomBytes(16).toString("hex");
  const u = {
    id: "u" + randomBytes(6).toString("hex"),
    email, salt, hash: hashPassword(password, salt),
    nickname: null, profile: {}, favorites: [],
    created_at: new Date().toISOString(), last_seen: new Date().toISOString()
  };
  users.push(u); byEmail.set(email, u); saveUsers();
  logEvent("register", { uid: u.id, email, ip });
  const token = newSession(u.id);
  return { code: 200, body: { user: publicUser(u) }, headers: { "Set-Cookie": sessionCookie(token) } };
}

export function login(email, password, ip) {
  if (authLimited(ip)) return { code: 429, body: { error: "尝试太频繁,请稍后再试" } };
  email = String(email || "").trim().toLowerCase();
  const u = byEmail.get(email);
  // 统一报错文案 + 恒定耗时(邮箱不存在也跑一次假哈希),不泄露"邮箱是否注册过"
  if (!u) { burnPassword(password); return { code: 401, body: { error: "邮箱或密码不正确" } }; }
  if (!checkPassword(password, u)) return { code: 401, body: { error: "邮箱或密码不正确" } };
  u.last_seen = new Date().toISOString(); saveUsers();
  logEvent("login", { uid: u.id, email, ip });
  const token = newSession(u.id);
  return { code: 200, body: { user: publicUser(u) }, headers: { "Set-Cookie": sessionCookie(token) } };
}

export function logout(req) {
  const token = cookieOf(req, "ap_sess");
  if (token) { sessions.delete(token); saveSessions(); }
  return { code: 200, body: { ok: true }, headers: { "Set-Cookie": CLEAR_COOKIE } };
}

export function me(req) {
  const u = userOf(req);
  let headers = null;
  if (u) {
    markOnline("user:" + u.id, "user", u.email);
    // last_seen 落盘限流:5 分钟一次,避免每次心跳都写文件
    if (Date.now() - Date.parse(u.last_seen || 0) > 5 * 60 * 1000) { u.last_seen = new Date().toISOString(); saveUsers(); }
    // 会话滑动续期:原来 180 天从"首次登录"起算且 cookie 不刷新,活跃老用户会莫名掉线
    // → 被注册墙拦(bug 报告:已登录还被要求注册)。现在每天首次访问就把会话与 cookie
    // 一起顺延 180 天,常来的用户永不过期;半年不来的才需要重新登录。
    const token = cookieOf(req, "ap_sess");
    const s = token ? sessions.get(token) : null;
    if (s && Date.now() - s.created_at > 24 * 3600 * 1000) {
      s.created_at = Date.now();
      saveSessions();
      headers = { "Set-Cookie": sessionCookie(token) };
    }
  }
  return { code: 200, body: { user: u ? publicUser(u) : null }, ...(headers ? { headers } : {}) };
}

export function setFavorites(req, ids) {
  const u = userOf(req);
  if (!u) return { code: 401, body: { error: "未登录" } };
  if (!Array.isArray(ids) || ids.length > 2000) return { code: 400, body: { error: "格式不正确" } };
  const clean = ids.filter(x => typeof x === "string" && x.length < 200);
  u.favorites = Array.from(new Set(clean)).slice(0, 2000);   // 去重,防重复 id 撑坏"长度比较"式同步
  saveUsers();
  return { code: 200, body: { ok: true, count: u.favorites.length } };
}

// ---------- 在线追踪 ----------
function markOnline(key, kind, label) {
  // 已存在的直接刷新;新增前若超容量则先清过期,仍超则丢弃(防伪造 anon 灌爆内存)
  if (!online.has(key) && online.size >= MAX_ONLINE) {
    const now = Date.now();
    for (const [k, v] of online) if (now - v.last > ONLINE_WINDOW) online.delete(k);
    if (online.size >= MAX_ONLINE) return;
  }
  online.set(key, { kind, label, last: Date.now() });
}
export function track(req, payload, ip) {
  if (trackLimited(ip)) return { code: 429, body: { error: "rate" } };
  const type = String((payload || {}).type || "");
  const u = userOf(req);
  const anon = String((payload || {}).anon || "").slice(0, 40);
  if (u) { markOnline("user:" + u.id, "user", u.email); if (anon) online.delete("anon:" + anon); }  // 登录后清掉同人的访客条目,免重复计数
  else if (anon) markOnline("anon:" + anon, "anon", anon.slice(0, 8));
  if (type === "visit" || type === "outbound") {
    logEvent(type, { ...(u ? { uid: u.id, email: u.email } : { anon: anon.slice(0, 8) }), ip, ...(payload.id ? { id: String(payload.id).slice(0, 120) } : {}) });
  }
  // type === "hb" 只更新在线表,不落盘
  return { code: 200, body: { ok: true } };
}
// track 限频:比认证宽松(正常用户每分钟约 1 次心跳),但挡住匿名刷接口。
const trackHits = new Map();
function trackLimited(ip) {
  const now = Date.now();
  const arr = (trackHits.get(ip) || []).filter(t => now - t < 60 * 1000);
  if (arr.length >= 40) { trackHits.set(ip, arr); return true; }
  arr.push(now); trackHits.set(ip, arr);
  return false;
}
function onlineNow() {
  const now = Date.now(), usersOn = [], anonKeys = [];
  for (const [key, v] of online) {
    if (now - v.last > ONLINE_WINDOW) { online.delete(key); continue; }
    if (v.kind === "user") usersOn.push({ email: v.label, last: v.last });
    else anonKeys.push(key);
  }
  return { users: usersOn, anonCount: anonKeys.length };
}

// ---------- 管理后台 ----------
function tsEqual(a, b) {
  const ha = createHash("sha256").update(String(a)).digest();
  const hb = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}
// 可选 IP 白名单:设了 ADMIN_IP_ALLOWLIST(逗号分隔)后,只有名单内 IP 能碰管理接口。
// 明文 HTTP + 无域名阶段的加固手段(防有人猜到 /admin 撞密码/嗅探);上 HTTPS 后可放宽。
const ADMIN_IPS = (process.env.ADMIN_IP_ALLOWLIST || "").split(",").map(s => s.trim()).filter(Boolean);
export function adminIpOk(ip) {
  if (!ADMIN_IPS.length) return true;   // 未配置 = 不限制(靠密码把关)
  const bare = String(ip).replace(/^::ffff:/, "");
  return ADMIN_IPS.includes(bare) || ADMIN_IPS.includes(ip);
}
export function adminLogin(password, ip) {
  if (!adminIpOk(ip)) return { code: 403, body: { error: "forbidden" } };
  if (authLimited("admin:" + ip, 5, 10 * 60 * 1000)) return { code: 429, body: { error: "尝试太频繁" } };
  const expect = process.env.ADMIN_PASSWORD;
  if (!expect) return { code: 500, body: { error: "服务端未配置 ADMIN_PASSWORD" } };
  if (!password || !tsEqual(password, expect)) return { code: 401, body: { error: "密码不正确" } };
  const token = randomBytes(32).toString("hex");
  adminTokens.set(token, Date.now() + ADMIN_TTL);
  return { code: 200, body: { ok: true }, headers: { "Set-Cookie": `ap_admin=${token}; Path=/; HttpOnly; SameSite=Lax${SECURE}; Max-Age=${ADMIN_TTL / 1000}` } };
}
export function isAdmin(req, ip) {
  if (ip != null && !adminIpOk(ip)) return false;
  const t = cookieOf(req, "ap_admin");
  const exp = t && adminTokens.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { adminTokens.delete(t); return false; }
  return true;
}

export async function adminOverview() {
  const today = beijingDay();
  const stats = { visit: 0, outbound: 0, search: 0, register: 0, login: 0 };
  const recent = [];
  try {
    // 事件量早期很小,整读即可;以后量大改成读末尾 + 按日汇总文件
    const lines = (await readFile(EVENTS_FILE, "utf8")).trim().split("\n");
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch (x) { continue; }
      if (e.t && beijingDay(e.t) === today && stats[e.type] != null) stats[e.type]++;
    }
    for (const line of lines.slice(-30).reverse()) {
      try { recent.push(JSON.parse(line)); } catch (x) {}
    }
  } catch (e) {}
  const on = onlineNow();
  return {
    code: 200, body: {
      registered_total: users.length,
      registered_today: users.filter(u => beijingDay(u.created_at) === today).length,
      online_users: on.users,
      online_anon: on.anonCount,
      today: stats,
      recent
    }
  };
}
export function adminUsers() {
  const list = users.slice().reverse().map(u => ({
    email: u.email, nickname: u.nickname, avatar: u.avatar || null, created_at: u.created_at,
    last_seen: u.last_seen, favorites: (u.favorites || []).length
  }));
  return { code: 200, body: { total: list.length, users: list } };
}
