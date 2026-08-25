// _tmp-weekly-send.mjs —— 服务器端发送周报(test=试发 / bulk=全量 邮件+站内通知)
// 用法(在服务器 ~/artportal/pipeline 下运行,自动加载同目录 .env 的 SMTP/SITE_URL):
//   node _tmp-weekly-send.mjs test <email> [wid]
//   node _tmp-weekly-send.mjs bulk [wid]
// note:wid 省略默认当前周
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
const __dir = dirname(fileURLToPath(import.meta.url));

// 加载同目录 .env(服务器 SMTP、SITE_URL 等)
try {
  const _env = readFileSync(join(__dir, ".env"), "utf8");
  for (const _l of _env.split(/\r?\n/)) {
    const _m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(_l);
    if (_m && !_l.trim().startsWith("#") && process.env[_m[1]] == null) process.env[_m[1]] = _m[2];
  }
} catch (e) { process.stderr.write("[send] 未找到 .env:" + e.message + "\n"); }

import { readWeeklyIndex, readWeekly, renderEmailHtml, renderEmailText } from "./lib/weekly.mjs";
import { sendMail, mailerOn } from "./lib/mailer.mjs";
import * as auth from "./lib/auth.mjs";
import * as db from "./lib/db.mjs";
import { agentLog } from "./lib/db.mjs";

await auth.initAuth().catch(e => process.stderr.write("[send] initAuth 失败:" + e.message + "\n"));

const SITE_URL = (process.env.SITE_URL || "http://60.205.212.195").replace(/\/+$/, "");
function unsubUrlOf(email) {
  return SITE_URL + "/api/newsletter/unsub?e=" + Buffer.from(String(email).toLowerCase()).toString("base64url") + "&t=" + auth.unsubToken(email);
}
function sendTo(report, email) {
  const ctx = { siteUrl: SITE_URL, unsubUrl: unsubUrlOf(email) };
  return sendMail({
    to: email,
    subject: report.title,
    html: renderEmailHtml(report, ctx),
    text: renderEmailText(report, ctx),
    headers: { "List-Unsubscribe": "<" + ctx.unsubUrl + ">" }
  });
}
async function notifyWeeklyPublished(report) {
  try { const uids = auth.allUserIds(); if (uids.length) await db.notifyBroadcast(uids, { type: "weekly", refkey: "weekly:" + report.id, ref: { id: report.id, title: report.title } }); } catch (e) {}
}

const mode = process.argv[2];
const wid = process.argv[4] || weekNow();
function weekNow() { const d = new Date(Date.now() + 8 * 3600e3); const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3); const y = dt.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4)); const w = 1 + Math.round(((dt - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7); return y + "-W" + String(w).padStart(2, "0"); }

if (!mailerOn()) { process.stderr.write("[send] 发信未配置,中止\n"); process.exit(1); }
const report = await readWeekly(wid);
if (!report) { process.stderr.write("[send] 找不到该期 " + wid + "\n"); process.exit(1); }
process.stderr.write("[send] 发送 " + report.id + "「" + report.title + "」 SMTP=" + process.env.SMTP_HOST + "\n");

if (mode === "test") {
  const email = process.argv[3];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email || "")) { process.stderr.write("[send] 试发邮箱不合法\n"); process.exit(1); }
  // 试发也记入发送日志(标记 试发,不入群发去重集合的"已发"判定)
  await sendTo(report, email);
  await db.nlLogSend(report.id, email + " (试发)", true, null);
  process.stderr.write("[send] ✅ 试发成功 → " + email + "\n");
} else if (mode === "bulk") {
  // 站内通知全体用户
  process.stderr.write("[send] 站内通知全体用户…\n");
  await notifyWeeklyPublished(report);
  // 邮件分批群发(新引擎,与 server.mjs sendWeeklyBulk 同逻辑):去重已发 → 断点续发
  const audience = auth.newsletterAudience();
  const sent = await db.nlSentSet(report.id);
  const targets = audience.filter(a => !sent.has(a.email));
  const NL_BATCH = Math.max(1, Number(process.env.NEWSLETTER_BATCH || 15));
  const NL_EMAIL_GAP = Math.max(2000, Number(process.env.NEWSLETTER_SEND_DELAY_MS || 6000));
  const NL_BATCH_GAP = Math.max(0, Number(process.env.NEWSLETTER_BATCH_GAP_MS || 30 * 60 * 1000));
  const NL_COOL_MS = Math.max(30 * 1000, Number(process.env.NEWSLETTER_COOLDOWN_MS || 30 * 60 * 1000));
  const nlRateLimited = e => /535|login|frequency|限流|风控|abnormal/i.test(String((e && (e.message || e)) || ""));
  process.stderr.write("[send] 订阅 " + audience.length + " 人,本轮待发 " + targets.length + " 封(分批≤" + NL_BATCH + ", 批隔 " + Math.round(NL_BATCH_GAP / 60000) + " 分, 风控冷却 " + Math.round(NL_COOL_MS / 60000) + " 分, 逐封 " + NL_EMAIL_GAP + "ms)\n");
  let ok = 0, fail = 0, batchOk = 0;
  for (let i = 0; i < targets.length; i++) {
    // 批间暂停:本批发满且还有剩下,摊到下一时段,降低被 QQ 风控概率
    if (batchOk >= NL_BATCH) {
      batchOk = 0;
      process.stderr.write("[send] 本批已满,歇 " + Math.round(NL_BATCH_GAP / 60000) + " 分后再发…\n");
      await new Promise(r => setTimeout(r, NL_BATCH_GAP));
    }
    const t = targets[i];
    try {
      await sendTo(report, t.email);
      await db.nlLogSend(report.id, t.email, true, null);
      ok++; batchOk++;
    } catch (e) {
      if (nlRateLimited(e)) {
        // 风控命中:这封不记成功不记失败,冷却后自动重发,直到解限
        process.stderr.write("[send] 命中风控(" + t.email + "):" + String(e.message || e).slice(0, 70) + "… 冷却 " + Math.round(NL_COOL_MS / 60000) + " 分后自动重发\n");
        await new Promise(r => setTimeout(r, NL_COOL_MS));
        batchOk = 0;
        i--;
        continue;
      }
      await db.nlLogSend(report.id, t.email, false, e.message);
      fail++;
      process.stderr.write("[send] 失败 " + t.email + ":" + String(e.message || e).slice(0, 90) + "\n");
    }
    await new Promise(r => setTimeout(r, NL_EMAIL_GAP));
  }
  await agentLog({ agent: "postman", ok: ok === targets.length, summary: `群发 ${report.id}:成功 ${ok}/${targets.length}${fail ? ',失败 ' + fail : ''}`, metrics: { wid: report.id, ok, total: targets.length } }).catch(() => {});
  process.stderr.write("[send] ✅ 群发结束 " + report.id + ":成功 " + ok + "/" + targets.length + ",失败 " + fail + "\n");
} else {
  process.stderr.write("[send] 用法:test <email> [wid] | bulk [wid]\n"); process.exit(1);
}
process.exit(0);