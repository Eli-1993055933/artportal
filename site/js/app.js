/* 入口:加载数据 → 渲染 → 交互。纯前端分页,首屏 24 条,滚动加载。 */
(function () {
  "use strict";
  var AP = window.AP;
  var F = AP.format;
  var PAGE = 30;   // 流式网格桌面可达 5 列,首屏批次相应加大

  var $ = function (id) { return document.getElementById(id); };
  var allData = [], filtered = [], rendered = 0;

  // 一级频道:机会(展览与项目)/ 资讯 / 招聘。各有独立数据文件与卡片。
  var channel = "opportunities";
  var cache = {};
  var CH = {
    opportunities: { file: "data/opportunities.json", key: "opportunities", card: function (o) { return AP.renderCard(o); } },
    news:          { file: "data/news.json",          key: "items",         card: function (o) { return AP.renderNewsCard(o); } },
    jobs:          { file: "data/jobs.json",           key: "jobs",          card: function (o) { return AP.renderJobCard(o); } }
  };
  function channelSearchText(o) {
    return [o.title, o.title_zh, o.title_en, o.source, o.org, o.summary, o.summary_zh, o.summary_en, o.city, o.country, o.employment_type].filter(Boolean).join(" ").toLowerCase();
  }

  var grid = $("grid"), skeleton = $("skeleton"), sentinel = $("sentinel"),
      loadingMore = $("loadingMore"), emptyState = $("emptyState"), errorState = $("errorState"),
      resultCount = $("resultCount");

  // ---------- 启动 ----------
  document.addEventListener("DOMContentLoaded", function () {
    AP.applyI18n();
    buildSkeleton();
    wireEvents();
    loadData();
  });

  function buildSkeleton() {
    var html = "";
    for (var i = 0; i < 10; i++) {
      html += '<div class="skel-card"><div class="skel-media"></div><div class="skel-line"></div><div class="skel-line sh"></div></div>';
    }
    skeleton.innerHTML = html;
  }
  // 分类 tab 色点的底色由 app.css 的 .tab__dot[data-cat-dot=*] 规则提供(随主题换肤),
  // 不再用 JS 内联写死(内联样式会压过 CSS 变量,夜间提亮色永远不生效)。

  function loadData() {
    var c = CH[channel];
    if (cache[channel]) { allData = cache[channel]; showState("ready"); rerun(); syncRoute(); return; }
    showState("loading");
    fetch(c.file, { cache: "no-cache" })
      .then(function (r) {
        if (r.ok) return r.json();
        if (channel === "opportunities") throw new Error("HTTP " + r.status);
        return null;   // 资讯/招聘文件缺失 → 当空处理,显示"筹备中"
      })
      .then(function (data) {
        allData = (data && data[c.key]) || [];
        cache[channel] = allData;
        showState("ready");
        rerun();
        syncRoute();
      })
      .catch(function (err) {
        if (channel === "opportunities") { console.error("[ArtPortal] 数据加载失败:", err); showState("error"); }
        else { allData = []; cache[channel] = []; showState("ready"); rerun(); }
      });
  }

  function showState(s) {
    skeleton.hidden = s !== "loading";
    grid.hidden = s === "loading" || s === "error";
    errorState.hidden = s !== "error";
    if (s !== "ready") emptyState.hidden = true;
  }

  // ---------- 渲染主流程 ----------
  function rerun() {
    if (channel === "opportunities") {
      filtered = AP.applyFilters(allData);
    } else {
      // 资讯/招聘:仅关键词过滤(无展览那套筛选);本次 AI 检索新增免过滤+置顶。
      var q = AP.filterState.q.trim().toLowerCase();
      var pinned = AP.filterState.pinnedIds;
      filtered = allData.filter(function (o) {
        if (pinned && pinned.has(o.id)) return true;
        return !q || channelSearchText(o).indexOf(q) !== -1;
      });
      filtered.sort(function (a, b) {
        if (pinned) {                              // 本次检索新增置顶
          var pa = pinned.has(a.id) ? 0 : 1, pb = pinned.has(b.id) ? 0 : 1;
          if (pa !== pb) return pa - pb;
        }
        if (channel === "jobs") {
          // 招聘:截止由近到远(在招优先),无截止的居中按新旧,已截止置底
          var ga = jobGroup(a), gb = jobGroup(b);
          if (ga !== gb) return ga - gb;
          if (ga === 0) return String(a.deadline).localeCompare(String(b.deadline));
          return String(b.posted_at || b.published_at || b.added_at || "").localeCompare(String(a.posted_at || a.published_at || a.added_at || ""));
        }
        // 资讯:按发布日期倒序(提不到发布日期的用入库日兜底,别让新条目沉底)
        return String(b.published_at || b.added_at || b.posted_at || "").localeCompare(String(a.published_at || a.added_at || a.posted_at || ""));
      });
    }
    rendered = 0;
    grid.innerHTML = "";
    updateCount();
    appendPage();
    updateEmpty();
    updateFilterDot();
  }
  // 招聘排序分组:0=有截止且未过(最急最前) 1=无固定截止 2=已截止(置底)
  // "招满为止/滚动招聘"这类非 ISO 截止串解析不出日期,属"无固定截止",绝不能当已截止置底。
  function jobGroup(j) {
    if (!j.deadline) return 1;
    var n = F.daysUntil(j.deadline);
    if (n == null) return 1;
    return n >= 0 ? 0 : 2;
  }

  function updateEmpty() {
    var isEmpty = filtered.length === 0;
    emptyState.hidden = !isEmpty;
    if (!isEmpty) return;
    if (channel !== "opportunities" && allData.length > 0) {
      // 库里有数据、只是关键词无命中:如实说"没匹配",别谎称"筹备中"
      emptyState.querySelector(".state__title").textContent = AP.t("empty_q_title");
      emptyState.querySelector(".state__desc").textContent = AP.t("empty_q_desc");
      $("emptyClear").hidden = true;
      return;
    }
    var t = channel === "news" ? "empty_news" : channel === "jobs" ? "empty_jobs" : null;
    if (t) {
      emptyState.querySelector(".state__title").textContent = AP.t(t + "_title");
      emptyState.querySelector(".state__desc").textContent = AP.t(t + "_desc");
      $("emptyClear").hidden = true;
    } else {
      emptyState.querySelector(".state__title").textContent = AP.t("empty_title");
      emptyState.querySelector(".state__desc").textContent = AP.t("empty_desc");
      $("emptyClear").hidden = false;
    }
  }

  function appendPage() {
    var renderer = CH[channel].card;
    var end = Math.min(rendered + PAGE, filtered.length);
    var frag = document.createDocumentFragment();
    for (var i = rendered; i < end; i++) frag.appendChild(renderer(filtered[i]));
    grid.appendChild(frag);
    rendered = end;
    loadingMore.hidden = rendered >= filtered.length;
  }

  // 频道切换
  function toggleEl(el, show) { if (el) el.style.display = show ? "" : "none"; }
  function switchChannel(ch) {
    if (ch === channel || !CH[ch]) return;
    channel = ch;
    var btns = document.querySelectorAll("#channelNav .channel");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("is-active", btns[i].getAttribute("data-channel") === ch);
    var opp = ch === "opportunities";
    toggleEl($("catRow"), opp);                // 分类+筛选+排序整行 仅机会频道
    // AI 检索三频道都有(同规格),按钮为内嵌短文案"✦ AI 检索"(不随频道换,placeholder 负责说明)
    // 检索中底条文案随频道("正在检索真实资讯/招聘…")
    var aiBarLbl = document.querySelector("#aiBar span[data-i18n]");
    if (aiBarLbl) {
      var abKey = ch === "news" ? "aiSearchingNews" : ch === "jobs" ? "aiSearchingJobs" : "aiSearching";
      aiBarLbl.setAttribute("data-i18n", abKey);
      aiBarLbl.textContent = AP.t(abKey);
    }
    $("moreFilters").hidden = true;
    AP.filterState.q = ""; if ($("searchInput")) $("searchInput").value = "";
    AP.filterState.cat = "all";
    AP.filterState.pinnedIds = null;           // 置顶集是"上一次检索"的,不跨频道带
    var sb = $("searchBanner"); if (sb) sb.hidden = true;   // 横幅说的是上个频道的检索,收起
    // placeholder 连同 data-i18n-ph 一起换:否则语言切换触发 applyI18n 时会被刷回机会频道文案
    var phKey = ch === "news" ? "searchNewsPh" : ch === "jobs" ? "searchJobsPh" : "searchPh";
    $("searchInput").setAttribute("data-i18n-ph", phKey);
    $("searchInput").setAttribute("placeholder", AP.t(phKey));
    if (AP.router.parse().name === "detail") AP.router.goList();
    window.scrollTo(0, 0);
    loadData();
  }

  function updateCount() {
    resultCount.textContent = filtered.length + " " + AP.t("results");
  }
  function updateFilterDot() {
    $("filterActiveDot").hidden = !AP.hasActiveMoreFilters();
  }

  // 无限滚动 + 到底自动刷新(拉取 pipeline 新入库的真实条目,不生成任何内容)
  function onReachBottom() {
    if (rendered < filtered.length) { appendPage(); return; }
    maybeRefresh();  // 现有已全部渲染 → 看看数据文件有没有新机会
  }
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) onReachBottom();
    }, { rootMargin: "300px" }).observe(sentinel);
  } else {
    window.addEventListener("scroll", function () {
      if (sentinel.getBoundingClientRect().top < window.innerHeight + 300) onReachBottom();
    });
  }

  // 到底时重新读取 opportunities.json,把新出现的条目(按 id 去重)追加到末尾。
  // 只读取程序已校验入库的真实数据,前端不做任何内容生成。节流 12 秒一次。
  var refreshing = false, lastRefreshAt = 0;
  function maybeRefresh() {
    if (channel !== "opportunities") return;   // 到底自动刷新只对机会频道
    var now = Date.now();
    if (refreshing || now - lastRefreshAt < 12000) return;
    refreshing = true; lastRefreshAt = now;
    fetch("data/opportunities.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        refreshing = false;
        if (!data || !data.opportunities) return;
        var known = {};
        for (var i = 0; i < allData.length; i++) known[allData[i].id] = 1;
        var fresh = data.opportunities.filter(function (o) { return !known[o.id]; });
        if (!fresh.length) return;
        Array.prototype.push.apply(allData, fresh);   // 原地追加:保持与 cache 同一数组引用,别让两处快照分叉
        var add = AP.applyFilters(fresh);          // 只把符合当前筛选的新条目追加到末尾
        if (add.length) {
          filtered = filtered.concat(add);
          appendPage();
          updateCount();
          toast(AP.lang === "en" ? ("+" + add.length + " new") : ("新增 " + add.length + " 条机会"));
        }
      })
      .catch(function () { refreshing = false; });
  }

  // ---------- 事件 ----------
  function wireEvents() {
    var st = AP.filterState;

    // 搜索(实时)
    var searchInput = $("searchInput");
    searchInput.addEventListener("input", function () { st.q = searchInput.value; st.pinnedIds = null; rerun(); });

    // AI 检索结果横幅关闭
    var sbClose = $("sbClose");
    if (sbClose) sbClose.addEventListener("click", function () { var b = $("searchBanner"); if (b) b.hidden = true; });

    // 分类 tab
    $("catTabs").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab"); if (!btn) return;
      var tabs = this.querySelectorAll(".tab");
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("is-active");
      btn.classList.add("is-active");
      st.cat = btn.getAttribute("data-cat");
      rerun();
    });

    // 排序
    $("sortSelect").addEventListener("change", function () { st.sort = this.value; rerun(); });
    // 显示范围:过往项目 / 即将开启(默认勾选,取消即隐藏对应组)
    // 防御:元素缺失(如 HTML/JS 版本因缓存错配)也不抛错,避免搞垮后续所有绑定。
    var _sp = $("showPast"), _su = $("showUpcoming");
    if (_sp) _sp.addEventListener("change", function () { st.showPast = this.checked; rerun(); });
    if (_su) _su.addEventListener("change", function () { st.showUpcoming = this.checked; rerun(); });
    var _sus = $("showUserSub"), _sas = $("showAiSearch");
    if (_sus) _sus.addEventListener("change", function () { st.showUserSub = this.checked; rerun(); });
    if (_sas) _sas.addEventListener("change", function () { st.showAiSearch = this.checked; rerun(); });

    // 更多筛选:开关(桌面内联 / 手机底部抽屉,同一元素)
    var moreFilters = $("moreFilters"), moreToggle = $("moreToggle");
    function openMore() { moreFilters.hidden = false; moreToggle.setAttribute("aria-expanded", "true"); }
    function closeMore() { moreFilters.hidden = true; moreToggle.setAttribute("aria-expanded", "false"); }
    moreToggle.addEventListener("click", function () { moreFilters.hidden ? openMore() : closeMore(); });
    $("moreClose").addEventListener("click", closeMore);
    $("moreScrim").addEventListener("click", closeMore);
    $("applyFilters").addEventListener("click", closeMore);

    // 地区 chips(多选)
    $("regionChips").addEventListener("click", function (e) {
      var c = e.target.closest(".chip"); if (!c) return;
      toggleSetChip(c, st.regions, c.getAttribute("data-region")); rerun();
    });
    // 学科 chips(多选)
    $("discChips").addEventListener("click", function (e) {
      var c = e.target.closest(".chip"); if (!c) return;
      toggleSetChip(c, st.discs, c.getAttribute("data-disc")); rerun();
    });
    // 机构类型 chips(多选)
    $("orgTypeChips").addEventListener("click", function (e) {
      var c = e.target.closest(".chip"); if (!c) return;
      toggleSetChip(c, st.orgTypes, c.getAttribute("data-orgtype")); rerun();
    });
    // 完全免费 / 资助 / 已核实
    $("freeOnly").addEventListener("change", function () { st.freeOnly = this.checked; rerun(); });
    $("verifiedOnly").addEventListener("change", function () { st.verifiedOnly = this.checked; rerun(); });
    var fundBoxes = document.querySelectorAll("[data-fund]");
    for (var i = 0; i < fundBoxes.length; i++) {
      (function (box) {
        box.addEventListener("change", function () {
          if (box.checked) st.funds.add(box.getAttribute("data-fund"));
          else st.funds.delete(box.getAttribute("data-fund"));
          rerun();
        });
      })(fundBoxes[i]);
    }

    // 清除筛选
    function clearAll() {
      AP.clearMoreFilters();
      if ($("showPast")) $("showPast").checked = true;
      if ($("showUpcoming")) $("showUpcoming").checked = true;
      if ($("showUserSub")) $("showUserSub").checked = true;
      if ($("showAiSearch")) $("showAiSearch").checked = true;
      $("freeOnly").checked = false; $("verifiedOnly").checked = false;
      var fb = document.querySelectorAll("[data-fund]"); for (var k = 0; k < fb.length; k++) fb[k].checked = false;
      var chips = document.querySelectorAll("#regionChips .chip, #discChips .chip, #orgTypeChips .chip");
      for (var j = 0; j < chips.length; j++) chips[j].classList.remove("is-active");
      rerun();
    }
    $("clearFilters").addEventListener("click", clearAll);
    $("emptyClear").addEventListener("click", clearAll);

    // (顶栏收藏按钮已移除:我的收藏在用户主页"收藏"tab 里,点头像直达)

    // 日间/夜间切换:改 <html> 的 data-theme(CSS 变量随之整体换肤),选择存本机。
    // 首屏的初始主题与 meta theme-color 由 index.html <head> 里的预置脚本决定(没选过则跟随系统)。
    var themeBtn = $("themeBtn");
    function syncThemeUi() {
      var dark = document.documentElement.getAttribute("data-theme") === "dark";
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#1B1A18" : "#F7F6F2");
      if (themeBtn) themeBtn.setAttribute("aria-pressed", dark ? "true" : "false");   // 读屏可感知开关状态
      var logo = document.querySelector(".brand__logo");                              // logo 是 <img>,CSS 变量管不到,换深浅两版文件
      if (logo) logo.src = dark ? "assets/mark-dark.svg" : "assets/mark.svg";
    }
    if (themeBtn) themeBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("ap_theme", next); } catch (e) {}
      syncThemeUi();
    });
    syncThemeUi();

    // 语言切换
    $("langBtn").addEventListener("click", function () {
      AP.setLang(AP.lang === "zh" ? "en" : "zh");
      rerun();
      var r = AP.router.parse();
      if (r.name === "detail") { var o = byId(r.id); if (o) $("detailBody").innerHTML = AP.renderDetail(o); }
      syncFavCount();
      // 横幅是拼好的整句纯文本,applyI18n 刷不到:可见时按新语言重渲一次
      var sb = $("searchBanner");
      if (sb && !sb.hidden && lastBanner) setSearchBanner(lastBanner.q, lastBanner.n, lastBanner.ch);
      if (AP.profilePage) AP.profilePage.refresh();   // 用户主页开着 → 按新语言重渲
    });

    // 提交机会:站内投稿表单(登录 → 填写 → 审核通过后发布);手机端为右下角悬浮 ➕
    $("submitBtn").addEventListener("click", function (e) {
      e.preventDefault();
      if (AP.submitForm) AP.submitForm.open();
    });
    var fab = $("submitFab");
    if (fab) fab.addEventListener("click", function () { if (AP.submitForm) AP.submitForm.open(); });

    // AI 全网检索(调后端 /api/search,仅在 node server.mjs 下可用)
    var aiBtn = $("aiSearchBtn");
    if (aiBtn) aiBtn.addEventListener("click", runAiSearch);
    var aiCancel = $("aiCancelBtn");
    if (aiCancel) aiCancel.addEventListener("click", cancelAiSearch);

    // 频道导航切换
    $("channelNav").addEventListener("click", function (e) {
      var b = e.target.closest(".channel"); if (b) switchChannel(b.getAttribute("data-channel"));
    });

    // 列表点击委托:复制 / 访问 / 打开详情
    grid.addEventListener("click", function (e) {
      // 官网速览按钮:任何频道都优先拦截(否则会冒泡触发整卡跳外链)
      // 资讯/招聘:整卡点击 → 新窗口打开原文/申请页(不进详情)
      if (channel !== "opportunities") {
        if (e.target.closest("[data-act='visit']")) return;   // 卡内 <a> 走默认
        var lk = e.target.closest(".card--link");
        if (lk && lk.getAttribute("data-url")) window.open(lk.getAttribute("data-url"), "_blank", "noopener");
        return;
      }
      var actEl = e.target.closest("[data-act]");
      var card = e.target.closest(".card");
      if (actEl) {
        var act = actEl.getAttribute("data-act");
        if (act === "copy") { e.preventDefault(); copyLink(card.getAttribute("data-id")); return; }
        if (act === "visit") { return; } // 让 <a> 默认新窗口打开
      }
      // 点封面链接 → 让 <a> 直接新窗口打开官网,不进详情
      if (e.target.closest(".card__media-link")) return;
      if (card) {
        // 标题是为键盘/读屏可达而设的真链接;点击时拦掉默认跳转,统一走 goDetail 以保留返回行为
        if (e.target.closest(".card__title-link")) e.preventDefault();
        AP.router.goDetail(card.getAttribute("data-id"));
      }
    });

    // 重试
    $("retryBtn").addEventListener("click", loadData);

    // 详情:关闭
    $("detailBack").addEventListener("click", function () { AP.router.goList(); });
    $("detailScrim").addEventListener("click", function () { AP.router.goList(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("detail").hidden) AP.router.goList();
    });
    // 详情内:复制 / 收藏
    $("detailBody").addEventListener("click", function (e) {
      var actEl = e.target.closest("[data-act]");
      if (!actEl) return;
      var act = actEl.getAttribute("data-act");
      if (act === "copy") { e.preventDefault(); copyLink(actEl.getAttribute("data-id")); }
      else if (act === "copyemail") { e.preventDefault(); copyText(actEl.getAttribute("data-email"), AP.t("mailCopied")); }
    });
    $("detailFav").addEventListener("click", function () {
      var r = AP.router.parse(); if (r.name !== "detail") return;
      AP.favorites.toggle(r.id); syncFavCount(); syncDetailFav(r.id);
      if (AP.filterState.favOnly) rerun();
    });

    // 沉浸式浏览:下滑收起整个吸顶头(内容满屏),上滑或接近顶部立即召回;
    // 搜索框聚焦(输入法弹出会触发 scroll)期间不收,避免输入时头部消失。
    var headEl = $("stickyHead"), lastY = window.scrollY || 0;
    if (headEl) window.addEventListener("scroll", function () {
      var y = window.scrollY;
      if (y < 90 || document.activeElement === searchInput || y < lastY - 2) headEl.classList.remove("is-hidden");
      else if (y > lastY + 6) headEl.classList.add("is-hidden");
      lastY = y;
    }, { passive: true });

    // 路由变化
    AP.router.onChange(syncRoute);

    syncFavCount();
  }

  function toggleSetChip(chipEl, set, val) {
    if (set.has(val)) { set.delete(val); chipEl.classList.remove("is-active"); }
    else { set.add(val); chipEl.classList.add("is-active"); }
  }
  function syncFavCount() {
    var n = AP.favorites.count(), el = $("favCount");
    if (el) { el.textContent = n; el.hidden = n === 0; }   // 顶栏角标已移除,留守卫防旧引用
  }
  // 供 auth.js 在登录/退出云同步收藏后刷新角标与(若在收藏视图)列表
  AP.syncFavCount = syncFavCount;
  AP.rerun = rerun;
  // 供 profile.js 取已加载的频道数据(启动即加载机会频道,主页收藏/投稿卡片由此查找)
  AP.channelData = function (ch) { return cache[ch] || null; };

  function byId(id) {
    for (var i = 0; i < allData.length; i++) if (allData[i].id === id) return allData[i];
    return null;
  }

  // ---------- 详情开关(由路由驱动) ----------
  function syncRoute() {
    var r = AP.router.parse();
    if (r.name === "detail") {
      if (AP.profilePage) AP.profilePage.close();   // 先关主页再开详情(overflow 锁定顺序)
      var o = byId(r.id);
      if (o) openDetail(o); else AP.router.goList();
    } else if (r.name === "user") {
      closeDetail();
      if (AP.profilePage) AP.profilePage.open(r.id);
    } else {
      closeDetail();
      if (AP.profilePage) AP.profilePage.close();
    }
  }
  function openDetail(o) {
    $("detailBody").innerHTML = AP.renderDetail(o);
    $("detail").hidden = false;
    document.body.style.overflow = "hidden";
    syncDetailFav(o.id);
    var panel = $("detailPanel");
    panel.scrollTop = 0; $("detailBody").scrollTop = 0;
    panel.focus();
  }
  function closeDetail() {
    $("detail").hidden = true;
    document.body.style.overflow = "";
  }
  function syncDetailFav(id) {
    var btn = $("detailFav"), on = AP.favorites.has(id);
    btn.innerHTML = on ? AP.ICON.heartFill : AP.ICON.heart;
    btn.style.color = on ? "var(--c-opencall)" : "";
  }

  // ---------- AI 全网检索(后端 /api/search:搜索→抓原文→逐字校验→真实的才入库)----------
  // 三频道同规格:机会/资讯/招聘各自检索各自的库,请求带 channel 参数。
  var aiSearching = false, aiCtrl = null, aiDone = false, aiTo = null;
  function runAiSearch() {
    if (aiSearching) return;
    var q = ($("searchInput").value || "").trim();
    if (!q) { toast(AP.lang === "en" ? "Type what you're looking for first" : "请先在搜索框输入想找的主题/展览"); $("searchInput").focus(); return; }
    var ch = channel;                    // 捕获发起时的频道:响应回来时用户可能已切走
    aiSearching = true; aiDone = false;
    var btn = $("aiSearchBtn"); if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
    $("aiBarQ").textContent = "「" + q + "」";
    $("aiBar").hidden = false;
    setSearchBanner(q, null, ch);        // 横幅:正在检索…
    // 超时保护:检索最长等 170 秒,超时自动收起覆盖层并提示(避免永远转圈);用户也可随时点"取消"。
    aiCtrl = ("AbortController" in window) ? new AbortController() : null;
    aiTo = setTimeout(function () {
      if (aiDone) return; aiDone = true;
      if (aiCtrl) aiCtrl.abort();
      finishAi(btn);
      toast(AP.lang === "en" ? "Timed out (search source may be rate-limited). Refresh to see any saved; try again later or set SERPER_API_KEY." : "检索超时(搜索源可能被限流)。刷新后能看到已入库的;稍后再试,或配置 SERPER_API_KEY 稳定检索");
    }, 170000);
    fetch("/api/search?q=" + encodeURIComponent(q) + "&channel=" + encodeURIComponent(ch), aiCtrl ? { signal: aiCtrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (aiDone) return; aiDone = true; clearTimeout(aiTo); finishAi(btn);
        if (res && res.error) { toast(res.message || (AP.lang === "en" ? "Search error" : "检索出错,请确认后端服务已启动")); return; }
        if (res && res.cached) { if (channel === ch) setSearchBanner(q, -1, ch); return; }
        var add = (res && res.added) || [];
        // 并入发起频道的缓存数组(原地 push,保持 cache 与 allData 同一引用,切频道来回不丢)
        var base = cache[ch] || (cache[ch] = []);
        var known = {}; for (var i = 0; i < base.length; i++) known[base[i].id] = 1;
        var fresh = add.filter(function (o) { return !known[o.id]; });
        if (!fresh.length) { if (channel === ch) setSearchBanner(q, 0, ch); return; }
        Array.prototype.push.apply(base, fresh);
        if (channel !== ch) {            // 用户已切走:数据已并入该频道,回去即见
          toast(AP.lang === "en" ? ("+" + fresh.length + " new in " + AP.t("ch_" + ch)) : ("「" + AP.t("ch_" + ch) + "」新增 " + fresh.length + " 条,切回即见"));
          return;
        }
        if (allData !== base) allData = base;
        // 保持在当前搜索状态(不跳回全部);把本次新增置顶+免过滤显示,横幅常驻"新增X条"直到下次检索。
        AP.filterState.pinnedIds = new Set(fresh.map(function (o) { return o.id; }));
        rerun();
        setSearchBanner(q, fresh.length, ch);
        try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) { window.scrollTo(0, 0); }
      })
      .catch(function () { if (aiDone) return; aiDone = true; clearTimeout(aiTo); finishAi(btn); toast(AP.lang === "en" ? "Search failed — is the server running?" : "检索失败,请确认已用 node server.mjs 启动服务"); });
  }
  // 用户手动取消检索:立即中止请求、收起覆盖层(后端已入库的下次搜索/刷新仍在)
  function cancelAiSearch() {
    if (!aiSearching || aiDone) return;
    aiDone = true; clearTimeout(aiTo);
    if (aiCtrl) aiCtrl.abort();
    finishAi($("aiSearchBtn"));
    toast(AP.lang === "en" ? "Search canceled" : "已取消检索");
  }
  function finishAi(btn) {
    aiSearching = false;
    if (btn) { btn.disabled = false; btn.classList.remove("is-loading"); }
    var ov = $("aiBar"); if (ov) ov.hidden = true;
    // 先收起"正在检索…"横幅:取消/超时/出错路径不再更新它,不收会永久停在检索中;
    // 成功/缓存命中路径随后会重新 setSearchBanner 展示结果。
    var sb = $("searchBanner"); if (sb) sb.hidden = true;
  }
  // 检索结果横幅(常驻,直到下次检索):n=null 检索中 / n<0 缓存命中 / n=0 未找到 / n>0 新增数
  // noun 随频道:机会/资讯/招聘(三频道同规格检索)。记住最近一次参数,切语言时可重渲。
  var lastBanner = null;
  function setSearchBanner(q, n, ch) {
    var t = $("sbText"), el = $("searchBanner");
    if (!t || !el) return;
    lastBanner = { q: q, n: n, ch: ch || channel };
    var en = AP.lang === "en", qq = "「" + q + "」";
    var noun = AP.t("noun_" + (ch || channel));
    if (n === null) t.textContent = en ? ("Searching " + qq + " …") : ("正在检索 " + qq + " …");
    else if (n < 0) t.textContent = en ? (qq + " just searched — results already in the list below") : (qq + " 刚检索过,结果已在下方列表里");
    else if (n === 0) t.textContent = en ? (qq + ": no new real " + noun + " found (never fabricated) — try another term") : ("本次检索 " + qq + " 未找到新的真实" + noun + "(绝不编造),换个词试试");
    else t.textContent = en ? (qq + " · added " + n + " new " + noun + ", pinned on top") : ("本次检索 " + qq + " · 新增 " + n + " 条真实" + noun + ",已置顶在最上方");
    el.hidden = false;
  }

  // ---------- 复制链接 ----------
  function copyLink(id) {
    var url = location.origin + location.pathname + location.search + "#/o/" + encodeURIComponent(id);
    copyText(url, AP.t("copied"));
  }
  function copyText(text, okMsg) {
    var done = function () { toast(okMsg); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, cb) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); cb();
  }

  // ---------- toast ----------
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(el._apTimer);                 // 与 auth.js 共用 #toast:统一用元素上的定时器,互不打断
    el._apTimer = setTimeout(function () { el.hidden = true; }, 1800);
  }
})();
