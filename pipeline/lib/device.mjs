// device.mjs —— User-Agent / Client Hints → 设备信息(零第三方依赖)
// 用途:后台展示访客正在用什么设备,尽量具体到机型(iPhone 代际 / 安卓型号 / 电脑系统)。
// 反幻觉红线:只认 UA / 高熵里真实出现的片段,绝不编造。具体型号一律来自三处确定来源——
//    ① iPhone 官方 typeCode 表(Apple 公开,code→商业名,见 IPHONE_CODES);
//    ② 前端高熵 model(浏览器自己报的厂商 marketing 名 / 型号码);
//    ③ UA 里真实存在的型号码(Build/ 前的字段)。
//     未命中任何映射时,如实只显示能确认的部分(例如只报 iOS 16 版本,不猜是哪一代 iPhone;
//     型号码不变也不给它编个中文名)。
// macOS/Windows 硬件型号(如 MacBook 13、ThinkPad X1)浏览器不暴露,如实只能到系统版本,绝不补。
//
// 输出 shape:{ kind, brand, model, os, os_ver, browser, label }
//   kind: iphone / android / phone / tablet / desktop;label = 给后台看的一行摘要。

// —— 品牌正则(作用于整条 UA;越前的越优先)——
const BRAND = [
  [/iPhone/i, "iPhone"], [/iPad/i, "iPad"], [/Macintosh|Mac OS X/i, "Apple"],
  [/Huawei|Honor|问界/i, "华为"], [/Xiaomi|Redmi|POCO|Mi (Pad|Note|Max)\b/i, "小米"],
  [/OPPO|Realme|OnePlus|oplus|CPH/i, "OPPO"], [/vivo|iQOO/i, "vivo"],
  [/SAMSUNG|SM-[A-Z]/i, "三星"], [/Pixel|Nexus/i, "Google"], [/Meizu/i, "魅族"],
  [/Lenovo|ThinkPad/i, "联想"], [/Dell/i, "戴尔"], [/HP;|Hewlett/i, "惠普"],
  [/ASUS/i, "华硕"], [/Acer/i, "宏碁"], [/SONY/i, "索尼"], [/ROG|Razer/i, "雷蛇"]
];

// —— iPhone 官方型号码(typeCode)→ 商业名。来源:Apple 公开的 device identifier,人工核实。
//    只收录已发布且映射确定的型号;未收录的 code 如实只显示码,不猜代际。 ——
const IPHONE_CODES = {
  "iPhone1,1": "iPhone 2G", "iPhone1,2": "iPhone 3G", "iPhone2,1": "iPhone 3GS",
  "iPhone3,1": "iPhone 4", "iPhone3,2": "iPhone 4", "iPhone3,3": "iPhone 4",
  "iPhone4,1": "iPhone 4S",
  "iPhone5,1": "iPhone 5", "iPhone5,2": "iPhone 5", "iPhone5,3": "iPhone 5c", "iPhone5,4": "iPhone 5c",
  "iPhone6,1": "iPhone 5s", "iPhone6,2": "iPhone 5s",
  "iPhone7,2": "iPhone 6", "iPhone7,1": "iPhone 6 Plus",
  "iPhone8,1": "iPhone 6s", "iPhone8,2": "iPhone 6s Plus", "iPhone8,4": "iPhone SE(一代)",
  "iPhone9,1": "iPhone 7", "iPhone9,3": "iPhone 7", "iPhone9,2": "iPhone 7 Plus", "iPhone9,4": "iPhone 7 Plus",
  "iPhone10,1": "iPhone 8", "iPhone10,4": "iPhone 8", "iPhone10,2": "iPhone 8 Plus", "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X", "iPhone10,6": "iPhone X",
  "iPhone11,8": "iPhone XR", "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max",
  "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
  "iPhone12,8": "iPhone SE(二代)",
  "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE(三代)",
  "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e"
};

// —— 安卓常见型号码(UA Build/ 或高熵 model 中)→ 中文机型名。
//    只收录人工核实过、能确定对应关系的常用机型;未收录的码绝不命名、如实保留原文。
//    现代安卓浏览器给高熵 model 时多为厂商 marketing 名(如 "Pixel 8")或型号码,命中的覆盖本表。 ——
const ANDROID_MODEL = {
  // Google Pixel(UA 常直接给 marketing 名,这里兜底数字版本)
  "Pixel 9 Pro XL": "Google Pixel 9 Pro XL", "Pixel 9 Pro": "Google Pixel 9 Pro",
  "Pixel 9": "Google Pixel 9", "Pixel 9 Pro Fold": "Google Pixel 9 Pro Fold",
  "Pixel 8 Pro": "Google Pixel 8 Pro", "Pixel 8": "Google Pixel 8", "Pixel 8a": "Google Pixel 8a",
  "Pixel 8 Fold": "Google Pixel Fold", "Pixel 7 Pro": "Google Pixel 7 Pro", "Pixel 7": "Google Pixel 7",
  "Pixel 6 Pro": "Google Pixel 6 Pro", "Pixel 6": "Google Pixel 6",
  // 三星(型号码前缀精确到"代",后缀变化不影响对用户展示)
  "SM-S921": "三星 Galaxy S24", "SM-S928": "三星 Galaxy S24 Ultra", "SM-S911": "三星 Galaxy S23", "SM-S918": "三星 Galaxy S23 Ultra",
  "SM-S901": "三星 Galaxy S22", "SM-S908": "三星 Galaxy S22 Ultra", "SM-G991": "三星 Galaxy S21", "SM-G998": "三星 Galaxy S21 Ultra",
  "SM-S711": "三星 Galaxy S23 FE", "SM-S721": "三星 Galaxy S24 FE", "SM-F946": "三星 Galaxy Z Fold6", "SM-F956": "三星 Galaxy Z Flip6"
};

export function parseDevice(ua, hintModel) {
  ua = String(ua || "");
  const hm = String(hintModel || "").trim();
  const iphoneCode = hm.match(/^iPhone[0-9]+,[0-9]+$/i) ? hm : "";
  const androidHint = /Android/i.test(ua) && !iphoneCode ? hm : "";   // 安卓才用高熵 model

  // —— 品牌 ——
  let brand = "";
  if (iphoneCode) brand = "iPhone";
  else for (const [re, b] of BRAND) if (re.exec(ua)) { brand = b; break; }
  // Android 型号码兜底品牌:UA 以 "Mozilla/…" 开头,带 ^ 锚定的机型码正则打不中,拿型号再来一遍。
  let model = androidHint;
  if (iphoneCode) model = IPHONE_CODES[hm] || hm;
  else if (/iPhone|iP[ao]d/i.test(ua) && /iPhone/i.test(hm)) model = hm;            // iOS 高熵直接给 marketing 名
  else if (!model && /Android/i.test(ua)) {
    const m = /; ([A-Za-z0-9][A-Za-z0-9\- _]{1,18}) Build\//.exec(ua);
    if (m) { const c = m[1].trim(); if (c.length <= 26) model = c; }
  }
  if (brand && model && /^[0-9]{4}/.test(model)) {
    for (const [re, b] of BRAND) if (re.test(model)) { brand = b; break; }   // 数字码兜底:已命中品牌则扩准确品牌
  }
  // 安卓型号码 → 具体机型名:先精确匹配,再按前缀匹配(型号码常带后缀,如 SM-S911B 命中 SM-S911)。
  // 命中的本表项自带完整机型名,把品牌清空以免 label 出现"三星 · 三星 Galaxy"重复。
  if (model) {
    let key = ANDROID_MODEL[model];
    if (!key) { const ks = Object.keys(ANDROID_MODEL).filter(k => model.indexOf(k) === 0).sort((a, b) => b.length - a.length); if (ks[0]) key = ANDROID_MODEL[ks[0]]; }
    if (key) { model = key; brand = ""; }
  }

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
    if (v) os_ver = { "10.0": "11/10", "6.3": "8.1", "6.2": "8", "6.1": "7", "6.0": "Vista" }[v[1]] || v[1];
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
  else if (/Edg/i.test(ua)) browser = "Edge";
  else if (/OPR\//i.test(ua)) browser = "Opera";
  else if (/Chrome/i.test(ua)) browser = "Chrome";
  else if (/Firefox/i.test(ua)) browser = "Firefox";
  else if (/Safari/i.test(ua)) browser = "Safari";

  // —— 设备类型(精确到 iphone/android 便于后台归类)——
  let kind = "desktop";
  if (iphoneCode || /iPhone/i.test(ua)) kind = "iphone";
  else if (/iP[ao]d|Tablet|Silk/i.test(ua)) kind = "tablet";
  else if (/Android/i.test(ua)) kind = /tablet|Silk/i.test(ua) ? "tablet" : "android";
  else if (/Mobi|Windows Phone/i.test(ua)) kind = "phone";
  else if (/Linux|CrOS/i.test(ua)) kind = "desktop";

  // —— 摘要(自动去重:品牌与型号同词时只留型号,如 "iPhone 16 Pro Max" 不再重复 "iPhone")——
  let bi = brand || "", mv = model || "";
  if (bi && mv && mv.toLowerCase().startsWith(bi.toLowerCase())) bi = "";
  const label = [kindName(kind), bi, mv, osName, os_ver, browser].filter(Boolean).join(" · ") || "未知设备";
  return { kind, brand: brand || null, model: model || null, os: osName || null, os_ver: os_ver || null, browser: browser || null, label };
}
export function deviceLabel(ua, hintModel) { return parseDevice(ua, hintModel).label; }
function kindName(k) { return k === "iphone" ? "手机" : k === "android" ? "安卓" : k === "tablet" ? "平板" : k === "desktop" ? "电脑" : "手机"; }