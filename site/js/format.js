/* 格式化与"防误导"显示逻辑集中在这里。
   规则要点(需求第五/六节):
   - 任何字段 null 一律显示"未注明",绝不出现 undefined/null/空白。
   - 费用:apply_fee 与 participation_fee 分开;费用 null ≠ 免费。
   - 截止日期用相对时间 + 颜色分级。
*/
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var F = AP.format = {};

  // HTML 转义,防止数据里的尖括号破坏结构
  F.esc = function (s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  // 双语字段选择:EN 界面优先 *_en(机器翻译或原文),缺则回退 *_zh;中文界面反之。
  // 绝不因缺翻译而显示空白。
  F.loc = function (o, base) {
    var zh = o[base + "_zh"], en = o[base + "_en"];
    return AP.lang === "en" ? (en || zh || "") : (zh || en || "");
  };

  // 今天(本地),用于相对天数与过期判断
  F.today = function () {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };
  F.parseDate = function (str) {
    if (!str) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  };
  F.daysUntil = function (dateStr) {
    var d = F.parseDate(dateStr);
    if (!d) return null;
    return Math.round((d - F.today()) / 86400000);
  };
  // 供筛选用:该条是否已过期(deadline 已过)
  F.isExpired = function (o) {
    if (o.status === "expired") return true;
    var n = F.daysUntil(o.deadline);
    return n != null && n < 0;
  };

  // 条目三态:open(正在开放,含常年)/ upcoming(本届已过但周期可推算下届 → 即将开启)/ past(过往项目)
  F.itemState = function (o) {
    if (!F.isExpired(o)) return "open";
    if (F.cadence(o)) return "upcoming";
    return "past";
  };

  // 截止日期渲染 → { text, cls }
  F.deadline = function (o) {
    if (o.deadline == null) return { text: AP.t("rolling"), cls: "due-none" };
    var n = F.daysUntil(o.deadline);
    if (n == null) return { text: AP.t("notStated"), cls: "due-none" };
    if (n < 0) return { text: AP.t("expired") + " · " + o.deadline, cls: "due-expired" };
    if (n === 0) return { text: AP.t("today"), cls: "due-today" };
    if (AP.lang === "en") {
      if (n <= 7) return { text: n + " " + AP.t("days"), cls: "due-urgent" };
      if (n <= 30) return { text: n + " " + AP.t("days"), cls: "due-soon" };
      return { text: o.deadline + " · " + AP.t("leftDays") + " " + n + "d", cls: "due-normal" };
    }
    if (n <= 7) return { text: AP.t("left") + " " + n + " " + AP.t("days"), cls: "due-urgent" };
    if (n <= 30) return { text: AP.t("left") + " " + n + " " + AP.t("days"), cls: "due-soon" };
    return { text: o.deadline + " · " + AP.t("leftDays") + " " + n + " " + AP.t("days"), cls: "due-normal" };
  };

  var CUR = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥", TWD: "NT$" };
  F.money = function (amount, currency) {
    var sym = CUR[currency] || (currency ? currency + " " : "");
    return sym + amount;
  };

  // 是否"完全免费":申请免费 且 明确无参展费。用于筛选与徽章。
  F.isFullyFree = function (o) {
    return !!(o.apply_fee && o.apply_fee.free === true &&
              o.participation_fee && o.participation_fee.required === false);
  };

  // 费用徽章数组 → [{cls,text}]
  F.feeBadges = function (o) {
    var out = [];
    var a = o.apply_fee || {};
    var p = o.participation_fee || {};
    // 申请费一档
    if (a.free === true) {
      out.push({ cls: "badge--free", text: AP.t("free") });
    } else if (a.free === false) {
      out.push({ cls: "badge--fee", text: (a.amount != null && a.amount > 0) ? (AP.t("applyFee") + " " + F.money(a.amount, a.currency)) : AP.t("applyFee") });
    } else {
      out.push({ cls: "badge--unknown", text: AP.t("feeUnknown") });
    }
    // 入选后付费(最重要的警示) —— 仅在明确 required 时显示
    if (p.required === true) {
      var t = AP.t("partFeeWarn");
      if (p.amount != null && p.amount > 0) t += " " + F.money(p.amount, p.currency);
      out.push({ cls: "badge--partfee", text: t });
    }
    return out;
  };

  // 资助徽章:只在明确 true 时显示
  F.fundingBadges = function (o) {
    var out = [], f = o.funding || {};
    if (f.stipend === true) out.push(AP.t("fundStipend"));
    if (f.housing === true) out.push(AP.t("fundHousing"));
    if (f.travel === true) out.push(AP.t("fundTravel"));
    return out;
  };

  // 地区归类(需求第六节六大区)
  F.region = function (o) {
    var c = o.country_zh || "";
    var city = o.city_zh || "";
    if (/香港|澳门|台湾|台北|高雄/.test(c) || /香港|澳门|台北|高雄|台中|台南/.test(city)) return "hktw";
    if (c === "中国") return "cn";
    if (/日本|韩国|新加坡|印度|泰国|越南|马来|菲律宾|印尼|蒙古|哈萨克/.test(c)) return "asia";
    if (/法国|德国|荷兰|英国|意大利|西班牙|瑞士|比利时|奥地利|斯洛文尼亚|瑞典|挪威|芬兰|丹麦|波兰|葡萄牙|捷克|匈牙利|希腊|爱尔兰|冰岛|克罗地亚/.test(c)) return "europe";
    if (/美国|加拿大|墨西哥/.test(c)) return "namerica";
    return "other";
  };

  // 分类主色(用于无图时的降级色块)
  F.catColor = function (cat) {
    return { opencall: "#C0392B", residency: "#2E6FA7", award: "#C08A1E", workshop: "#6B5B95", predict: "#B77410", news: "#1E8A8A", jobs: "#2E8B57" }[cat] || "#8A8A85";
  };
  // 由字符串生成稳定哈希(用于降级色块按条目区分深浅,避免掉图后整排同色)
  function hashOf(s) {
    var h = 0, str = String(s || "x");
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }
  // 降级色块配色:保留分类的色相家族,但按 id 哈希微调明度/饱和度,
  // 让掉图/无封面的卡片各不相同,而不是塌成一排同色块。
  var CAT_HUE = { opencall: 6, residency: 207, award: 40, workshop: 260, news: 182, jobs: 150 };
  F.fallbackColor = function (o) {
    var hue = CAT_HUE[o && o.category];
    if (hue == null) hue = 40;
    var h = hashOf(o && (o.id || o.title_zh));
    var light = 30 + (h % 15);            // 30%–44%
    var sat = 40 + ((h >> 4) % 16);       // 40%–55%
    return "hsl(" + hue + ", " + sat + "%, " + light + "%)";
  };
  // 降级色块首字:优先机构首字(随界面语言取中/英),其次标题,最后域名首字母
  F.initial = function (o) {
    var org = F.loc(o, "org"), title = F.loc(o, "title");
    if (org) return org.charAt(0).toUpperCase();
    if (title) return title.charAt(0).toUpperCase();
    if (o.domain) return o.domain.charAt(0).toUpperCase();
    return "?";
  };

  // 视觉宽度:中日韩全角字算 2,其余算 1(用于标题折行)
  function visWidth(str) { var w = 0; for (var i = 0; i < str.length; i++) w += str.charCodeAt(i) > 255 ? 2 : 1; return w; }
  // 标题折行:中文按字、英文按词,最多 maxLines 行,超出末行加省略号
  function wrapTitle(title, maxLines, maxW) {
    title = String(title || "").trim();
    var lines = [], cur = "";
    var latin = /\s/.test(title) && !/[一-鿿぀-ヿ]/.test(title);
    if (latin) {
      var ws = title.split(/\s+/);
      for (var i = 0; i < ws.length && lines.length < maxLines; i++) {
        var test = cur ? cur + " " + ws[i] : ws[i];
        if (visWidth(test) > maxW && cur) { lines.push(cur); cur = ws[i]; } else cur = test;
      }
    } else {
      for (var j = 0; j < title.length; j++) {
        cur += title.charAt(j);
        if (visWidth(cur) >= maxW) { lines.push(cur); cur = ""; if (lines.length >= maxLines) break; }
      }
    }
    if (cur && lines.length < maxLines) lines.push(cur);
    var consumed = lines.join(latin ? " " : "").length;
    if (lines.length >= maxLines && consumed < title.length) {
      var last = lines[maxLines - 1];
      lines[maxLines - 1] = last.slice(0, Math.max(1, last.length - 1)) + "…";
    }
    return lines.slice(0, maxLines);
  }

  // 无真实封面时:用条目自身信息(标题+类别+主办方)生成一张"设计海报卡"。
  // 任何条目都好看、离线可用、不受境外站访问限制。返回一段可直接内联的 SVG 字符串。
  F.coverArt = function (o) {
    var cat = o && o.category;
    var hue = CAT_HUE[cat]; if (hue == null) hue = 40;
    var h = hashOf(o && (o.id || o.title_zh || "x"));
    var c1 = "hsl(" + hue + "," + (48 + h % 12) + "%," + (33 + h % 9) + "%)";
    var c2 = "hsl(" + ((hue + 22) % 360) + "," + (56 + (h >> 3) % 12) + "%," + (20 + (h >> 2) % 7) + "%)";
    var gid = "g" + (h % 100000);
    var title = F.loc(o, "title") || "";
    var org = F.loc(o, "org") || "";
    var catLabel = (AP.tt[AP.lang] && AP.tt[AP.lang].cat[cat]) || cat || "";
    var initial = F.initial(o);
    var lines = wrapTitle(title, 3, 22);
    // 标题整块垂直居中;字号随行数微调
    var fs = lines.length >= 3 ? 30 : (lines.length === 2 ? 33 : 36);
    var lh = fs + 8;
    var startY = 168 - (lines.length - 1) * lh / 2;
    var titleSvg = "";
    for (var i = 0; i < lines.length; i++) {
      titleSvg += '<text x="34" y="' + (startY + i * lh) + '" fill="#fff" font-size="' + fs +
        '" font-weight="700" font-family="' + SVG_FONT + '">' + F.esc(lines[i]) + '</text>';
    }
    return '<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="' + F.esc(title) + '">' +
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/></linearGradient></defs>' +
      '<rect width="400" height="300" fill="url(#' + gid + ')"/>' +
      // 巨大的半透明首字作为纹理点缀
      '<text x="330" y="250" fill="rgba(255,255,255,0.10)" font-size="240" font-weight="800" text-anchor="middle" font-family="' + SVG_FONT + '">' + F.esc(initial) + '</text>' +
      // 顶部类别标签
      '<text x="34" y="52" fill="rgba(255,255,255,0.9)" font-size="15" font-weight="600" letter-spacing="1" font-family="' + SVG_FONT + '">' + F.esc(catLabel) + '</text>' +
      '<rect x="34" y="62" width="34" height="3" rx="1.5" fill="rgba(255,255,255,0.7)"/>' +
      titleSvg +
      // 底部主办方
      (org ? '<text x="34" y="272" fill="rgba(255,255,255,0.78)" font-size="15" font-family="' + SVG_FONT + '">' + F.esc(org.length > 18 ? org.slice(0, 17) + "…" : org) + '</text>' : "") +
      '</svg>';
  };
  var SVG_FONT = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";

  // 只放行 http(s) 链接落入 href/src,挡住 javascript:/data: 等协议注入(全库唯一 XSS 缺口)
  F.safeUrl = function (u) {
    if (!u) return "";
    return /^https?:\/\//i.test(String(u).trim()) ? u : "";
  };
  // 封面地址:放行 http(s) 外链(og图),也放行我们自己生成的截图相对路径(同源 assets/covers/xxx.jpg)
  F.coverSrc = function (o) {
    var c = o && o.cover; if (!c) return "";
    c = String(c).trim();
    if (/^https?:\/\//i.test(c)) return c;
    if (/^assets\/covers\/[a-z0-9]+\.jpg$/i.test(c)) return c;
    return "";
  };

  // 来源标注:这条是机构官网直采,还是转自某聚合平台。
  var AGG = { "artconnect.com": "ArtConnect", "curatorspace.com": "CuratorSpace", "transartists.org": "TransArtists", "chinaresidencies.com": "China Residencies" };
  F.provenance = function (o) {
    var en = AP.lang === "en";
    // 用户投稿:人工通过后发布,但平台未逐字核实 → 如实标注(诚实红线)
    if (o._via === "submit" || o.trust === "user") {
      return {
        kind: "aggregator", platform: null,
        label: en ? "User submission · unverified" : "用户投稿 · 未经核实",
        detail: en ? "Submitted by a user and approved by a moderator. NOT verified word-by-word by ArtPortal — please confirm on the official site before applying."
                   : "本条由用户投稿、管理员人工通过后发布;平台未逐字核实内容,申请前请务必以官网为准。"
      };
    }
    // 检索(AI 全网搜)来的一律如实标"AI 检索·请核对官网",绝不谎称官网直采
    // (程序无法可靠区分官网/二手,故不硬猜,交由用户点官网核对)
    if (o._via === "search") {
      return {
        kind: "aggregator", platform: null,
        label: en ? "AI web search · verify" : "AI 检索 · 请核对官网",
        detail: en ? "Found by ArtPortal's AI via web search; NOT yet human-confirmed as the organizer's official site. Please verify there before applying."
                   : "本条由 ArtPortal 的 AI 从全网检索到,尚未人工确认为主办方官网(可能来自转载)。请务必点开核对,以官网为准。"
      };
    }
    var name = AGG[o.domain];
    if (name) {
      return {
        kind: "aggregator", platform: name,
        label: en ? ("via " + name) : ("转自 " + name),
        detail: en ? ("Collected by ArtPortal's backend AI from the " + name + " platform. The official link below has been located online where possible.")
                   : ("本条由 ArtPortal 后台 AI 从「" + name + "」平台检索转录;下方「前往官网」已尽量联网定位到主办方官网。")
      };
    }
    return {
      kind: "official", platform: null,
      label: en ? "Official site" : "机构官网直采",
      detail: en ? "Collected by ArtPortal's backend AI directly from the organizer's official website."
                 : "本条由 ArtPortal 后台 AI 从主办机构官网直接检索整理。"
    };
  };
  // 第三方域名(聚合/新闻/门户/社媒)——「前往官网」绝不能落到这里,必须是主办方本站。
  // 与后端 pipeline/lib/aggregators.mjs 保持一致。
  var THIRD_PARTY = [
    "curatorspace.com","artconnect.com","chinaresidencies.com","resartis.org","transartists.org",
    "artenda.net","open-calls.art","artresidencyguide.com","artistcommunities.org","e-flux.com","art-hub.co.uk","artrabbit.com",
    "artforum.com.cn","artealdia.com","leapleapleap.com","artforum.com","artsy.net",
    "news.qq.com","qq.com","chinanews.com.cn","gmw.cn","xinhuanet.com","zijing.com.cn","china.cn","52hrtt.com",
    "people.com.cn","sina.com.cn","sohu.com","163.com","thepaper.cn","artron.net",
    "scribd.com","docin.com","doc88.com",
    "shejijingsai.com","xingxiancn.com","sj33.cn","archcollege.com","cn5v.com","gaoyy.com","chinaawards.net",
    "huaxiajiang.com","zjideas.com","whaleideas.com","yczhansai.com","cnyisai.com","eduzs.org.cn","10100.com",
    "jsmsg.com","zhiliaobiaoxun.com","ogdcn.com","zcool.com.cn","gtn9.com","logohhh.com","arting365.com","68design.net","shijue.me","missku.com",
    "mp.weixin.qq.com","weixin.qq.com","xiaohongshu.com","douyin.com","weibo.com","zhihu.com"
  ];
  F.isThirdParty = function (u) {
    var h; try { h = new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch (e) { return false; }
    for (var i = 0; i < THIRD_PARTY.length; i++) {
      var t = THIRD_PARTY[i];
      if (h === t || h.slice(-(t.length + 1)) === "." + t) return true;
    }
    return false;
  };
  // "前往官网"实际要去的地址:只允许主办方本站。优先 official_url;若原始 url 是第三方则不作为官网返回。
  F.officialUrl = function (o) {
    if (o.official_url && !F.isThirdParty(o.official_url)) return o.official_url;
    if (o.url && !F.isThirdParty(o.url)) return o.url;
    return null;
  };

  // —— 下届开放时间"推算" ——
  // 只对周期明确的复发型展览(双年展=2年/三年展=3年)推算,依据真实的往届截止时间。
  // 结果一律显式标注"推算·以官网为准",绝不当作确定信息(守反误导红线)。
  F.cadence = function (o) {
    var t = (o.title_zh || "") + " " + (o.title_en || "");
    if (/三年展|triennial/i.test(t)) return 3;
    if (/双年展|雙年展|biennial|biennale/i.test(t)) return 2;
    return null;
  };
  // 返回 { year, month, cad } 或 null。以往届截止月份 + 周期滚动到今天之后的下一届。
  F.predictNext = function (o) {
    var cad = F.cadence(o);
    if (!cad) return null;
    var d = F.parseDate(o.deadline);
    if (!d) return null;                       // 无真实参考日期则不推算
    var today = F.today();
    var y = d.getFullYear();
    while (new Date(y, d.getMonth(), d.getDate()) < today) y += cad;   // 滚到今天之后
    if (F.parseDate(o.deadline) >= today) y += cad;                    // 本届仍开放 → 推算再下一届
    return { year: y, month: d.getMonth() + 1, cad: cad };
  };
  // 组装可直接显示的双语文案(自带"以官网为准"免责)
  F.predictLabel = function (o) {
    var p = F.predictNext(o);
    if (!p) return null;
    if (AP.lang === "en") {
      return "Est. next call ~" + p.year + "-" + String(p.month).padStart(2, "0") + " · projected from past editions, verify on official site";
    }
    var cadTxt = p.cad === 3 ? "三年展" : "双年展";
    return "预计下届征集:约 " + p.year + " 年 " + p.month + " 月前后 · " + cadTxt + "据往届推算,以官网为准";
  };

  // 供搜索用:把一条的可搜文本拼起来(中英都收进索引,两种语言都能搜到)
  F.searchText = function (o) {
    var parts = [o.title_zh, o.title_en, o.org_zh, o.org_en, o.city_zh, o.city_en,
                 o.country_zh, o.country_en, o.summary_zh, o.summary_en];
    if (o.disciplines) parts = parts.concat(o.disciplines);
    if (o.disciplines_en) parts = parts.concat(o.disciplines_en);
    return parts.filter(Boolean).join(" ").toLowerCase();
  };
})();
