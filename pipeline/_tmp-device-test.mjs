import { parseDevice } from "./lib/device.mjs";
function p(ua, h) { const d = parseDevice(ua, h || null); console.log((d.label + "  [kind=" + d.kind + " brand=" + d.brand + " model=" + d.model + " os=" + d.os + " " + d.os_ver + "]").padEnd(110) + " <- " + (h ? "(高熵 " + h + ") " : "") + ua); }
console.log("===== iPhone 具体代际(靠高熵 typeCode)=====");
p("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15", "iPhone17,2");   // iPhone 16 Pro Max
p("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "iPhone15,2");   // iPhone 14 Pro
p("Mozilla/5.0 (iPhone; CPU iPhone OS 16_1 like Mac OS X) AppleWebKit/605.1.15", "iPhone14,5");   // iPhone 13
p("Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15", null);           // 无高熵,手机 Safari → 只能 iOS 版本
p("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", "iPhone18,4");                        // 未来机型码未收录 → 如实只显示码
console.log("===== 安卓具体型号 =====");
p("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240505.004) AppleWebKit/537.36", "Pixel 8");    // Google Pixel 8
p("Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A) AppleWebKit/537.36");                          // Galaxy S23
p("Mozilla/5.0 (Linux; Android 13; 23127PN0CC Build/TKQ1) AppleWebKit/537.36");                        // 小米码,不在表 → 如实显示码
p("Mozilla/5.0 (Linux; Android 15; 24071FAB8C Build/UP1A) AppleWebKit/537.36");                        // 小米/红米 码,如实显示码
p("Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A) AppleWebKit/537.36 Mobile");                   // Galaxy S21
p("Mozilla/5.0 (Linux; Android 14; V2301A Build/UP1A) AppleWebKit/537.36");                            // vivo 码,如实
p("Mozilla/5.0 (Linux; Android 14; 24072PX77G Build/UP1A) AppleWebKit/537.36 OPPO");                   // OPPO 码
console.log("===== 电脑(系统级,型号浏览器不暴露)=====");
p("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126");
p("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15");
p("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome", "Mac");
console.log("===== 平板 =====");
p("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Safari/605.1.15", "iPad14,1");
p("Mozilla/5.0 (Linux; Android 14; Pixel Tablet Build/UP1A) AppleWebKit/537.36");