// auth.mjs —— 账号 / 会话 / 事件统计 / 在线追踪(供 server.mjs 挂载)。
//
// 设计原则(与全站一致:零第三方依赖、文件存储、写串行 + 原子替换):
// - 用户数据存 pipeline/state/(绝不放 site/,那是公开静态目录)。
// - 只收最少信息:邮箱 + 密码哈希(scrypt+盐),昵称等资料留待社区功能上线再渐进补全。
// - 会话:HttpOnly Cookie,180 天;重启不掉线(sessions.json 持久化)。
// - 事件:events.jsonl 追加(visit/outbound/search/register/login),心跳只进内存不落盘。

import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resolver } from "node:dns/promises";
import { wordHits, moderateText } from "./moderation.mjs";
import { logModeration } from "./db.mjs";
import { mailerOn, sendVerifyCode } from "./mailer.mjs";

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
  await initMailSecret();
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

// ---------- 周报订阅(路线图第 5 项):退订 token + 订阅名单 ----------
// 退订链接要做到"点开即退订、无需登录"(邮件里点的可能不是登录设备),
// 又不能让人拿别人邮箱伪造退订 → 用服务器本地随机密钥做 HMAC(state/mail-secret,首启生成)。
const MAIL_SECRET_FILE = join(STATE, "mail-secret");
let mailSecret = "";
async function initMailSecret() {
  try { mailSecret = (await readFile(MAIL_SECRET_FILE, "utf8")).trim(); } catch (e) {}
  if (!mailSecret) {
    mailSecret = randomBytes(32).toString("hex");
    try { await writeFile(MAIL_SECRET_FILE, mailSecret, "utf8"); } catch (e) {}
  }
}
export function unsubToken(email) {
  return createHmac("sha256", mailSecret).update(String(email).toLowerCase()).digest("hex").slice(0, 32);
}
// 邮件里的退订链接点开:校验 token → 关闭订阅。返回 true=已退订 / false=链接无效
export function newsletterUnsub(email, token) {
  email = String(email || "").trim().toLowerCase();
  const u = byEmail.get(email);
  if (!u || !token) return false;
  try {
    if (!timingSafeEqual(Buffer.from(unsubToken(email)), Buffer.from(String(token).slice(0, 32).padEnd(32, "0")))) return false;
  } catch (e) { return false; }
  u.newsletter = false;
  saveUsers();
  logEvent("unsub", { uid: u.id, email });
  return true;
}
// 群发名单:勾选了订阅、未被封禁的用户(邮箱验证过的优先在前,退信少)
export function newsletterAudience() {
  return users.filter(u => u.newsletter && !u.banned)
    .sort((a, b) => (b.email_verified ? 1 : 0) - (a.email_verified ? 1 : 0))
    .map(u => ({ email: u.email, id: u.id }));
}
export function newsletterCount() { return users.filter(u => u.newsletter && !u.banned).length; }
// 站内周刊通知的收件人:所有未封禁用户(站内通知是低打扰的铃铛提示,邮件才受订阅开关约束)
export function allUserIds() { return users.filter(u => !u.banned).map(u => u.id); }

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

// ---------- 邮箱真实性(注册闸门):一次性邮箱黑名单 + 域名 MX/A 记录校验 ----------
// 常见临时邮箱域名。挡"随手编一个"的假注册;真实域名的假邮箱由验证码机制(mailer 配好后)负责。
const DISPOSABLE = new Set([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org",
  "yopmail.com", "sharklasers.com", "getnada.com", "maildrop.cc", "dispostable.com",
  "fakeinbox.com", "trashmail.com", "mytemp.email", "tempinbox.com", "mohmal.com",
  "linshiyouxiang.net", "mail.tm", "emailondeck.com", "33mail.com", "spambog.com",
  "mintemail.com", "tempmailo.com", "mailnesia.com", "tmpmail.org", "10mail.org",
  "luxusmail.org", "snapmail.cc", "moakt.com", "tempr.email", "throwawaymail.com"
]);
const mxCache = new Map();   // domain -> { ok, exp }(结果缓存,别每次注册都查 DNS)
// 显式走公共 DNS(阿里 223.5.5.5 / 腾讯 119.29.29.29):实测系统/运营商 DNS 会对 MX 查询
// 超时或劫持 NXDOMAIN(不存在的域名也回 A 记录),导致假域名被放行。公共 DNS 行为干净。
const dnsr = new Resolver();
try { dnsr.setServers(["223.5.5.5", "119.29.29.29"]); } catch (e) {}
function dnsTimed(fn, domain) {
  return Promise.race([dnsr[fn](domain), new Promise((_, rj) => setTimeout(() => rj(Object.assign(new Error("dns timeout"), { code: "ETIMEOUT" })), 3500))]);
}
async function domainAcceptsMail(domain) {
  const hit = mxCache.get(domain);
  if (hit && Date.now() < hit.exp) return hit.ok;
  async function q(fn) {
    try { const r = await dnsTimed(fn, domain); return { ok: Array.isArray(r) && r.length > 0 }; }
    catch (e) {
      // ENOTFOUND/ENODATA = 域名/记录确实不存在 → 定论;超时/解析器故障 → 不定论(放行,别误杀真实用户)
      if (e && (e.code === "ENOTFOUND" || e.code === "ENODATA")) return { ok: false };
      return { indeterminate: true };
    }
  }
  const mx = await q("resolveMx");
  let ok;
  if (mx.ok) ok = true;
  else if (mx.indeterminate) return true;
  else {
    const a = await q("resolve4");                // RFC 5321:没有 MX 记录时退 A 记录
    if (a.indeterminate) return true;
    ok = a.ok;
  }
  mxCache.set(domain, { ok, exp: Date.now() + (ok ? 24 : 2) * 3600e3 });
  return ok;
}
// 黑名单 + 域名校验,返回错误文案或 null
async function emailRealErr(email) {
  const domain = email.split("@")[1] || "";
  if (DISPOSABLE.has(domain)) return "不支持一次性邮箱,请用常用邮箱注册";
  if (!(await domainAcceptsMail(domain))) return "该邮箱域名不存在或无法收信,请检查拼写";
  return null;
}

// ---------- 邮箱验证码(mailer 配置好后启用;未配置时注册走上面的弱校验) ----------
const emailCodes = new Map();   // email -> { code, exp, tries }
export async function sendEmailCode(body, ip) {
  if (!mailerOn()) return { code: 400, body: { error: "当前无需验证码,直接注册即可" } };
  const email = String((body || {}).email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
  if (byEmail.has(email)) return { code: 409, body: { error: "该邮箱已注册,请直接登录" } };
  const realErr = await emailRealErr(email);
  if (realErr) return { code: 400, body: { error: realErr } };
  if (authLimited("code:" + email, 3, 10 * 60 * 1000)) return { code: 429, body: { error: "该邮箱请求验证码太频繁,请稍后再试" } };
  if (authLimited("codeip:" + ip, 8, 10 * 60 * 1000)) return { code: 429, body: { error: "发送太频繁,请稍后再试" } };
  const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
  emailCodes.set(email, { code, exp: Date.now() + 10 * 60 * 1000, tries: 0 });
  if (emailCodes.size > 10000) {                  // 容量兜底:清过期
    const now = Date.now();
    for (const [k, v] of emailCodes) if (now > v.exp) emailCodes.delete(k);
  }
  try { await sendVerifyCode(email, code); }
  catch (e) {
    emailCodes.delete(email);
    process.stderr.write("[mailer] 发送失败 " + email + ": " + (e.message || e) + "\n");
    return { code: 503, body: { error: "验证码发送失败,请稍后再试" } };
  }
  logEvent("sendcode", { email, ip });
  return { code: 200, body: { ok: true } };
}

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
  if (u && u.banned) return null;               // 封禁账号:会话视同失效(所有登录态接口即刻失能)
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
    newsletter: !!u.newsletter,                // 周报订阅(注册勾选/资料页可改/邮件可退订)
    nickname_changed_at: u.nickname_changed_at || null,
    email_verified: !!u.email_verified,
    needs_profile: !(u.nickname && u.avatar)   // 昵称+头像必填;缺任一,前端强制补全
  };
}

// 用户搜索(8.2):按昵称归一化子串匹配;只出已完成资料的用户、公开最小字段(绝不含邮箱)
export function searchUsers(q, ip) {
  if (authLimited("usearch:" + ip, 30, 60 * 1000)) return { code: 429, body: { error: "搜索太频繁,歇一下" } };
  q = String(q || "").trim().toLowerCase().replace(/\s+/g, "");
  if (!q || q.length > 30) return { code: 400, body: { error: "关键词 1–30 字" } };
  const out = [];
  for (const u of users) {
    if (!u.nickname || !u.avatar) continue;                    // 资料未完成的不进搜索
    if (nickKey(u.nickname).indexOf(q) === -1) continue;
    out.push({ id: u.id, nickname: u.nickname, avatar: u.avatar, identity: (u.profile || {}).identity || "" });
    if (out.length >= 12) break;
  }
  return { code: 200, body: { users: out } };
}
// 批量取用户公开摘要(关注/粉丝列表用);查不到/资料未完成的剔除
export function usersMini(uids) {
  const byId = new Map(users.map(u => [u.id, u]));
  return uids.map(id => {
    const u = byId.get(id);
    return u && u.nickname ? { id: u.id, nickname: u.nickname, avatar: u.avatar || null, identity: (u.profile || {}).identity || "" } : null;
  }).filter(Boolean);
}
export function userExists(uid) { return users.some(u => u.id === uid && u.nickname); }

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
    const mod = await moderateText(freeText, "profile");
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
  if (typeof b.newsletter === "boolean") u.newsletter = b.newsletter;   // 周报订阅开关(资料页)
  saveUsers();
  logEvent("profile", { uid: u.id, email: u.email, ip, nickname });
  return { code: 200, body: { user: publicUser(u) } };
}

export async function register(email, password, code, ip, newsletter) {
  if (authLimited(ip)) return { code: 429, body: { error: "尝试太频繁,请稍后再试" } };
  email = String(email || "").trim().toLowerCase();
  password = String(password || "");
  if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
  if (password.length < 6 || password.length > 72) return { code: 400, body: { error: "密码需 6–72 位" } };
  if (byEmail.has(email)) return { code: 409, body: { error: "该邮箱已注册,请直接登录" } };
  if (users.length >= MAX_USERS) return { code: 503, body: { error: "注册暂时关闭,请稍后再试" } };
  let verified = false;
  if (mailerOn()) {
    // 发信已配置:必须携带发到邮箱的 6 位验证码(能收到 = 邮箱真实且是本人)
    const rec = emailCodes.get(email);
    if (!rec || Date.now() > rec.exp) return { code: 400, body: { error: "请先获取邮箱验证码" } };
    rec.tries++;
    if (rec.tries > 5) { emailCodes.delete(email); return { code: 429, body: { error: "尝试次数过多,请重新获取验证码" } }; }
    if (String(code || "").trim() !== rec.code) return { code: 400, body: { error: "验证码不正确" } };
    emailCodes.delete(email);
    verified = true;
  } else {
    // 发信未配置:退化为真实性弱校验(一次性邮箱黑名单 + 域名 MX/A 记录),挡住乱编的域名
    const realErr = await emailRealErr(email);
    if (realErr) return { code: 400, body: { error: realErr } };
  }
  const salt = randomBytes(16).toString("hex");
  const u = {
    id: "u" + randomBytes(6).toString("hex"),
    email, salt, hash: hashPassword(password, salt),
    email_verified: verified,
    newsletter: !!newsletter,     // 注册页勾选"订阅周报"才 true(《个保法》明示同意,绝不默认勾)
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
  if (u.banned) return { code: 403, body: { error: "该账号已被停用。如有疑问请通过页脚反馈联系平台。" } };
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
  // email_code_required:告诉前端注册是否需要验证码(mailer 配置好即 true)
  return { code: 200, body: { user: u ? publicUser(u) : null, email_code_required: mailerOn() }, ...(headers ? { headers } : {}) };
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
    last_seen: u.last_seen, favorites: (u.favorites || []).length,
    verified: !!u.email_verified, banned: !!u.banned
  }));
  return { code: 200, body: { total: list.length, users: list } };
}
// 封禁/解封(admin):封禁即杀掉该用户所有会话,登录也被拒
export function adminSetBan(email, on) {
  const u = byEmail.get(String(email || "").trim().toLowerCase());
  if (!u) return { code: 404, body: { error: "用户不存在" } };
  u.banned = !!on;
  if (on) {
    for (const [t, s] of sessions) if (s.uid === u.id) sessions.delete(t);
    saveSessions();
  }
  saveUsers();
  logEvent("ban", { uid: u.id, email: u.email, on: on ? 1 : 0 });
  return { code: 200, body: { ok: true, banned: u.banned } };
}
