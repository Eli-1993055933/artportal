/* 入口:加载数据 → 渲染 → 交互。纯前端分页,首屏 24 条,滚动加载。 */
(function () {
  "use strict";
  var AP = window.AP;
  var F = AP.format;
  var PAGE = 24;
  var SUBMIT_FORM_URL = ""; // 占位:外部投稿表单链接,后续填入

  var $ = function (id) { return document.getElementById(id); };
  var allData = [], filtered = [], rendered = 0;

  var grid = $("grid"), skeleton = $("skeleton"), sentinel = $("sentinel"),
      loadingMore = $("loadingMore"), emptyState = $("emptyState"), errorState = $("errorState"),
      resultCount = $("resultCount");

  // ---------- 启动 ----------
  document.addEventListener("DOMContentLoaded", function () {
    AP.applyI18n();
    buildSkeleton();
    wireEvents();
    wireCatDots();
    loadData();
  });

  function buildSkeleton() {
    var html = "";
    for (var i = 0; i < 6; i++) {
      html += '<div class="skel-card"><div class="skel-media"></div><div class="skel-line"></div><div class="skel-line sh"></div></div>';
    }
    skeleton.innerHTML = html;
  }
  function wireCatDots() {
    var dots = document.querySelectorAll("[data-cat-dot]");
    for (var i = 0; i < dots.length; i++) {
      dots[i].style.background = F.catColor(dots[i].getAttribute("data-cat-dot"));
    }
  }

  function loadData() {
    showState("loading");
    fetch("data/opportunities.json", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) {
        allData = (data && data.opportunities) || [];
        showState("ready");
        rerun();
        syncRoute();
      })
      .catch(function (err) {
        console.error("[ArtPortal] 数据加载失败:", err);
        showState("error");
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
    filtered = AP.applyFilters(allData);
    rendered = 0;
    grid.innerHTML = "";
    updateCount();
    appendPage();
    emptyState.hidden = filtered.length !== 0;
    updateFilterDot();
  }

  function appendPage() {
    var end = Math.min(rendered + PAGE, filtered.length);
    var frag = document.createDocumentFragment();
    for (var i = rendered; i < end; i++) frag.appendChild(AP.renderCard(filtered[i]));
    grid.appendChild(frag);
    rendered = end;
    loadingMore.hidden = rendered >= filtered.length;
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
        allData = allData.concat(fresh);
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
    searchInput.addEventListener("input", function () { st.q = searchInput.value; rerun(); });

    // 分类 tab
    $("catTabs").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab"); if (!btn) return;
      var tabs = this.querySelectorAll(".tab");
      for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("is-active");
      btn.classList.add("is-active");
      st.cat = btn.getAttribute("data-cat");
      st.favOnly = false; syncFavBtn();
      rerun();
    });

    // 排序
    $("sortSelect").addEventListener("change", function () { st.sort = this.value; rerun(); });
    // 显示范围:过往项目 / 即将开启(默认勾选,取消即隐藏对应组)
    // 防御:元素缺失(如 HTML/JS 版本因缓存错配)也不抛错,避免搞垮后续所有绑定。
    var _sp = $("showPast"), _su = $("showUpcoming");
    if (_sp) _sp.addEventListener("change", function () { st.showPast = this.checked; rerun(); });
    if (_su) _su.addEventListener("change", function () { st.showUpcoming = this.checked; rerun(); });

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
      $("freeOnly").checked = false; $("verifiedOnly").checked = false;
      var fb = document.querySelectorAll("[data-fund]"); for (var k = 0; k < fb.length; k++) fb[k].checked = false;
      var chips = document.querySelectorAll("#regionChips .chip, #discChips .chip");
      for (var j = 0; j < chips.length; j++) chips[j].classList.remove("is-active");
      rerun();
    }
    $("clearFilters").addEventListener("click", clearAll);
    $("emptyClear").addEventListener("click", clearAll);

    // 收藏视图
    $("favToggleBtn").addEventListener("click", function () {
      st.favOnly = !st.favOnly; syncFavBtn(); rerun();
    });

    // 语言切换
    $("langBtn").addEventListener("click", function () {
      AP.setLang(AP.lang === "zh" ? "en" : "zh");
      rerun();
      var r = AP.router.parse();
      if (r.name === "detail") { var o = byId(r.id); if (o) $("detailBody").innerHTML = AP.renderDetail(o); }
      syncFavCount();
    });

    // 提交机会(占位)
    $("submitBtn").addEventListener("click", function (e) {
      if (!SUBMIT_FORM_URL) { e.preventDefault(); toast(AP.lang === "en" ? "Submission form coming soon" : "投稿表单链接待配置"); }
      else { this.href = SUBMIT_FORM_URL; }
    });

    // AI 全网检索(调后端 /api/search,仅在 node server.mjs 下可用)
    var aiBtn = $("aiSearchBtn");
    if (aiBtn) aiBtn.addEventListener("click", runAiSearch);
    var aiCancel = $("aiCancelBtn");
    if (aiCancel) aiCancel.addEventListener("click", cancelAiSearch);

    // 列表点击委托:复制 / 访问 / 打开详情
    grid.addEventListener("click", function (e) {
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

    // 路由变化
    AP.router.onChange(syncRoute);

    syncFavCount();
  }

  function toggleSetChip(chipEl, set, val) {
    if (set.has(val)) { set.delete(val); chipEl.classList.remove("is-active"); }
    else { set.add(val); chipEl.classList.add("is-active"); }
  }
  function syncFavBtn() {
    $("favToggleBtn").classList.toggle("btn--dark", AP.filterState.favOnly);
    $("favToggleBtn").classList.toggle("btn--ghost", !AP.filterState.favOnly);
  }
  function syncFavCount() {
    var n = AP.favorites.count(), el = $("favCount");
    el.textContent = n; el.hidden = n === 0;
  }

  function byId(id) {
    for (var i = 0; i < allData.length; i++) if (allData[i].id === id) return allData[i];
    return null;
  }

  // ---------- 详情开关(由路由驱动) ----------
  function syncRoute() {
    var r = AP.router.parse();
    if (r.name === "detail") {
      var o = byId(r.id);
      if (o) openDetail(o); else AP.router.goList();
    } else {
      closeDetail();
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

  // ---------- AI 全网检索(后端 /api/search:搜索→抓官网→逐字校验→真实的才入库)----------
  var aiSearching = false, aiCtrl = null, aiDone = false, aiTo = null;
  function runAiSearch() {
    if (aiSearching) return;
    var q = ($("searchInput").value || "").trim();
    if (!q) { toast(AP.lang === "en" ? "Type what you're looking for first" : "请先在搜索框输入想找的主题/展览"); $("searchInput").focus(); return; }
    aiSearching = true; aiDone = false;
    var btn = $("aiSearchBtn"); if (btn) { btn.disabled = true; btn.classList.add("is-loading"); }
    $("aiOverlayQ").textContent = "「" + q + "」";
    $("aiOverlay").hidden = false;
    // 超时保护:检索最长等 170 秒,超时自动收起覆盖层并提示(避免永远转圈);用户也可随时点"取消"。
    aiCtrl = ("AbortController" in window) ? new AbortController() : null;
    aiTo = setTimeout(function () {
      if (aiDone) return; aiDone = true;
      if (aiCtrl) aiCtrl.abort();
      finishAi(btn);
      toast(AP.lang === "en" ? "Timed out (search source may be rate-limited). Refresh to see any saved; try again later or set SERPER_API_KEY." : "检索超时(搜索源可能被限流)。刷新后能看到已入库的;稍后再试,或配置 SERPER_API_KEY 稳定检索");
    }, 170000);
    fetch("/api/search?q=" + encodeURIComponent(q), aiCtrl ? { signal: aiCtrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (aiDone) return; aiDone = true; clearTimeout(aiTo); finishAi(btn);
        if (res && res.error) { toast(res.message || (AP.lang === "en" ? "Search error" : "检索出错,请确认后端服务已启动")); return; }
        var add = (res && res.added) || [];
        var known = {}; for (var i = 0; i < allData.length; i++) known[allData[i].id] = 1;
        var fresh = add.filter(function (o) { return !known[o.id]; });
        if (!fresh.length) { toast(AP.lang === "en" ? "No new real ones found (never fabricated). Try another term." : "本次没找到新的真实机会(绝不编造)。换个词再试"); return; }
        allData = allData.concat(fresh);
        rerun();
        toast(AP.lang === "en" ? ("Added " + fresh.length + " real opportunities, saved") : ("新增 " + fresh.length + " 条真实机会,已永久入库"));
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
    var ov = $("aiOverlay"); if (ov) ov.hidden = true;
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
  var toastTimer;
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 1800);
  }
})();
