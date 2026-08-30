// device.mjs —— User-Agent → 设备信息(零第三方依赖)
// 用途:后台展示访客正在用什么设备(手机品牌型号 / 电脑系统)。
// 原则:只解析 UA 里真实存在的片段,绝不编造。
//   · iPhone/iPad:UA 只含"iOS 版本",具体代际(15/14 等)UA 里没有,靠前端高熵字段(hintModel)补,拿不到就只报版本。
//   · Android 手机:UA 常带型号码(如 Pixel 8 Build / 23127PN0CC Build),品牌靠 brands 表定位。
//   · 电脑:能识别 Windows/macOS 版本,部分能带品牌(ThinkPad/ASUS 等)。
// 输出 shape:{ kind, brand, model, os, os_ver, browser, label }
//   kind: phone / tablet / desktop ;label = 给后台看的一行摘要。

const BRAND = [
  [/iPhone/i, "iPhone"], [/iPad/i, "iPad"], [/Macintosh|Mac OS X/i, "Apple"],
  [/Huawei|Honor/i, "华为"], [/Xiaomi|Redmi/i, "小米"], [/Mi (Pad|Note|Max)\b/i, "小米"],
  [/^2212|^2206|^2101|^20[12][0-9]|^2304/i, "小米"], [/2310|2311RN/i, "小米"],
  [/OPPO|Realme|1?oplus|OnePlus|CPH/i, "OPPO"], [/vivo|V[i2][0-9]{3}|iQOO/i, "vivo"],
  [/SAMSUNG|SM-[A-Z]/i, "三星"], [/Pixel|Nexus/i, "Google"], [/Meizu/i, "魅族"],
  [/Lenovo|ThinkPad/i, "联想"], [/Dell/i, "戴尔"], [/HP;|Hewlett/i, "惠普"],
  [/ASUS/i, "华硕"], [/Acer/i, "宏碁"]
];

export function parseDevice(ua, hintModel) {
  ua = String(ua || "");
  // —— 品牌 ——
  let brand = "";
  for (const [re, b] of BRAND) if (re.exec(ua)) { brand = b; break; }

  // —— 系统与版本 ——
  let osName = "", os_ver = "";
  if (/iPhone|iP[ao]d|CPU iPhone OS/i.test(ua)) {
    osName = /iPad/.test(ua) ? "iPadOS" : "iOS";
    const v = /(?:CPU |OS) ([\d_]+)/.exec(ua); if (v) os_ver = v[1].replace(/_/g, ".");
  } else if (/Android/i.test(ua)) {
    osName = "Android";
    const v = /Android ([\d.]+)/.exec(ua); if (v) os_ver = v[1];
  } else if (/Windows NT/i.test(ua)) {
    osName = "Windows";
    const v = /Windows NT ([\d.]+)/.exec(ua);
    if (v) os_ver = { "10.0": "11/10", "6.3": "8.1", "6.2": "8", "6.1": "7" }[v[1]] || v[1];
  } else if (/Mac OS X/i.test(ua)) {
    osName = "macOS";
    const v = /Mac OS X ([\d._]+)/.exec(ua); if (v) os_ver = v[1].replace(/_/g, ".");
  } else if (/Linux|CrOS|Ubuntu/i.test(ua)) {
    osName = /CrOS/i.test(ua) ? "ChromeOS" : "Linux";
  }

  // —— 浏览器 ——
  let browser = "";
  if (/(MicroMessenger)/i.test(ua)) browser = "微信内置";
  else if (/QQ\//i.test(ua) || /QQBrowser/i.test(ua)) browser = "QQ";
  else if (/UBrowser/i.test(ua)) browser = "UC";
  else if (/MiuiBrowser/i.test(ua)) browser = "小米浏览器";
  else if (/Edge/i.test(ua)) browser = "Edge";
  else if (/OPR\//i.test(ua)) browser = "Opera";
  else if (/Chrome/i.test(ua)) browser = "Chrome";
  else if (/Firefox/i.test(ua)) browser = "Firefox";
  else if (/Safari/i.test(ua)) browser = "Safari";

  // —— 设备类型 ——
  let kind = "desktop";
  if (/iPhone|iPad|iP[ao]d|Android|Windows Phone|Mobi|Andriod/i.test(ua)) kind = /iPad|Tablet|Silk/i.test(ua) ? "tablet" : "phone";
  else if (/Tablet|Silk/i.test(ua)) kind = "tablet";

  // —— 型号:优先前端高熵;Android 从 UA 抓型号码 ——
  let model = "";
  if (hintModel) model = String(hintModel).trim();
  else if (/Android/i.test(ua)) {
    const m = /; ([A-Za-z0-9][A-Za-z0-9\- _]{1,18}) Build\//.exec(ua);
    if (m) { const c = m[1].trim(); if (c.length <= 20) model = c; }
  }
  // 品牌兜底:UA 以 "Mozilla/…" 开头,带 ^ 锚定的机型码正则永远打不中;
  // 改拿抓到的型号(如 23127PN0CC)再来匹配一次,小米等假名手机上这项命中很干净。
  if (!brand && model) {
    for (const [re, b] of BRAND) {
      if (/^[0-9]{4}/.test(model) && re.test(model)) { brand = b; break; }  // 仅对纯数字开头机型码做兜底,避免误伤
    }
  }

  // iOS 无具体代际(除非前端给了 hintModel),报 iOS 版本即可。
  const label = [kindName(kind), brand, model, osName, os_ver, browser].filter(Boolean).join(" · ") || "未知设备";
  return { kind, brand: brand || null, model: model || null, os: osName || null, os_ver: os_ver || null, browser: browser || null, label };
}
export function deviceLabel(ua, hintModel) { return parseDevice(ua, hintModel).label; }
function kindName(k) { return k === "phone" ? "手机" : k === "tablet" ? "平板" : k === "desktop" ? "电脑" : "未知"; }