// sms.mjs —— 阿里云「号码认证服务(PNVS)」短信认证,个人免资质,零第三方依赖(自实现 RPC v1 签名)。
// 用途:手机号短信验证码(注册实名 / 老用户绑定手机号)。备案安全评估「真实身份核验」落地。
//
// 机制:验证码由阿里云生成并校验——SendSmsVerifyCode 发码、CheckSmsVerifyCode 验码。
//   个人账号免资质:用短信认证「参数配置」里的系统赠送签名 + 系统赠送模板(免申请签名/模板)。
//   接口 dypnsapi.aliyuncs.com,Version 2017-05-25,RPC v1 签名 = HMAC-SHA1。
//
// 配置(server 的 .env,配齐即自动启用手机号实名;缺任一 → smsOn()=false,注册退回邮箱模式):
//   SMS_ACCESS_KEY_ID=LTAI....         阿里云 AccessKey ID(建议 RAM 子账号,授权 AliyunDypnsFullAccess)
//   SMS_ACCESS_KEY_SECRET=****         AccessKey Secret
//   SMS_SIGN_NAME=恒创联众             系统赠送签名名称(短信认证参数配置→签名配置→赠送签名)
//   SMS_TEMPLATE_CODE=100001           系统赠送模板 CODE(100001=登录/注册模板,正文含 ${code}${min})
//   SMS_REGION=cn-hangzhou             (可省)
//   SMS_DEBUG=1(仅本地调试):不真发,验证码固定 000000(sendSmsCode 打印、checkSmsCode 只放行 000000)。生产绝不可设。

import { createHmac, randomBytes } from "node:crypto";

const DEBUG_CODE = "000000";
const VALID_SECONDS = 300;   // 验证码有效期,与模板 ${min} 联动(min = VALID_SECONDS/60)

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

// 通用 RPC v1 调用(GET + Signature 查询参数)。成功返回解析后的 JSON,失败抛错(调用方决定重试/降级)。
async function rpc(action, extra) {
  const params = {
    AccessKeyId: process.env.SMS_ACCESS_KEY_ID,
    Action: action,
    Format: "JSON",
    RegionId: process.env.SMS_REGION || "cn-hangzhou",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: randomBytes(16).toString("hex"),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2017-05-25",
    ...extra,
  };
  const canon = Object.keys(params).sort().map(k => pct(k) + "=" + pct(params[k])).join("&");
  const stringToSign = "GET&" + pct("/") + "&" + pct(canon);
  const sig = createHmac("sha1", process.env.SMS_ACCESS_KEY_SECRET + "&").update(stringToSign).digest("base64");
  const url = "https://dypnsapi.aliyuncs.com/?Signature=" + pct(sig) + "&" + canon;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await res.json().catch(() => ({}));
  if (j.Code !== "OK") throw new Error("aliyun-pnvs " + (j.Code || res.status) + ": " + (j.Message || "").slice(0, 120));
  return j;
}

// 发送验证码(阿里云生成并记忆,有效期 VALID_SECONDS)。成功 resolve,失败 reject。
export async function sendSmsCode(phone) {
  if (process.env.SMS_DEBUG === "1") {
    process.stderr.write("[sms-debug] " + phone + " 验证码 " + DEBUG_CODE + "\n");
    return;
  }
  await rpc("SendSmsVerifyCode", {
    PhoneNumber: phone,
    SignName: process.env.SMS_SIGN_NAME,
    TemplateCode: process.env.SMS_TEMPLATE_CODE,
    TemplateParam: JSON.stringify({ code: "##code##", min: String(Math.round(VALID_SECONDS / 60)) }),
    CodeLength: "6",
    ValidTime: String(VALID_SECONDS),
    Interval: "60",              // 同号两次发送最小间隔(秒),阿里云侧防刷
    DuplicatePolicy: "1",        // 间隔内重复请求返回上次结果,不重复发
  });
}

// 校验验证码。返回 true=通过,false=不通过(错/过期/未发)。异常向上抛(调用方兜底)。
export async function checkSmsCode(phone, code) {
  code = String(code || "").trim();
  if (!/^\d{4,6}$/.test(code)) return false;
  if (process.env.SMS_DEBUG === "1") return code === DEBUG_CODE;
  const j = await rpc("CheckSmsVerifyCode", { PhoneNumber: phone, VerifyCode: code });
  return !!(j.Model && j.Model.VerifyResult === "PASS");
}
