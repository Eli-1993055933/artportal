// mail-survey-announce.mjs —— 一次性脚本(2026-08-01):给问卷第3题留过邮箱、勾选"同步平台进展"
// 的联系人发 ArtPortal 正式上线通知。跟站内周报订阅系统(newsletter/NEWSLETTER_BULK)完全独立,
// 收件人不在 users 表里,不走那条通道,也不受那道群发闸控制。
//
// 用法:node mail-survey-announce.mjs [--dry] [--delay=毫秒]
//   --dry     只打印将发给谁,不真发信(核对名单用)。
//   --delay   逐封间隔,默认 3000ms。首次运行 86 封发到 18 封就被 QQ 邮箱 SMTP 登录频率限制拦了
//             (535 login frequency limited)——个人 QQ 邮箱本不是给批量发信设计的,连续开太多次
//             登录会被临时限速。重试时拉长间隔(比如 --delay=25000)能大大降低再次触发的概率。
// 可重复运行:已成功发过的邮箱记在 state/survey-mail-log.json 里,重跑会跳过,不会给同一人发两遍。

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mailerOn, sendMail } from "./lib/mailer.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const LIST_PATH = join(__dir, "state", "survey-emails.json");
const LOG_PATH = join(__dir, "state", "survey-mail-log.json");
const dry = process.argv.includes("--dry");
const delayArg = process.argv.find(a => a.startsWith("--delay="));
const DELAY_MS = delayArg ? Math.max(1000, Number(delayArg.slice(8)) || 3000) : 3000;

const SUBJECT = "ArtPortal 正式上线了 —— 感谢你参与过我们的问卷";
const TEXT =
`你好,

几周前你参与过 ArtPortal 的一份小调查,提到过找展览/项目机会时的困扰——信息分散、优质机会靠内推、发现时常常已经过了截止日期、水展太多筛选费时间。

ArtPortal 现在正式上线了:https://artportal123.com

目前做到的:
· 每天自动更新全球范围的展览征集、驻留、奖项、工作坊等机会,信息来自机构官网原文,不是转载凑数
· 默认隐藏已截止的机会,不用一条条点开才发现过期
· 支持 AI 自然语言检索,直接搜你想找的方向
· 找到的机会尽量直达主办方官网,不绕经二手聚合站
· 可以登录收藏想申请的机会,方便后续跟进

你在问卷里提到的"智能匹配赛道""一键投递""含金量评估"这些还在打磨,有进展会再同步。

如果不想再收到类似更新邮件,直接回复这封邮件说"退订"就行。

ArtPortal`;

const HTML =
`<div style="font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:15px;line-height:1.8;color:#333;max-width:560px">
<p>你好,</p>
<p>几周前你参与过 ArtPortal 的一份小调查,提到过找展览/项目机会时的困扰——信息分散、优质机会靠内推、发现时常常已经过了截止日期、水展太多筛选费时间。</p>
<p>ArtPortal 现在正式上线了:<a href="https://artportal123.com" style="color:#2a6f97">https://artportal123.com</a></p>
<p>目前做到的:</p>
<ul style="padding-left:20px">
<li>每天自动更新全球范围的展览征集、驻留、奖项、工作坊等机会,信息来自机构官网原文,不是转载凑数</li>
<li>默认隐藏已截止的机会,不用一条条点开才发现过期</li>
<li>支持 AI 自然语言检索,直接搜你想找的方向</li>
<li>找到的机会尽量直达主办方官网,不绕经二手聚合站</li>
<li>可以登录收藏想申请的机会,方便后续跟进</li>
</ul>
<p>你在问卷里提到的"智能匹配赛道""一键投递""含金量评估"这些还在打磨,有进展会再同步。</p>
<p>如果不想再收到类似更新邮件,直接回复这封邮件说"退订"就行。</p>
<p>ArtPortal</p>
</div>`;

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch (e) { return fallback; }
}

async function main() {
  const list = readJson(LIST_PATH, []);
  const log = readJson(LOG_PATH, { sent: {}, failed: {} });
  if (!list.length) { console.error("名单为空:" + LIST_PATH); process.exit(1); }
  if (!dry && !mailerOn()) { console.error("发信未配置(.env 缺 SMTP_HOST/USER/PASS),中止。"); process.exit(1); }

  const todo = list.filter(e => !log.sent[e]);
  console.log(`总名单 ${list.length} 个,已发过 ${list.length - todo.length} 个,本次待发 ${todo.length} 个,间隔 ${DELAY_MS}ms${dry ? "(--dry 演习,不真发)" : ""}`);

  let ok = 0, fail = 0, consecutiveLimit = 0;
  for (const email of todo) {
    if (dry) { console.log("  [演习] " + email); continue; }
    try {
      await sendMail({ to: email, subject: SUBJECT, text: TEXT, html: HTML });
      log.sent[email] = new Date().toISOString();
      ok++; consecutiveLimit = 0;
      console.log("  ✓ " + email);
    } catch (e) {
      const msg = String(e.message || e);
      log.failed[email] = { at: new Date().toISOString(), err: msg };
      fail++;
      console.log("  ✗ " + email + " —— " + msg.slice(0, 120));
      // 还在被限速就别硬顶着发——连续 3 次同类失败直接停,免得越拦越久,下次调大 --delay 再试
      if (/frequency limit|535/.test(msg)) { consecutiveLimit++; if (consecutiveLimit >= 3) { console.log("连续 3 次被限速,提前停止,过会儿加大 --delay 重试。"); break; } }
      else consecutiveLimit = 0;
    }
    writeFileSync(LOG_PATH, JSON.stringify(log, null, 2), "utf8");   // 每封都落盘,中断也不丢进度
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  console.log(dry ? "演习结束。" : `发送完成:成功 ${ok},失败 ${fail}。`);
}

main().catch(e => { console.error("脚本异常:", e); process.exit(1); });
