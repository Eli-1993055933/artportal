// auth.mjs —— 账号 / 会话 / 事件统计 / 在线追踪(供 server.mjs 挂载)。
//
// 设计原则(与全站一致:零第三方依赖、文件存储、写串行 + 原子替换):
// - 用户数据存 pipeline/state/(绝不放 site/,那是公开静态目录)。
// - 只收最少信息:邮箱 + 密码哈希(scrypt+盐),昵称等资料留待社区功能上线再渐进补全。
// - 会话:HttpOnly Cookie,180 天;重启不掉线(sessions.json 持久化)。
// - 事件:events.jsonl 追加(visit/outbound/search/register/login),心跳只进内存不落盘。

import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac, createCipheriv, createDecipheriv } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resolver } from "node:dns/promises";
import { wordHits, moderateText } from "./moderation.mjs";
import { logModeration } from "./db.mjs";
import { mailerOn, sendVerifyCode } from "./mailer.mjs";
import { smsOn, sendSmsCode, checkSmsCode } from "./sms.mjs";
import { ipRegion } from "./ipregion.mjs";

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
let byPhone = new Map();                        // phone_hmac -> user(手机号唯一性索引;明文手机号加密存储)
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
  byEmail = new Map(users.filter(u => u.email).map(u => [u.email, u]));
  byPhone = new Map(users.filter(u => u.phone_hmac).map(u => [u.phone_hmac, u]));
  rebuildNickIndex();
  try {
    const d = JSON.parse(await readFile(SESS_FILE, "utf8"));
    const now = Date.now();
    sessions = new Map(Object.entries(d.sessions || {}).filter(([, s]) => now - s.created_at < SESS_TTL));
  } catch (e) { sessions = new Map(); }
  await loadUserActs();
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
  if (extra && extra.uid) {
    const c = userActs.get(extra.uid) || { usage: 0, interaction: 0 };
    if (USAGE_EVTS.has(type)) c.usage++;
    if (INTR_EVTS.has(type)) c.interaction++;
    userActs.set(extra.uid, c);
  }
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

// ---------- 行为计数(后台用户排序:高频使用 / 最多互动) ----------
// 使用类=浏览/检索/作品等消费行为;互动类=评论/反馈/关注/收藏/登录等参与行为。
// 启动时从 events.jsonl 建一次索引,之后 logEvent 增量更新,避免每次后台请求都重读大文件。
const USAGE_EVTS = new Set(["visit", "view", "outbound", "search", "work", "wkread"]);
const INTR_EVTS = new Set(["comment", "feedback", "follow", "fav", "submit", "login", "profile"]);
const userActs = new Map();                // uid -> { usage, interaction }
async function loadUserActs() {
  try {
    const txt = await readFile(EVENTS_FILE, "utf8");
    for (const line of txt.split("\n")) {
      if (!line) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (!e.uid) continue;
      const c = userActs.get(e.uid) || { usage: 0, interaction: 0 };
      if (USAGE_EVTS.has(e.type)) c.usage++;
      if (INTR_EVTS.has(e.type)) c.interaction++;
      userActs.set(e.uid, c);
    }
  } catch (e) { /* 事件文件还没生成:保持空即可 */ }
}

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
  return users.filter(u => u.newsletter && !u.banned && u.email)   // 手机注册用户 email 可为 null,无邮箱不进群发名单
    .sort((a, b) => (b.email_verified ? 1 : 0) - (a.email_verified ? 1 : 0))
    .map(u => ({ email: u.email, id: u.id }));
}
export function newsletterCount() { return users.filter(u => u.newsletter && !u.banned && u.email).length; }
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
// 生成+发送验证码的共用逻辑(注册发码 sendEmailCode 与老用户补验证发码 sendEmailCodeForBind 共用)。
async function issueEmailCode(email, ip) {
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
  const resp = { ok: true };
  if (process.env.MAIL_DEBUG === "1") resp.debug_code = code;
  return { code: 200, body: resp };
}
export async function sendEmailCode(body, ip) {
  if (!mailerOn()) return { code: 400, body: { error: "当前无需验证码,直接注册即可" } };
  const email = String((body || {}).email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
  if (byEmail.has(email)) return { code: 409, body: { error: "该邮箱已注册,请直接登录" } };
  return issueEmailCode(email, ip);
}
// 已登录老用户补验证/换绑邮箱发验证码(2026-08-06,邮箱验证变必需):目标邮箱允许是【自己】名下
// 已存但未验证的邮箱(sendEmailCode 会因"已注册"拒掉这种情况,故单独一个函数),不允许是别人的。
export async function sendEmailCodeForBind(req, body, ip) {
  if (!mailerOn()) return { code: 400, body: { error: "当前无需验证码" } };
  const u = userOf(req);
  if (!u) return { code: 401, body: { error: "未登录" } };
  const email = String((body || {}).email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
  const holder = byEmail.get(email);
  if (holder && holder.id !== u.id) return { code: 409, body: { error: "该邮箱已被其他账号使用" } };
  return issueEmailCode(email, ip);
}

// ---------- 手机号实名(备案安全评估「真实身份核验」;仅 smsOn() 时启用,阿里云短信配好即生效) ----------
// 明文手机号绝不落盘明文:phone_hmac(不可逆,做唯一性/查找)+ phone(AES-256-GCM 加密,可解密用于掩码展示/依法调取)。
const PHONE_RE = /^1[3-9]\d{9}$/;                          // 中国大陆手机号
let phoneKey = null;
function phoneEncKey() { if (!phoneKey) phoneKey = scryptSync(mailSecret, "ap-phone-enc-v1", 32); return phoneKey; }  // 由服务器本地密钥派生,稳定、无需新增 .env
function phoneHmac(phone) { return createHmac("sha256", mailSecret).update(String(phone)).digest("hex"); }
function encPhone(phone) {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", phoneEncKey(), iv);
  const ct = Buffer.concat([c.update(String(phone), "utf8"), c.final()]);
  return iv.toString("hex") + ":" + c.getAuthTag().toString("hex") + ":" + ct.toString("hex");
}
function decPhone(enc) {
  try {
    const [iv, tag, ct] = String(enc).split(":");
    const d = createDecipheriv("aes-256-gcm", phoneEncKey(), Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(ct, "hex")), d.final()]).toString("utf8");
  } catch (e) { return null; }
}
function maskPhone(phone) { const s = String(phone || ""); return PHONE_RE.test(s) ? s.slice(0, 3) + "****" + s.slice(-4) : null; }
export function needsPhone(u) { return smsOn() && !!u && !u.phone_verified; }   // 发布门:开启实名后,未绑手机不得发布
// 2026-08-06:邮箱验证变必需——mailer 配好后,没有已验证邮箱的老用户(含没填过邮箱的)登录即强制补验证。
export function needsEmailVerify(u) { return mailerOn() && !!u && !u.email_verified; }

// 发手机验证码。purpose: register(注册,手机号须未占用) / bind(老用户绑定,手机号须未被他人占用)
// 验证码由阿里云生成+记忆+校验(见 sms.mjs);我方只做发送前的占用查重与限频。
export async function sendPhoneCode(body, ip) {
  if (!smsOn()) return { code: 400, body: { error: "当前无需手机验证码" } };
  const phone = String((body || {}).phone || "").trim();
  if (!PHONE_RE.test(phone)) return { code: 400, body: { error: "手机号格式不正确" } };
  if (byPhone.has(phoneHmac(phone))) return { code: 409, body: { error: (body || {}).purpose === "bind" ? "该手机号已被其他账号绑定" : "该手机号已注册,请直接登录" } };
  if (authLimited("sms:" + phone, 3, 10 * 60 * 1000)) return { code: 429, body: { error: "该手机号请求验证码太频繁,请稍后再试" } };
  // 按 IP:原 8 次/10 分 = 同一 WiFi 出口 10 分钟只能有 8 个人注册,活动现场直接卡死。放宽到 40。
  if (authLimited("smsip:" + ip, Math.max(5, Number(process.env.RL_SMS_IP_PER_10MIN || 40)), 10 * 60 * 1000))
    return { code: 429, body: { error: "发送太频繁,请稍后再试" } };
  // ★ 真正护住短信额度的是这道全局日闸(阿里云按条计费,赠送额度有限):
  //   放宽按 IP 阈值后,必须有一道全站上限兜底,否则脚本换号狂发能把额度/余额烧光。
  if (smsDayCapped()) {
    process.stderr.write("[sms] 今日发送已达全局上限 " + smsDayCap() + " 条,暂停发码(调 SMS_DAILY_CAP 放宽)\n");
    return { code: 429, body: { error: "今日验证码发送量已达上限,请稍后或联系站长" } };
  }
  try { await sendSmsCode(phone); }
  catch (e) {
    process.stderr.write("[sms] 发送失败 " + phone + ": " + (e.message || e) + "\n");
    return { code: 503, body: { error: "验证码发送失败,请稍后再试" } };
  }
  smsDayBump();
  logEvent("smscode", { phone: maskPhone(phone), ip });
  const resp = { ok: true };
  if (process.env.SMS_DEBUG === "1") resp.debug_code = "000000";
  return { code: 200, body: resp };
}
// 短信全局日闸(v0.97.0):只统计【真发出去】的条数(发送失败不计,免把额度算错)。
// 进程内计数,重启归零——短信额度是"天级"资源,重启少算几条可接受,不值得为它落盘。
// 默认 300 条/天:活动现场百人注册够用,又不至于被刷爆额度;要更严/更松改 .env SMS_DAILY_CAP。
let smsDay = null, smsDayN = 0;
function smsDayCap() { return Math.max(10, Number(process.env.SMS_DAILY_CAP || 300)); }
function smsToday() { return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); }   // 按北京日切
function smsDayCapped() { if (smsDay !== smsToday()) { smsDay = smsToday(); smsDayN = 0; } return smsDayN >= smsDayCap(); }
function smsDayBump() { if (smsDay !== smsToday()) { smsDay = smsToday(); smsDayN = 0; } smsDayN++; }
export function smsDayUsed() { return smsDay === smsToday() ? smsDayN : 0; }   // /admin 简报可读
// 校验手机验证码(调阿里云 CheckSmsVerifyCode):通过返回 null,否则返回错误文案。
async function checkPhoneCode(phone, code) {
  if (!/^\d{4,6}$/.test(String(code || "").trim())) return "请填写收到的手机验证码";
  let pass;
  try { pass = await checkSmsCode(phone, code); }
  catch (e) { process.stderr.write("[sms] 校验失败 " + phone + ": " + (e.message || e) + "\n"); return "验证码校验失败,请稍后再试"; }
  return pass ? null : "验证码不正确或已过期";
}
// 老用户绑定手机号完成实名(登录后强制)
export async function bindPhone(req, body, ip) {
  const u = userOf(req);
  if (!u) return { code: 401, body: { error: "未登录" } };
  if (!smsOn()) return { code: 400, body: { error: "当前无需绑定手机号" } };
  if (authLimited("bind:" + u.id, 8, 10 * 60 * 1000)) return { code: 429, body: { error: "操作太频繁,请稍后再试" } };
  const phone = String((body || {}).phone || "").trim();
  if (!PHONE_RE.test(phone)) return { code: 400, body: { error: "手机号格式不正确" } };
  const holder = byPhone.get(phoneHmac(phone));
  if (holder && holder.id !== u.id) return { code: 409, body: { error: "该手机号已被其他账号绑定" } };
  const err = await checkPhoneCode(phone, (body || {}).code);
  if (err) return { code: 400, body: { error: err } };
  if (u.phone_hmac) byPhone.delete(u.phone_hmac);
  u.phone = encPhone(phone); u.phone_hmac = phoneHmac(phone); u.phone_verified = true;
  byPhone.set(u.phone_hmac, u);
  saveUsers();
  logEvent("bindphone", { uid: u.id, phone: maskPhone(phone), ip });
  return { code: 200, body: { user: publicUser(u) } };
}

// 老用户绑定/补验证邮箱(2026-08-06,登录后强制;也用于换绑邮箱)
export async function bindEmail(req, body, ip) {
  const u = userOf(req);
  if (!u) return { code: 401, body: { error: "未登录" } };
  if (!mailerOn()) return { code: 400, body: { error: "当前无需验证邮箱" } };
  if (authLimited("bindemail:" + u.id, 8, 10 * 60 * 1000)) return { code: 429, body: { error: "操作太频繁,请稍后再试" } };
  const email = String((body || {}).email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
  const holder = byEmail.get(email);
  if (holder && holder.id !== u.id) return { code: 409, body: { error: "该邮箱已被其他账号使用" } };
  const rec = emailCodes.get(email);
  if (!rec || Date.now() > rec.exp) return { code: 400, body: { error: "请先获取邮箱验证码" } };
  rec.tries++;
  if (rec.tries > 5) { emailCodes.delete(email); return { code: 429, body: { error: "尝试次数过多,请重新获取验证码" } }; }
  if (String((body || {}).code || "").trim() !== rec.code) return { code: 400, body: { error: "验证码不正确" } };
  emailCodes.delete(email);
  if (u.email && u.email !== email) byEmail.delete(u.email);
  u.email = email; u.email_verified = true;
  byEmail.set(email, u);
  saveUsers();
  logEvent("bindemail", { uid: u.id, email, ip });
  return { code: 200, body: { user: publicUser(u) } };
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
// ★ v0.97.0 现场化:所有按 IP 的阈值都要按「一个出口 IP 后面几十上百人」(展会/学校/公司 NAT)
//   来定,否则活动现场第 11 个人就注册不了。真正的防爆破靠的是**按账号/按手机号**那几条
//   (sms:<手机号> 3次/10分、login 失败计数、bind:<uid>),那些一律不放宽。
const authHits = new Map();                    // ip -> [ts...]
function authLimited(ip, max = Math.max(5, Number(process.env.RL_AUTH_PER_10MIN || 60)), windowMs = 10 * 60 * 1000) {
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
    phone_masked: maskPhone(u.phone ? decPhone(u.phone) : null),   // 掩码手机号(138****5678);绝不返回明文
    phone_verified: !!u.phone_verified,
    needs_profile: !(u.nickname && u.avatar)   // 昵称+头像必填;缺任一,前端强制补全
  };
}

// 用户搜索(8.2):按昵称归一化子串匹配;只出已完成资料的用户、公开最小字段(绝不含邮箱)
export function searchUsers(q, ip) {
  if (authLimited("usearch:" + ip, Math.max(10, Number(process.env.RL_USEARCH_PER_MIN || 120)), 60 * 1000)) return { code: 429, body: { error: "搜索太频繁,歇一下" } };
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
    return u && u.nickname ? { id: u.id, nickname: u.nickname, avatar: u.avatar || null, identity: (u.profile || {}).identity || "", ip_region: u.ip_region || null } : null;
  }).filter(Boolean);
}
export function userExists(uid) { return users.some(u => u.id === uid && u.nickname); }
// 数据面板"访客明细"用(admin 专用,含邮箱,别的地方别复用——公开面不出邮箱)
export function usersForAdminLookup(uids) {
  const set = new Set(uids);
  return users.filter(u => set.has(u.id)).map(u => ({ id: u.id, email: u.email || null, nickname: u.nickname || null, avatar: (u.id && u.avatar) ? u.avatar : null, region: (u.ip_region && u.ip_region.disp) || null }));
}

// 用户公开主页(8.1):任何人可看。只出公开字段——绝不含邮箱/收藏之外的任何隐私(红线)。
export function publicProfile(uid, ip) {
  if (authLimited("pub:" + ip, Math.max(20, Number(process.env.RL_PUBLIC_PER_MIN || 300)), 60 * 1000)) return { code: 429, body: { error: "请求太频繁,请稍后再试" } };
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
    favorites: pub ? (u.favorites || []) : [],
    ip_region: u.ip_region || null   // IP 属地合规展示(境内省级/境外国家,不含具体 IP)
  } } };
}

// IP 属地:首见即锚定(只记录第一次见到的位置,不随后续 IP 变动覆盖);返回当前属地供 me 响应
export function touchIpRegion(uid, region) {
  const u = users.find(x => x.id === uid);
  if (!u) return region || null;
  // 属地"首见即锚定":只写第一次见到的值;已记录的永不因后续 IP(尤其 VPN/换节点漂移)变动而覆盖。
  if (region && !u.ip_region) { u.ip_region = region; saveUsers(); }
  return u.ip_region || null;
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
  if (needsPhone(u)) return { code: 403, body: { error: "请先绑定手机号完成实名后再发布" } };   // 资料是公开可检索内容,同发布口径受实名门控
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
  if (!avatar && !u.avatar) return { code: 400, body: { error: "请上传一张头像图片" } };
  if (avatar) {
    if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar) || avatar.length > 300000) {
      return { code: 400, body: { error: "头像图片无效或过大" } };
    }
    let buf;
    try { buf = Buffer.from(avatar.slice(23), "base64"); } catch (e) { return { code: 400, body: { error: "头像图片无效" } }; }
    if (buf.length < 100 || buf.length > 220000) return { code: 400, body: { error: "头像图片无效或过大" } };
    await mkdir(AVATARS, { recursive: true });
    await writeFile(join(AVATARS, u.id + ".jpg"), buf);
    u.avatar = "assets/avatars/" + u.id + ".jpg?v=" + Date.now();
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

// 新用户资料(注册时采集):性别(必填) + 出生年份(必填)。缺失也放行(前端注册表单是必填,
// 老注册通道或异常跳过时靠 needs_profile 强制在资料页补全)。存 profile 而非顶层,与现有资料字段一致。
function newUserProfile(body) {
  const pr = {};
  const g = String((body || {}).gender || "").trim();
  if (g === "male" || g === "female" || g === "private") pr.gender = g;
  const by = parseInt((body || {}).birth_year, 10);
  const maxYear = new Date().getFullYear() - 8;
  if (by && by >= 1900 && by <= maxYear) pr.birth_year = by;
  return pr;
}
// 按出生年算当前年龄段(数据面板用户构成用);缺资料返回 null
function ageBucket(u) {
  const by = (u.profile || {}).birth_year;
  if (!by) return null;
  const age = new Date().getFullYear() - by;
  if (age < 20) return "<20";
  if (age < 30) return "20-29";
  if (age < 40) return "30-39";
  if (age < 50) return "40-49";
  if (age < 60) return "50-59";
  return "60+";
}
// IP 属地聚合键:越具体越好的可读文本(省·市或境外国家),没有则"未知"
function regionKey(u) {
  const d = (u.ip_region && u.ip_region.disp) || "";
  return d || "未知";
}
// 数据面板"用户构成"(admin 专用):性别 / 年龄 / IP 地区三组分布,供后台画环形饼图
export function adminUserComposition() {
  const byBucket = arr => {
    const m = new Map();
    for (const a of arr) { const k = a || "未知"; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  };
  const genderZh = users.filter(u => u.nickname && (u.profile || {}).gender).map(u => GENDER_ZH[(u.profile || {}).gender] || "未知");
  const age = users.filter(u => u.nickname && ageBucket(u)).map(ageBucket);
  const region = users.filter(u => u.nickname && u.ip_region).map(regionKey);
  return {
    total: users.filter(u => u.nickname).length,
    gender: byBucket(genderZh),
    age: byBucket(age),
    region: byBucket(region).slice(0, 12)
  };
}
const GENDER_ZH = { male: "男", female: "女", private: "保密" };
export async function register(body, ip) {
  if (authLimited(ip)) return { code: 429, body: { error: "尝试太频繁,请稍后再试" } };
  body = body || {};
  const password = String(body.password || "");
  const newsletter = body.newsletter !== false;   // 按需求:新注册默认订阅周报(注册表单勾选框已默认打勾)

  if (smsOn()) {
    // —— 手机号短信验证码实名注册(阿里云短信配好后的主通道)——
    const phone = String(body.phone || "").trim();
    // 前端 me() 加载失败时可能停在邮箱表单(无手机框),此时提交带 email 无 phone → 提示刷新用手机注册
    if (!phone && body.email) return { code: 400, body: { error: "页面需刷新后用手机号注册,请刷新页面重试" } };
    if (!PHONE_RE.test(phone)) return { code: 400, body: { error: "手机号格式不正确" } };
    if (password.length < 6 || password.length > 72) return { code: 400, body: { error: "密码需 6–72 位" } };
    if (byPhone.has(phoneHmac(phone))) return { code: 409, body: { error: "该手机号已注册,请直接登录" } };
    if (users.length >= MAX_USERS) return { code: 503, body: { error: "注册暂时关闭,请稍后再试" } };
    let email = String(body.email || "").trim().toLowerCase();
    let emailVerified = false;
    // 2026-08-06:mailer 配好后邮箱变必填+必须验证(此前仅选填、从不验证);
    // mailer 未配置(如本地开发、或邮件服务临时故障)时退回原有弱校验,不因基础设施问题拖垮整个注册通道。
    if (mailerOn()) {
      if (!email) return { code: 400, body: { error: "请填写邮箱并获取验证码" } };
      if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
      if (byEmail.has(email)) return { code: 409, body: { error: "该邮箱已被使用" } };
      const rec = emailCodes.get(email);
      if (!rec || Date.now() > rec.exp) return { code: 400, body: { error: "请先获取邮箱验证码" } };
      rec.tries++;
      if (rec.tries > 5) { emailCodes.delete(email); return { code: 429, body: { error: "尝试次数过多,请重新获取验证码" } }; }
      if (String(body.email_code || "").trim() !== rec.code) return { code: 400, body: { error: "邮箱验证码不正确" } };
      emailCodes.delete(email);
      emailVerified = true;
    } else if (email) {
      if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
      if (byEmail.has(email)) return { code: 409, body: { error: "该邮箱已被使用" } };
    }
    const err = await checkPhoneCode(phone, body.code);   // 前端在手机模式下把短信码放 code 字段
    if (err) return { code: 400, body: { error: err } };
    const salt = randomBytes(16).toString("hex");
    const u = {
      id: "u" + randomBytes(6).toString("hex"),
      email: email || null, salt, hash: hashPassword(password, salt), email_verified: emailVerified,
      phone: encPhone(phone), phone_hmac: phoneHmac(phone), phone_verified: true,
      newsletter, nickname: null, profile: newUserProfile(body), favorites: [],
      created_at: new Date().toISOString(), last_seen: new Date().toISOString()
    };
    users.push(u); byPhone.set(u.phone_hmac, u); if (email) byEmail.set(email, u); const _regR = ipRegion(ip); if (_regR) u.ip_region = _regR; saveUsers();
    logEvent("register", { uid: u.id, phone: maskPhone(phone), ip });
    const token = newSession(u.id);
    return { code: 200, body: { user: publicUser(u) }, headers: { "Set-Cookie": sessionCookie(token) } };
  }

  // —— 邮箱注册(未开启手机实名时的原有通道,校验顺序与改动前逐字一致)——
  const email = String(body.email || "").trim().toLowerCase();
  const code = body.code;
  if (!EMAIL_RE.test(email) || email.length > 254) return { code: 400, body: { error: "邮箱格式不正确" } };
  if (password.length < 6 || password.length > 72) return { code: 400, body: { error: "密码需 6–72 位" } };
  if (byEmail.has(email)) return { code: 409, body: { error: "该邮箱已注册,请直接登录" } };
  if (users.length >= MAX_USERS) return { code: 503, body: { error: "注册暂时关闭,请稍后再试" } };
  let verified = false;
  if (mailerOn()) {
    const rec = emailCodes.get(email);
    if (!rec || Date.now() > rec.exp) return { code: 400, body: { error: "请先获取邮箱验证码" } };
    rec.tries++;
    if (rec.tries > 5) { emailCodes.delete(email); return { code: 429, body: { error: "尝试次数过多,请重新获取验证码" } }; }
    if (String(code || "").trim() !== rec.code) return { code: 400, body: { error: "验证码不正确" } };
    emailCodes.delete(email);
    verified = true;
  } else {
    const realErr = await emailRealErr(email);
    if (realErr) return { code: 400, body: { error: realErr } };
  }
  const salt = randomBytes(16).toString("hex");
  const u = {
    id: "u" + randomBytes(6).toString("hex"),
    email, salt, hash: hashPassword(password, salt), email_verified: verified,
    newsletter, nickname: null, profile: newUserProfile(body), favorites: [],
    created_at: new Date().toISOString(), last_seen: new Date().toISOString()
  };
  users.push(u); byEmail.set(email, u); const _regR = ipRegion(ip); if (_regR) u.ip_region = _regR; saveUsers();
  logEvent("register", { uid: u.id, email, ip });
  const token = newSession(u.id);
  return { code: 200, body: { user: publicUser(u) }, headers: { "Set-Cookie": sessionCookie(token) } };
}

// 登录:标识符既可是邮箱、也可是手机号(手机实名开启后新用户用手机登录)
export function login(identifier, password, ip) {
  if (authLimited(ip)) return { code: 429, body: { error: "尝试太频繁,请稍后再试" } };
  identifier = String(identifier || "").trim();
  const u = PHONE_RE.test(identifier) ? byPhone.get(phoneHmac(identifier)) : byEmail.get(identifier.toLowerCase());
  // 统一报错文案 + 恒定耗时(账号不存在也跑一次假哈希),不泄露"是否注册过"
  if (!u) { burnPassword(password); return { code: 401, body: { error: "账号或密码不正确" } }; }
  if (!checkPassword(password, u)) return { code: 401, body: { error: "账号或密码不正确" } };
  if (u.banned) return { code: 403, body: { error: "该账号已被停用。如有疑问请通过页脚反馈联系平台。" } };
  u.last_seen = new Date().toISOString();
  const _loginR = ipRegion(ip); if (_loginR && !u.ip_region) u.ip_region = _loginR;  // 属地首见锚定,不随 VPN 漂移覆盖
  saveUsers();
  logEvent("login", { uid: u.id, email: u.email || maskPhone(u.phone ? decPhone(u.phone) : null), ip });
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
    markOnline("user:" + u.id, "user", u.email || u.nickname || u.id);
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
  // email_code_required:注册是否需要邮箱验证码(mailer 配好);sms_on:是否已开启手机实名(前端据此切换注册表单为手机号);
  // needs_phone_bind:已登录但未绑手机(仅 smsOn 时);needs_email_verify:已登录但没有已验证邮箱(仅 mailerOn 时,2026-08-06)
  // ——前端登录即强制弹相应绑定/验证窗,不可跳过
  return { code: 200, body: {
    user: u ? publicUser(u) : null,
    email_code_required: mailerOn(), sms_on: smsOn(),
    needs_phone_bind: needsPhone(u),
    needs_email_verify: needsEmailVerify(u)
  }, ...(headers ? { headers } : {}) };
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

// 全站收藏总数(数据面板用)
export function favTotal() {
  let n = 0;
  for (const u of users) n += (u.favorites || []).length;
  return n;
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
  if (u) { markOnline("user:" + u.id, "user", u.email || u.nickname || u.id); if (anon) online.delete("anon:" + anon); touchIpRegion(u.id, ipRegion(ip)); }  // 登录后清掉同人的访客条目,免重复计数;并随访问刷新属地
  else if (anon) markOnline("anon:" + anon, "anon", anon.slice(0, 8));
  // 落盘事件白名单(v0.85.0 扩展):visit 进站 / outbound 前往官网 / view 看详情 /
  // fav 收藏切换 / wkread 读周刊;其余(hb 心跳)只更新在线表不落盘。
  if (type === "visit" || type === "outbound" || type === "view" || type === "fav" || type === "wkread") {
    logEvent(type, {
      ...(u ? { uid: u.id, email: u.email } : { anon: anon.slice(0, 8) }), ip,
      ...(payload.id ? { id: String(payload.id).slice(0, 120) } : {}),
      ...(payload.cat ? { cat: String(payload.cat).slice(0, 20) } : {}),
      ...(type === "fav" && payload.on != null ? { on: payload.on ? 1 : 0 } : {})
    });
  }
  // type === "hb" 只更新在线表,不落盘
  return { code: 200, body: { ok: true } };
}
// track 限频:比认证宽松(正常用户每分钟约 1 次心跳),但挡住匿名刷接口。
const trackHits = new Map();
function trackLimited(ip) {
  const now = Date.now();
  const arr = (trackHits.get(ip) || []).filter(t => now - t < 60 * 1000);
  // v0.97.0:每人每分钟 1 次心跳,原 40 次/分 = 同一 WiFi 下 40 人封顶,在线数会失真。放宽到 300。
  if (arr.length >= Math.max(20, Number(process.env.RL_TRACK_PER_MIN || 300))) { trackHits.set(ip, arr); return true; }
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
    // 近期事件补上用户(头像+ID/昵称)与 IP 属地(尽可能具体:省·市/国家),后台处处都能看到用户与属地
    const um = new Map(users.map(u => [u.id, u]));
    for (const e of recent) {
      if (e.uid && um.has(e.uid)) {
        const u = um.get(e.uid);
        e.user = { id: u.id, nickname: u.nickname || null, avatar: u.avatar || null };
        // 属地优先取用户已持久化记录;没有则用事件里的 IP 实时解析(老用户也立即可见)
        e.region = (u.ip_region && u.ip_region.disp) || (e.ip ? ((ipRegion(e.ip) || {}).disp || null) : null);
      }
    }
  } catch (e) {}
  const on = onlineNow();
  const usersOn = on.users.map(function (it) {
    const u = users.find(x => x.email === it.email || x.nickname === it.email || x.id === it.email);
    return {
      email: it.email, last: it.last,
      nickname: (u && u.nickname) || null, avatar: (u && u.avatar) || null,
      region: (u && u.ip_region && u.ip_region.disp) || null
    };
  });
  return {
    code: 200, body: {
      registered_total: users.length,
      registered_today: users.filter(u => beijingDay(u.created_at) === today).length,
      online_users: usersOn,
      online_anon: on.anonCount,
      today: stats,
      recent
    }
  };
}
export function adminUsers() {
  const list = users.slice().reverse().map(u => {
    const a = userActs.get(u.id) || { usage: 0, interaction: 0 };
    return {
      id: u.id, email: u.email, phone_masked: maskPhone(u.phone ? decPhone(u.phone) : null), nickname: u.nickname, avatar: u.avatar || null, created_at: u.created_at,
      last_seen: u.last_seen, favorites: (u.favorites || []).length,
      usage_count: a.usage, interaction_count: a.interaction,
      verified: !!u.email_verified, phone_verified: !!u.phone_verified, banned: !!u.banned, studio: !!u.studio,
      ip_region: (u.ip_region && u.ip_region.disp) || null
    };
  });
  return { code: 200, body: { total: list.length, users: list } };
}
// 用户完整档案(admin 专用):比列表多出属地/资料/收藏明细/订阅标志,供「点名字看档案」用
export function adminUserDetail(uid) {
  const u = users.find(x => x.id === uid);
  if (!u) return null;
  const p = u.profile || {};
  return {
    id: u.id, email: u.email, phone_masked: maskPhone(u.phone ? decPhone(u.phone) : null),
    nickname: u.nickname, avatar: u.avatar || null, created_at: u.created_at, last_seen: u.last_seen,
    verified: !!u.email_verified, phone_verified: !!u.phone_verified, banned: !!u.banned, studio: !!u.studio, newsletter: !!u.newsletter,
    ip_region: u.ip_region || null, fav_count: (u.favorites || []).length,
    bio: p.bio || "", identity: p.identity || "", location: p.location || "", website: p.website || "", fields: p.fields || "",
    favorites: u.favorites || []
  };
}
// 画室工具授权(v0.92.0):按用户持久标志,默认关;仅管理员可改、管理员本人恒开。
export function studioEnabled(uid) {
  const u = users.find(x => x.id === uid);
  return !!(u && u.studio);
}
export function adminSetStudio(uid, on) {
  const u = users.find(x => x.id === uid);
  if (!u) return { code: 404, body: { error: "用户不存在" } };
  u.studio = !!on;
  saveUsers();
  logEvent("studio", { uid: u.id, email: u.email, on: on ? 1 : 0 });
  return { code: 200, body: { ok: true, studio: u.studio } };
}
// 封禁/解封(admin):封禁即杀掉该用户所有会话,登录也被拒。
// key 优先按 uid(手机注册用户 email 可为 null,不能只靠 byEmail,否则封不掉),兼容旧的按 email。
export function adminSetBan(key, on) {
  const k = String(key || "").trim();
  const u = users.find(x => x.id === k) || byEmail.get(k.toLowerCase());
  if (!u) return { code: 404, body: { error: "用户不存在" } };
  u.banned = !!on;
  if (on) {
    for (const [t, s] of sessions) if (s.uid === u.id) sessions.delete(t);
    saveSessions();
  }
  saveUsers();
  logEvent("ban", { uid: u.id, email: u.email || maskPhone(u.phone ? decPhone(u.phone) : null), on: on ? 1 : 0 });
  return { code: 200, body: { ok: true, banned: u.banned } };
}
