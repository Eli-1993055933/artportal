// mailer.mjs —— 极简 SMTP 发信(TLS 465 + AUTH LOGIN),零第三方依赖。
// 用途:①邮箱验证码(注册)②周报邮件(HTML)。
// 群发大规模化后建议切阿里云 DirectMail —— 它同样提供 SMTP 接口,只需换 .env 里的 SMTP_* 配置,代码不动。
//
// 配置(server 的 .env,配齐即自动启用邮箱验证码):
//   SMTP_HOST=smtp.qq.com          发信服务器(QQ邮箱/163/阿里云 DirectMail SMTP 均可)
//   SMTP_PORT=465                  (可省,默认 465 SSL)
//   SMTP_USER=xxx@qq.com           发信账号
//   SMTP_PASS=****                 授权码(不是登录密码;QQ邮箱:设置→账户→开启SMTP拿授权码)
//   MAIL_FROM=xxx@qq.com           (可省,默认=SMTP_USER)
// 未配置 → mailerOn()=false,注册退化为"域名 MX 校验+一次性邮箱黑名单"的弱校验模式。
// MAIL_DEBUG=1(仅本地调试):不真发信,内容打印到 stderr。生产绝不可设。

import { connect } from "node:tls";

export function mailerOn() {
  return process.env.MAIL_DEBUG === "1" ||
    !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

// RFC 2047:主题里的中文按 UTF-8 base64 编码
function mimeUtf8(s) { return "=?utf-8?B?" + Buffer.from(String(s), "utf8").toString("base64") + "?="; }
function b64wrap(s) { return Buffer.from(s, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"); }

// 通用发信:text 必给(纯文本兜底);html 可选(给了发 multipart/alternative);
// headers 附加头(如 List-Unsubscribe)。发送成功 resolve,失败 reject(调用方决定重试/记录)。
export function sendMail({ to, subject, text, html, headers }) {
  if (process.env.MAIL_DEBUG === "1") {
    process.stderr.write("[mailer-debug] to=" + to + " subject=" + subject + "\n" + String(text).slice(0, 400) + "\n");
    return Promise.resolve();
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const fromName = process.env.MAIL_FROM_NAME || "ARTPORTAL";
  let head =
    "From: " + mimeUtf8(fromName) + " <" + from + ">\r\n" +
    "To: <" + to + ">\r\n" +
    "Subject: " + mimeUtf8(subject) + "\r\n" +
    "MIME-Version: 1.0\r\n";
  for (const k of Object.keys(headers || {})) head += k + ": " + headers[k] + "\r\n";
  let body;
  if (html) {
    const boundary = "=_ap_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    head += 'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n';
    body =
      "--" + boundary + "\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64wrap(text || "") + "\r\n" +
      "--" + boundary + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + b64wrap(html) + "\r\n" +
      "--" + boundary + "--\r\n";
  } else {
    head += "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n";
    body = b64wrap(text || "") + "\r\n";
  }
  // DATA 段以 CRLF.CRLF 结束;正文里的行首句点按 RFC 5321 转义
  const data = head + "\r\n" + body.replace(/\r\n\./g, "\r\n..") + ".\r\n";
  return smtpSend(to, data);
}

function smtpSend(to, data) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST, port = Number(process.env.SMTP_PORT || 465);
    const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
    const from = process.env.MAIL_FROM || user;
    // 对话脚本:[期望状态码, 收到后发送的内容];334 是 AUTH LOGIN 的用户名/密码提示
    const script = [
      [220, "EHLO artportal\r\n"],
      [250, "AUTH LOGIN\r\n"],
      [334, Buffer.from(user).toString("base64") + "\r\n"],
      [334, Buffer.from(pass).toString("base64") + "\r\n"],
      [235, "MAIL FROM:<" + from + ">\r\n"],
      [250, "RCPT TO:<" + to + ">\r\n"],
      [250, "DATA\r\n"],
      [354, data],
      [250, "QUIT\r\n"]          // 发信成功(250)即算完成;QUIT 后不等 221
    ];
    let i = 0, buf = "", done = false;
    const sock = connect({ host, port, servername: host });
    const fail = (e) => { if (done) return; done = true; try { sock.destroy(); } catch (x) {} reject(e instanceof Error ? e : new Error(String(e))); };
    sock.setTimeout(20000, () => fail(new Error("SMTP 超时")));
    sock.on("error", fail);
    sock.on("data", (chunk) => {
      if (done) return;
      buf += chunk.toString("utf8");
      if (!buf.endsWith("\r\n")) return;
      const lines = buf.trim().split("\r\n");
      const last = lines[lines.length - 1];
      if (/^\d{3}-/.test(last)) return;            // 多行响应(250-xxx)还没收完
      buf = "";
      const code = Number(last.slice(0, 3));
      const [expect, send] = script[i];
      if (code !== expect) return fail(new Error("SMTP " + code + "(期望 " + expect + "):" + last.slice(0, 140)));
      i++;
      sock.write(send);
      if (i >= script.length) { done = true; try { sock.end(); } catch (x) {} resolve(); }
    });
  });
}

export async function sendVerifyCode(email, code) {
  if (process.env.MAIL_DEBUG === "1") {
    process.stderr.write("[mailer-debug] " + email + " 验证码 " + code + "\n");
    return;
  }
  await sendMail({
    to: email,
    subject: "ArtPortal 邮箱验证码:" + code,
    text: "你正在注册 ArtPortal(全球艺术机会)。\n\n邮箱验证码:" + code + "\n\n10 分钟内有效。若非本人操作,请忽略本邮件。"
  });
}
