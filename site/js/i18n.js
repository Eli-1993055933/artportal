/* 中 / EN 文案表。数据本身双语共存;这里只切 UI 标签与少量措辞。 */
(function () {
  "use strict";
  var STR = {
    zh: {
      brandSub: "· 全球艺术机会",
      ch_opportunities: "机会", ch_news: "资讯", ch_jobs: "招聘",
      searchNewsPh: "搜索资讯,或描述主题让 AI 全网检索:如 威尼斯双年展", searchJobsPh: "搜索招聘,或描述需求让 AI 全网检索:如 上海 画廊 策展",
      empty_news_title: "资讯正在筹备", empty_news_desc: "AI 正在采集本周高质量艺术资讯,很快上线。",
      empty_jobs_title: "招聘正在筹备", empty_jobs_desc: "正在采集真实的艺术机构招聘,很快上线。",
      news_readmore: "阅读原文", job_apply: "查看/申请", job_deadline: "截止", news_source: "来源",
      aiSearchNews: "✦ 用 AI 全网检索更多真实资讯", aiSearchJobs: "✦ 用 AI 全网检索更多真实招聘",
      aiSearchingNews: "AI 正在全网检索真实资讯…", aiSearchingJobs: "AI 正在全网检索真实招聘…",
      noun_opportunities: "机会", noun_news: "资讯", noun_jobs: "招聘",
      chipAiSearched: "AI 检索收录 · 以原文为准",
      empty_q_title: "没有匹配的结果", empty_q_desc: "换个搜索词试试;或点上方 ✦ 让 AI 全网检索。",
      myFavorites: "我的收藏", submit: "提交机会",
      searchPh: "搜索,或直接描述需求让 AI 全网检索:如 大理的摄影驻留",
      cat_all: "全部", cat_opencall: "展览征集", cat_residency: "驻留项目", cat_award: "艺术奖项", cat_workshop: "工作坊", cat_predict: "预测展览",
      recurringTag: "周期展", recurringTitle: "双年展/三年展 · 可推算下届开放时间",
      moreFilters: "更多筛选", sortBy: "排序", sort_deadline: "截止由近到远", sort_updated: "最近更新",
      showExpired: "显示已截止",
      f_region: "地区", region_cn: "中国大陆", region_hktw: "港澳台", region_asia: "亚洲其他", region_europe: "欧洲", region_namerica: "北美", region_other: "其他",
      f_fee: "费用", freeOnly: "仅看完全免费",
      f_funding: "资助", fund_stipend: "提供津贴", fund_housing: "提供住宿", fund_travel: "报销路费",
      f_discipline: "学科", f_trust: "信任", verifiedOnly: "仅看已人工核实",
      f_orgtype: "机构类型", orgt_official: "官方体制", orgt_independent: "独立学术", orgt_commercial: "商业机构",
      f_scope: "显示范围", scope_past: "过往项目", scope_upcoming: "即将开启",
      scope_user: "用户上传", scope_ai: "AI 检索",
      scope_hint: "默认全部显示。取消勾选即可只看正在开放的机会。",
      aiSearch: "✦ 用 AI 全网检索更多真实机会",
      aiSearchBtnS: "✦ AI 检索", fFilter: "筛选",
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
      trustVerified: "已核实", trustAuto: "自动收录 · 未人工核实", trustUser: "用户投稿 · 未经核实",
      // 投稿表单
      sfTitle: "投稿一个艺术机会",
      sfNote: "请填写真实存在的机会,官网链接必填。提交后经审核通过才会展示,并标注“用户投稿”。",
      sfPhTitle: "标题(必填,如:2026 青年版画双年展征集)", sfPhOrg: "主办方(必填)",
      sfPhSrc: "信息来源(必填,如:机构公众号 / 官网 / 海报,可附链接)",
      sfPhCity: "城市(选填)", sfPhCountry: "国家(选填)",
      sfPhDeadline: "截止日期(选填)", sfPhUrl: "官网链接(选填,https:// 开头,主办方自己的网站)",
      sfPhSummary: "简介(选填,500 字内:内容/资格/费用等)",
      sfPhCover: "封面图(选填)",
      sfSubmit: "提交审核", sfNeedLogin: "投稿需要登录账号(便于沟通与防灌水)",
      sfOk: "已提交!审核通过后会出现在列表中", sfRejected: "内容未通过自动审核,请检查措辞后重试",
      sfErrTitle: "请填写标题(至少 2 字)", sfErrOrg: "请填写主办方(至少 2 字)",
      sfErrSrc: "请注明信息来源(至少 2 字)",
      sfErrUrl: "官网链接需以 http(s):// 开头", sfErrDate: "截止日期格式:2026-12-31",
      sfErrCover: "封面图无效或过大(请选常规图片)",
      dSourceNote: "用户注明来源",
      sfPrivacy: "投稿会记录你的账号,仅用于审核沟通,不对外公开。",
      rolling: "常年接受申请", today: "今天截止", left: "仅剩", days: "天", leftDays: "还有", expired: "已截止",
      copyLink: "复制链接", gotoSite: "前往官网", noOfficial: "官网待收录", copied: "链接已复制",
      copyEmail: "复制", mailCopied: "邮箱已复制", searchAria: "搜索机会",
      autoNotice: "本条由程序自动收录,建议点官网核对后再申请。",
      dOrg: "主办方", dPlace: "地点", dDeadline: "截止", dApplyFee: "申请费", dPartFee: "参展/入选费",
      dFunding: "资助", dEligibility: "申请资格", dDisc: "适用学科", dUrl: "官网", dSource: "信息来源", dSeen: "最后确认存在", dPredict: "下届推算",
      notStated: "未注明", provided: "提供", notProvided: "不提供", none: "无", yes: "是", no: "否",
      stipend: "津贴", housing: "住宿", travel: "路费", students: "学生", age: "年龄", nationality: "国籍",
      reportErr: "信息有误?", reportLink: "反馈给我们", visit: "访问", officialLocated: "官网已联网校正",
      mtNote: "英文内容由机器翻译,请以官网原文措辞为准。",
      // 账号
      authLoginBtn: "登录", authRegister: "注册", authLogin: "登录",
      authTitleReg: "创建账号", authTitleLog: "欢迎回来",
      authNoteDefault: "注册后:不限次前往官网 + 收藏云同步(换设备不丢)。",
      gateWallMsg: "3 次免费直达官网已用完。注册只要 10 秒(邮箱+密码),之后不限次前往官网,收藏还能云同步。",
      gateWelcomeBack: "这台设备之前登录过 ArtPortal,可能是登录状态过期了。输入密码登录即可继续前往官网(不限次)。",
      gateLeft: "已为你打开官网 · 免费次数还剩 {n} 次,注册后不限次",
      gateLast: "免费次数已用完,下次前往官网需注册(10 秒完成)",
      authEmailPh: "邮箱", authPwPh: "密码(至少 6 位)",
      authSubmitReg: "注册并继续", authSubmitLog: "登录",
      authBadEmail: "请输入正确的邮箱", authBadPw: "密码至少 6 位",
      authNetErr: "网络异常,请重试",
      authWelcomeNew: "注册成功!收藏已开启云同步", authWelcomeBack: "已登录,收藏已同步",
      gateGoNote: "账号已就绪。点下面按钮前往官网(新窗口打开)。",
      gateGoBtn: "前往官网 ↗",
      authLogout: "退出登录", authLoggedOut: "已退出登录",
      authPrivacy: "邮箱仅用于登录与找回账号,不公开、不对第三方提供。",
      pfTitle: "完善你的资料",
      pfNote: "昵称和头像是必填项(社区功能需要),1 分钟完成。昵称全站唯一。",
      pfPhNick: "昵称(2–20 字,中英文/数字/_-·)",
      pfUpload: "上传头像", pfDefault: "使用默认头像", pfSave: "保存",
      pfErrNick: "昵称至少 2 个字", pfErrAva: "请上传头像或点“使用默认头像”",
      pfErrImg: "图片无效,请换一张", pfDone: "资料已保存!",
      // 用户主页(8.1)
      menuMyPage: "我的主页", menuEditProfile: "编辑资料",
      ppJoined: "加入于", ppTabFavs: "收藏", ppTabSubs: "投稿",
      ppFavPrivate: "TA 未公开收藏", ppFavEmpty: "还没有收藏",
      ppSubEmpty: "还没有通过审核的投稿", ppNotFound: "用户不存在或资料未完成",
      ppFields: "创作领域",
      idn_artist: "艺术家", idn_curator: "策展人", idn_student: "学生", idn_org: "机构", idn_fan: "艺术爱好者",
      peTitle: "编辑资料", peNickHint: "昵称每 7 天可修改一次",
      peBioPh: "简介(选填,300 字内)", peIdentityNone: "身份(选填)",
      peFieldsPh: "创作领域(选填,如:油画、声音艺术)", peLocationPh: "所在地(选填,如:北京)",
      peWebsitePh: "个人网站(选填,https:// 开头)",
      peFavPub: "公开我的收藏(他人可在我的主页看到)",
      peErrWebsite: "个人网站需以 http(s):// 开头", peDone: "资料已保存",
      crTitle: "调整头像", crHint: "拖动图片调整位置,滑杆放大缩小;圈内为最终头像。",
      crZoom: "缩放", crOk: "确定",
      cat: { opencall: "展览征集", residency: "驻留项目", award: "艺术奖项", workshop: "工作坊" },
      org: { official: "官方体制", independent: "独立学术", commercial: "商业机构", aggregator: "第三方来源" }
    },
    en: {
      brandSub: "· Global Art Opportunities",
      ch_opportunities: "Opportunities", ch_news: "News", ch_jobs: "Jobs",
      searchNewsPh: "Search news, or describe a topic for AI web search", searchJobsPh: "Search jobs, or describe a need for AI web search",
      empty_news_title: "News coming soon", empty_news_desc: "AI is curating this week's art news. Back shortly.",
      empty_jobs_title: "Jobs coming soon", empty_jobs_desc: "Gathering real art-institution openings. Back shortly.",
      news_readmore: "Read source", job_apply: "View / Apply", job_deadline: "Deadline", news_source: "Source",
      aiSearchNews: "✦ Search the web with AI for more real art news", aiSearchJobs: "✦ Search the web with AI for more real art jobs",
      aiSearchingNews: "AI is searching the web…", aiSearchingJobs: "AI is searching the web…",
      noun_opportunities: "opportunities", noun_news: "news items", noun_jobs: "jobs",
      chipAiSearched: "AI-searched · see source",
      empty_q_title: "No matches", empty_q_desc: "Try another term, or use the ✦ AI web search above.",
      myFavorites: "Saved", submit: "Submit an opportunity",
      searchPh: "Search, or describe a need for AI web search: e.g. photography residency in Dali",
      cat_all: "All", cat_opencall: "Open Calls", cat_residency: "Residencies", cat_award: "Awards", cat_workshop: "Workshops", cat_predict: "Recurring",
      recurringTag: "Recurring", recurringTitle: "Biennial/Triennial · next edition can be estimated",
      moreFilters: "More filters", sortBy: "Sort", sort_deadline: "Deadline (soonest)", sort_updated: "Recently updated",
      showExpired: "Show closed",
      f_region: "Region", region_cn: "Mainland China", region_hktw: "HK·MO·TW", region_asia: "Rest of Asia", region_europe: "Europe", region_namerica: "N. America", region_other: "Other",
      f_fee: "Fee", freeOnly: "Fully free only",
      f_funding: "Funding", fund_stipend: "Stipend", fund_housing: "Housing", fund_travel: "Travel",
      f_discipline: "Discipline", f_trust: "Trust", verifiedOnly: "Human-verified only",
      f_orgtype: "Institution", orgt_official: "Official", orgt_independent: "Independent", orgt_commercial: "Commercial",
      f_scope: "Show", scope_past: "Past projects", scope_upcoming: "Upcoming",
      scope_user: "User submissions", scope_ai: "AI-searched",
      scope_hint: "All shown by default. Uncheck to see only open opportunities.",
      aiSearch: "✦ Search the web with AI for more real opportunities",
      aiSearchBtnS: "✦ AI search", fFilter: "Filter",
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
      trustVerified: "Verified", trustAuto: "Auto-collected · unverified", trustUser: "User submission · unverified",
      // Submission form
      sfTitle: "Submit an art opportunity",
      sfNote: "Real opportunities only; official-site link required. Goes live after review, labeled “user submission”.",
      sfPhTitle: "Title (required)", sfPhOrg: "Organizer (required)",
      sfPhSrc: "Source (required — e.g. the org's WeChat/official site/poster, link welcome)",
      sfPhCity: "City (optional)", sfPhCountry: "Country (optional)",
      sfPhDeadline: "Deadline (optional)", sfPhUrl: "Official site URL (optional, https://, the organizer's own site)",
      sfPhSummary: "Summary (optional, ≤500 chars)",
      sfPhCover: "Cover image (optional)",
      sfSubmit: "Submit for review", sfNeedLogin: "Please sign in to submit (helps us reach you and prevent spam)",
      sfOk: "Submitted! It will appear once approved.", sfRejected: "Did not pass automatic moderation — please revise and retry",
      sfErrTitle: "Title needed (2+ chars)", sfErrOrg: "Organizer needed (2+ chars)",
      sfErrSrc: "Please state the source (2+ chars)",
      sfErrUrl: "Official link must start with http(s)://", sfErrDate: "Deadline format: 2026-12-31",
      sfErrCover: "Invalid or oversized cover image",
      dSourceNote: "Source stated by submitter",
      sfPrivacy: "Your account is recorded with the submission for review purposes only — never public.",
      rolling: "Rolling / open all year", today: "Closes today", left: "", days: "days left", leftDays: "in", expired: "Closed",
      copyLink: "Copy link", gotoSite: "Official site", noOfficial: "Official site pending", copied: "Link copied",
      copyEmail: "Copy", mailCopied: "Email copied", searchAria: "Search opportunities",
      autoNotice: "This entry was auto-collected. Please verify on the official site before applying.",
      dOrg: "Organizer", dPlace: "Location", dDeadline: "Deadline", dApplyFee: "Application fee", dPartFee: "Participation fee",
      dFunding: "Funding", dEligibility: "Eligibility", dDisc: "Disciplines", dUrl: "Official site", dSource: "Source", dSeen: "Last confirmed", dPredict: "Next call (est.)",
      notStated: "Not stated", provided: "Provided", notProvided: "Not provided", none: "None", yes: "Yes", no: "No",
      stipend: "Stipend", housing: "Housing", travel: "Travel", students: "Students", age: "Age", nationality: "Nationality",
      reportErr: "Found an error?", reportLink: "Let us know", visit: "Visit", officialLocated: "official site located online",
      mtNote: "English text is machine-translated — see the official site for the original wording.",
      // Account
      authLoginBtn: "Sign in", authRegister: "Sign up", authLogin: "Sign in",
      authTitleReg: "Create account", authTitleLog: "Welcome back",
      authNoteDefault: "Free account: unlimited visits to official sites + favorites synced across devices.",
      gateWallMsg: "You've used your 3 free visits. Sign up in 10 seconds (email + password) for unlimited visits and synced favorites.",
      gateWelcomeBack: "You've signed in on this device before — your session may have expired. Enter your password to continue (unlimited visits).",
      gateLeft: "Opening official site · {n} free visits left — sign up for unlimited",
      gateLast: "That was your last free visit. Sign up next time (takes 10s)",
      authEmailPh: "Email", authPwPh: "Password (min 6 chars)",
      authSubmitReg: "Sign up & continue", authSubmitLog: "Sign in",
      authBadEmail: "Please enter a valid email", authBadPw: "Password must be 6+ chars",
      authNetErr: "Network error, please retry",
      authWelcomeNew: "Welcome! Favorites now sync to your account", authWelcomeBack: "Signed in — favorites synced",
      gateGoNote: "Your account is ready. Tap below to open the official site (new tab).",
      gateGoBtn: "Go to official site ↗",
      authLogout: "Sign out", authLoggedOut: "Signed out",
      authPrivacy: "Your email is used only for sign-in and account recovery. Never public, never shared.",
      pfTitle: "Complete your profile",
      pfNote: "Nickname and avatar are required (for community features) — takes a minute. Nicknames are unique site-wide.",
      pfPhNick: "Nickname (2–20 chars)",
      pfUpload: "Upload avatar", pfDefault: "Use default avatar", pfSave: "Save",
      pfErrNick: "Nickname needs 2+ chars", pfErrAva: "Upload an avatar or tap “Use default avatar”",
      pfErrImg: "Invalid image — try another", pfDone: "Profile saved!",
      // Profile page (8.1)
      menuMyPage: "My page", menuEditProfile: "Edit profile",
      ppJoined: "Joined", ppTabFavs: "Saved", ppTabSubs: "Submissions",
      ppFavPrivate: "Saved items are private", ppFavEmpty: "Nothing saved yet",
      ppSubEmpty: "No approved submissions yet", ppNotFound: "User not found or profile incomplete",
      ppFields: "Fields",
      idn_artist: "Artist", idn_curator: "Curator", idn_student: "Student", idn_org: "Institution", idn_fan: "Art lover",
      peTitle: "Edit profile", peNickHint: "Nickname can be changed once every 7 days",
      peBioPh: "Bio (optional, ≤300 chars)", peIdentityNone: "Identity (optional)",
      peFieldsPh: "Fields (optional, e.g. painting, sound art)", peLocationPh: "Location (optional)",
      peWebsitePh: "Website (optional, starts with https://)",
      peFavPub: "Make my saved items public on my page",
      peErrWebsite: "Website must start with http(s)://", peDone: "Saved",
      crTitle: "Adjust avatar", crHint: "Drag to reposition, slide to zoom. The circle is your final avatar.",
      crZoom: "Zoom", crOk: "Done",
      cat: { opencall: "Open Call", residency: "Residency", award: "Award", workshop: "Workshop" },
      org: { official: "Official", independent: "Independent", commercial: "Commercial", aggregator: "Third-party" }
    }
  };

  // 筛选面板固定 6 个学科 chip 的英文名(数据里的自由学科文本由 disciplines_en 逐条翻译承担)
  var DISC_CHIP = { "版画": "Printmaking", "绘画": "Painting", "雕塑": "Sculpture", "影像": "Moving Image", "装置": "Installation", "跨媒介": "Interdisciplinary" };

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
    // 学科筛选 chip:标签随语言切换(data-disc 值保持中文,筛选逻辑不受影响)
    var discs = document.querySelectorAll("#discChips .chip");
    for (var m = 0; m < discs.length; m++) {
      var zh = discs[m].getAttribute("data-disc");
      discs[m].textContent = AP.lang === "en" ? (DISC_CHIP[zh] || zh) : zh;
    }
  };
  AP.setLang = function (lang) {
    AP.lang = lang;
    try { localStorage.setItem("ap_lang", lang); } catch (e) {}
    AP.applyI18n();
  };
})();
