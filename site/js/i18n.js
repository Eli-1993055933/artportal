/* 中 / EN 文案表。数据本身双语共存;这里只切 UI 标签与少量措辞。 */
(function () {
  "use strict";
  var STR = {
    zh: {
      brandSub: "· 全球艺术机会",
      myFavorites: "我的收藏", submit: "提交机会",
      searchPh: "搜索标题、机构、城市、学科…",
      cat_all: "全部", cat_opencall: "展览征集", cat_residency: "驻留项目", cat_award: "艺术奖项", cat_workshop: "工作坊", cat_predict: "预测展览",
      recurringTag: "周期展", recurringTitle: "双年展/三年展 · 可推算下届开放时间",
      moreFilters: "更多筛选", sortBy: "排序", sort_deadline: "截止由近到远", sort_updated: "最近更新",
      showExpired: "显示已截止",
      f_region: "地区", region_cn: "中国大陆", region_hktw: "港澳台", region_asia: "亚洲其他", region_europe: "欧洲", region_namerica: "北美", region_other: "其他",
      f_fee: "费用", freeOnly: "仅看完全免费",
      f_funding: "资助", fund_stipend: "提供津贴", fund_housing: "提供住宿", fund_travel: "报销路费",
      f_discipline: "学科", f_trust: "信任", verifiedOnly: "仅看已人工核实",
      f_scope: "显示范围", scope_past: "过往项目", scope_upcoming: "即将开启",
      scope_hint: "默认全部显示。取消勾选即可只看正在开放的机会。",
      aiSearch: "✦ 用 AI 全网检索更多真实机会",
      aiSearching: "AI 正在全网检索真实机会…",
      aiSearchNote: "正在抓取机构官网原文并逐字校验,约需 1–2 分钟。只收录真实存在的,绝不编造。",
      aiCancel: "取消",
      clearFilters: "清除筛选", applyFilters: "查看结果",
      empty_title: "没有符合条件的机会", empty_desc: "试试减少筛选条件,或打开“显示已截止”。",
      error_title: "数据加载失败", error_desc: "可能是网络问题。请检查连接后重试。", retry: "重试",
      loadingMore: "加载更多…", back: "返回",
      footer_note: "标注「自动收录」的条目由程序从机构官网抓取,尚未经人工逐条核实。申请前请以官网信息为准。",
      results: "个结果", favEmpty: "还没有收藏。点卡片右上角♡即可收藏。",
      // 卡片/详情
      free: "免费", applyFee: "申请费", feeUnknown: "费用未注明", partFeeWarn: "入选后需付费",
      fundStipend: "有津贴", fundHousing: "含住宿", fundTravel: "报路费",
      trustVerified: "已核实", trustAuto: "自动收录 · 未人工核实",
      rolling: "常年接受申请", today: "今天截止", left: "仅剩", days: "天", leftDays: "还有", expired: "已截止",
      copyLink: "复制链接", gotoSite: "前往官网", copied: "链接已复制",
      copyEmail: "复制", mailCopied: "邮箱已复制", searchAria: "搜索机会",
      autoNotice: "本条由程序自动收录,建议点官网核对后再申请。",
      dOrg: "主办方", dPlace: "地点", dDeadline: "截止", dApplyFee: "申请费", dPartFee: "参展/入选费",
      dFunding: "资助", dEligibility: "申请资格", dDisc: "适用学科", dUrl: "官网", dSource: "信息来源", dSeen: "最后确认存在", dPredict: "下届推算",
      notStated: "未注明", provided: "提供", notProvided: "不提供", none: "无", yes: "是", no: "否",
      stipend: "津贴", housing: "住宿", travel: "路费", students: "学生", age: "年龄", nationality: "国籍",
      reportErr: "信息有误?", reportLink: "反馈给我们", visit: "访问", officialLocated: "官网已联网校正",
      cat: { opencall: "展览征集", residency: "驻留项目", award: "艺术奖项", workshop: "工作坊" },
      org: { official: "官方体制", independent: "独立学术", commercial: "商业机构" }
    },
    en: {
      brandSub: "· Global Art Opportunities",
      myFavorites: "Saved", submit: "Submit an opportunity",
      searchPh: "Search title, organizer, city, discipline…",
      cat_all: "All", cat_opencall: "Open Calls", cat_residency: "Residencies", cat_award: "Awards", cat_workshop: "Workshops", cat_predict: "Recurring",
      recurringTag: "Recurring", recurringTitle: "Biennial/Triennial · next edition can be estimated",
      moreFilters: "More filters", sortBy: "Sort", sort_deadline: "Deadline (soonest)", sort_updated: "Recently updated",
      showExpired: "Show closed",
      f_region: "Region", region_cn: "Mainland China", region_hktw: "HK·MO·TW", region_asia: "Rest of Asia", region_europe: "Europe", region_namerica: "N. America", region_other: "Other",
      f_fee: "Fee", freeOnly: "Fully free only",
      f_funding: "Funding", fund_stipend: "Stipend", fund_housing: "Housing", fund_travel: "Travel",
      f_discipline: "Discipline", f_trust: "Trust", verifiedOnly: "Human-verified only",
      f_scope: "Show", scope_past: "Past projects", scope_upcoming: "Upcoming",
      scope_hint: "All shown by default. Uncheck to see only open opportunities.",
      aiSearch: "✦ Search the web with AI for more real opportunities",
      aiSearching: "AI is searching the web…",
      aiSearchNote: "Fetching official pages and verifying every quote — ~1–2 min. Only real ones are saved, never fabricated.",
      aiCancel: "Cancel",
      clearFilters: "Clear", applyFilters: "Show results",
      empty_title: "No matching opportunities", empty_desc: "Try fewer filters, or turn on “Show closed”.",
      error_title: "Failed to load data", error_desc: "Possibly a network issue. Check your connection and retry.", retry: "Retry",
      loadingMore: "Loading…", back: "Back",
      footer_note: "Entries marked “auto-collected” are scraped from institutional websites by a program and have NOT been individually verified. Always confirm on the official site before applying.",
      results: "results", favEmpty: "No saved items yet. Tap ♡ on a card to save it.",
      free: "Free", applyFee: "Fee", feeUnknown: "Fee not stated", partFeeWarn: "Pay if selected",
      fundStipend: "Stipend", fundHousing: "Housing", fundTravel: "Travel",
      trustVerified: "Verified", trustAuto: "Auto-collected · unverified",
      rolling: "Rolling / open all year", today: "Closes today", left: "", days: "days left", leftDays: "in", expired: "Closed",
      copyLink: "Copy link", gotoSite: "Official site", copied: "Link copied",
      copyEmail: "Copy", mailCopied: "Email copied", searchAria: "Search opportunities",
      autoNotice: "This entry was auto-collected. Please verify on the official site before applying.",
      dOrg: "Organizer", dPlace: "Location", dDeadline: "Deadline", dApplyFee: "Application fee", dPartFee: "Participation fee",
      dFunding: "Funding", dEligibility: "Eligibility", dDisc: "Disciplines", dUrl: "Official site", dSource: "Source", dSeen: "Last confirmed", dPredict: "Next call (est.)",
      notStated: "Not stated", provided: "Provided", notProvided: "Not provided", none: "None", yes: "Yes", no: "No",
      stipend: "Stipend", housing: "Housing", travel: "Travel", students: "Students", age: "Age", nationality: "Nationality",
      reportErr: "Found an error?", reportLink: "Let us know", visit: "Visit", officialLocated: "official site located online",
      cat: { opencall: "Open Call", residency: "Residency", award: "Award", workshop: "Workshop" },
      org: { official: "Official", independent: "Independent", commercial: "Commercial" }
    }
  };

  var AP = window.AP || (window.AP = {});
  AP.lang = (function () {
    try { return localStorage.getItem("ap_lang") || "zh"; } catch (e) { return "zh"; }
  })();
  AP.t = function (key) { return (STR[AP.lang] && STR[AP.lang][key] != null) ? STR[AP.lang][key] : (STR.zh[key] != null ? STR.zh[key] : key); };
  AP.tt = STR; // 供 render 直接取嵌套对象

  AP.applyI18n = function () {
    document.documentElement.lang = AP.lang === "en" ? "en" : "zh-CN";
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute("data-i18n");
      nodes[i].textContent = AP.t(k);
    }
    var phs = document.querySelectorAll("[data-i18n-ph]");
    for (var j = 0; j < phs.length; j++) {
      phs[j].setAttribute("placeholder", AP.t(phs[j].getAttribute("data-i18n-ph")));
    }
    var arias = document.querySelectorAll("[data-i18n-aria]");
    for (var k = 0; k < arias.length; k++) {
      arias[k].setAttribute("aria-label", AP.t(arias[k].getAttribute("data-i18n-aria")));
    }
  };
  AP.setLang = function (lang) {
    AP.lang = lang;
    try { localStorage.setItem("ap_lang", lang); } catch (e) {}
    AP.applyI18n();
  };
})();
