// sms.mjs —— 阿里云短信(Dysmsapi)验证码,零第三方依赖(自实现 RPC v1 签名)。
// 用途:手机号短信验证码(注册实名 / 老用户绑定手机号)。备案安全评估「真实身份核验」落地。
//
// 配置(server 的 .env,配齐即自动启用手机号实名;缺任一 → smsOn()=false,注册退回邮箱模式):
//   SMS_ACCESS_KEY_ID=LTAI....         阿里云 AccessKey ID(建议 RAM 子账号,仅授权 AliyunDysmsFullAccess)
//   SMS_ACCESS_KEY_SECRET=****         AccessKey Secret
//   SMS_SIGN_NAME=你的签名             已审核通过的短信签名名称(如主体/网站名)
//   SMS_TEMPLATE_CODE=SMS_123456789    已审核通过的验证码模板 CODE(模板正文须含 ${code})
//   SMS_REGION=cn-hangzhou             (可省)
//   SMS_DEBUG=1(仅本地调试):不真发,验证码打印到 stderr。生产绝不可设。

import { createHmac, randomBytes } from "node:crypto";

export function smsOn() {
  return process.env.SMS_DEBUG === "1" ||
    !!(process.env.SMS_ACCESS_KEY_ID && process.env.SMS_ACCESS_KEY_SECRET &&
       process.env.SMS_SIGN_NAME && process.env.SMS_TEMPLATE_CODE);
}

// 阿里云口径的 RFC3986 百分号编码(等价 Java URLEncoder 后修正 +/*/~)
function pct(s) {
  return encodeURIComponent(String(s))
    .replace(/\+/g, "%20").replace(/\*/g, "%2A").replace(/%7E/g, "~")
    .replace(/[!'()]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// 调 SendSms;成功 resolve,失败 reject(调用方决定重试/降级)。RPC v1 签名 = HMAC-SHA1。
async function sendSms(phone, templateParam) {
  const params = {
    AccessKeyId: process.env.SMS_ACCESS_KEY_ID,
    Action: "SendSms",
    Format: "JSON",
    PhoneNumbers: phone,
    RegionId: process.env.SMS_REGION || "cn-hangzhou",
    SignName: process.env.SMS_SIGN_NAME,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomBytes(16).toString("hex"),
    SignatureVersion: "1.0",
    TemplateCode: process.env.SMS_TEMPLATE_CODE,
    TemplateParam: JSON.stringify(templateParam),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-05-25",
  };
  const canon = Object.keys(params).sort().map(k => pct(k) + "=" + pct(params[k])).join("&");
  const stringToSign = "GET&" + pct("/") + "&" + pct(canon);
  const sig = createHmac("sha1", process.env.SMS_ACCESS_KEY_SECRET + "&").update(stringToSign).digest("base64");
  const url = "https://dysmsapi.aliyuncs.com/?Signature=" + pct(sig) + "&" + canon;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (j.Code !== "OK") throw new Error("aliyun-sms " + (j.Code || res.status) + ": " + (j.Message || "").slice(0, 120));
  return j;
}

export async function sendSmsCode(phone, code) {
  if (process.env.SMS_DEBUG === "1") {
    process.stderr.write("[sms-debug] " + phone + " 验证码 " + code + "\n");
    return;
  }
  await sendSms(phone, { code });
}
