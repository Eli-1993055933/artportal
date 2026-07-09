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
    return { opencall: "#C0392B", residency: "#2E6FA7", award: "#C08A1E", workshop: "#6B5B95" }[cat] || "#8A8A85";
  };
  // 降级色块首字母:优先英文域名首字母,否则机构中文首字
  F.initial = function (o) {
    if (o.domain) return o.domain.charAt(0).toUpperCase();
    if (o.org_zh) return o.org_zh.charAt(0);
    return "?";
  };

  // 供搜索用:把一条的可搜文本拼起来
  F.searchText = function (o) {
    var parts = [o.title_zh, o.title_en, o.org_zh, o.city_zh, o.country_zh, o.summary_zh];
    if (o.disciplines) parts = parts.concat(o.disciplines);
    return parts.filter(Boolean).join(" ").toLowerCase();
  };
})();
