/* 账号:注册/登录弹窗、「前往官网」注册墙(前 3 次免费)、收藏云同步、在线心跳。
   设计:未登录也能完整浏览;只在点官网外链时计数,用完 3 次弹注册(高意愿时机)。
   注册最简:邮箱 + 密码两个字段,注册即登录;更多资料留待社区功能上线再补(渐进式)。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var FREE_CLICKS = 3;
  var user = null;
  var sessionReady = false;      // /api/auth/me 是否已返回(未返回前不拿本地 user 判定登录态)
  var pendingUrl = null;
  var mode = "register";
  var toastTimer = null;

  // ---------- 基础 ----------
  function anonId() {
    try {
      var v = localStorage.getItem("ap_anon");
      if (!v) { v = "a" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); localStorage.setItem("ap_anon", v); }
      return v;
    } catch (e) { return "a0"; }
  }
  function post(url, data) {
    return fetch(url, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {})
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); });
  }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    // 与 app.js 共用同一 #toast:把定时器 id 挂在元素上,互相能清对方,避免旧定时器提前隐藏新提示
    clearTimeout(t._apTimer);
    t._apTimer = setTimeout(function () { t.hidden = true; }, 3000);
  }
  function clicksUsed() { try { return parseInt(localStorage.getItem("ap_ow") || "0", 10) || 0; } catch (e) { return 0; } }
  function useClick() { try { localStorage.setItem("ap_ow", String(clicksUsed() + 1)); } catch (e) {} }

  // ---------- 注册墙:捕获阶段拦「前往官网」 ----------
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-gate="official"]') : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    // 会话状态还没确定(/me 未返回)→ 一律放行,不扣次数、不弹墙(否则已登录用户被误判)
    if (user || !sessionReady) { post("/api/track", { type: "outbound", id: href, anon: anonId() }); return; }
    var used = clicksUsed();
    if (used < FREE_CLICKS) {
      useClick();
      post("/api/track", { type: "outbound", id: href, anon: anonId() });
      var left = FREE_CLICKS - used - 1;
      toast(left > 0 ? AP.t("gateLeft").replace("{n}", left) : AP.t("gateLast"));
      return;                       // 放行默认跳转
    }
    e.preventDefault(); e.stopPropagation();
    pendingUrl = href;
    openModal("register", AP.t("gateWallMsg"));
  }, true);

  // ---------- 弹窗 ----------
  var PANEL_HTML =
      '<div class="auth__scrim" id="authScrim"></div>' +
      '<div class="auth__panel" role="dialog" aria-modal="true" aria-labelledby="authTitle">' +
        '<button class="auth__close" id="authClose" type="button" aria-label="关闭">✕</button>' +
        '<h2 class="auth__title" id="authTitle"></h2>' +
        '<p class="auth__note" id="authNote"></p>' +
        '<div class="auth__tabs">' +
          '<button type="button" data-mode="register" id="authTabReg"></button>' +
          '<button type="button" data-mode="login" id="authTabLog"></button>' +
        '</div>' +
        '<form class="auth__form" id="authForm" novalidate>' +
          '<input type="email" id="authEmail" autocomplete="email" />' +
          '<input type="password" id="authPw" autocomplete="current-password" minlength="6" />' +
          '<div class="auth__err" id="authErr"></div>' +
          '<button type="submit" class="btn btn--dark auth__submit" id="authSubmit"></button>' +
        '</form>' +
        '<p class="auth__privacy" id="authPrivacy"></p>' +
      '</div>';
  function wireModal() {
    document.getElementById("authClose").addEventListener("click", closeModal);
    document.getElementById("authScrim").addEventListener("click", closeModal);
    document.getElementById("authTabReg").addEventListener("click", function () { setMode("register"); });
    document.getElementById("authTabLog").addEventListener("click", function () { setMode("login"); });
    document.getElementById("authForm").addEventListener("submit", onSubmit);
  }
  function buildModal() {
    var wrap = document.getElementById("authModal");
    if (wrap) {
      // 表单被 showGoStep 替换过 → 恢复表单结构
      if (!document.getElementById("authForm")) { wrap.innerHTML = PANEL_HTML; wireModal(); }
      return;
    }
    wrap = document.createElement("div");
    wrap.className = "auth"; wrap.id = "authModal"; wrap.hidden = true;
    wrap.innerHTML = PANEL_HTML;
    document.body.appendChild(wrap);
    wireModal();
    // 只有账号弹窗打开时才吞 Esc(用捕获阶段 + stopImmediatePropagation,防连带关掉详情页)
    document.addEventListener("keydown", function (e) {
      var m = document.getElementById("authModal");
      if (e.key === "Escape" && m && !m.hidden) { e.stopImmediatePropagation(); closeModal(); }
    }, true);
  }
  function applyTexts(note) {
    document.getElementById("authTabReg").textContent = AP.t("authRegister");
    document.getElementById("authTabLog").textContent = AP.t("authLogin");
    document.getElementById("authTitle").textContent = mode === "register" ? AP.t("authTitleReg") : AP.t("authTitleLog");
    document.getElementById("authNote").textContent = note || AP.t("authNoteDefault");
    document.getElementById("authEmail").placeholder = AP.t("authEmailPh");
    document.getElementById("authPw").placeholder = AP.t("authPwPh");
    document.getElementById("authSubmit").textContent = mode === "register" ? AP.t("authSubmitReg") : AP.t("authSubmitLog");
    document.getElementById("authPrivacy").textContent = AP.t("authPrivacy");
    var tr = document.getElementById("authTabReg"), tl = document.getElementById("authTabLog");
    tr.className = mode === "register" ? "is-active" : ""; tl.className = mode === "login" ? "is-active" : "";
  }
  var lastNote = null;
  function setMode(m) { mode = m; applyTexts(lastNote); document.getElementById("authErr").textContent = ""; }
  function openModal(m, note) {
    buildModal();
    mode = m || "register"; lastNote = note || null;
    applyTexts(lastNote);
    document.getElementById("authErr").textContent = "";
    document.getElementById("authModal").hidden = false;
    setTimeout(function () { document.getElementById("authEmail").focus(); }, 50);
  }
  function closeModal() {
    var el = document.getElementById("authModal");
    if (el) el.hidden = true;
    pendingUrl = null;
  }

  function onSubmit(e) {
    e.preventDefault();
    var email = document.getElementById("authEmail").value.trim();
    var pw = document.getElementById("authPw").value;
    var err = document.getElementById("authErr");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = AP.t("authBadEmail"); return; }
    if (pw.length < 6) { err.textContent = AP.t("authBadPw"); return; }
    var btn = document.getElementById("authSubmit");
    btn.disabled = true;
    post(mode === "register" ? "/api/auth/register" : "/api/auth/login", { email: email, password: pw })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) { err.textContent = r.data && r.data.error ? r.data.error : AP.t("authNetErr"); return; }
        onAuthed(r.data.user, mode === "register");
      })
      .catch(function () { btn.disabled = false; err.textContent = AP.t("authNetErr"); });
  }

  function onAuthed(u, isNew) {
    user = u;
    mergeFavoritesOnLogin(u);      // 显式登录/注册:把匿名期攒的本地收藏并入账号(迁移时机)
    updateTopbar();
    var go = pendingUrl; pendingUrl = null;
    toast(isNew ? AP.t("authWelcomeNew") : AP.t("authWelcomeBack"));
    // 注册墙场景:不能在 fetch 回调里 window.open(微信/iOS 会拦弹窗)。
    // 改成弹窗内放一个真链接按钮,由用户亲手点击(真实手势)打开官网。
    if (go) { showGoStep(go); return; }
    var el = document.getElementById("authModal");
    if (el) el.hidden = true;
  }
  function showGoStep(url) {
    var panel = document.querySelector("#authModal .auth__panel");
    if (!panel) { window.open(url, "_blank", "noopener"); return; }
    panel.innerHTML =
      '<button class="auth__close" id="authClose2" type="button" aria-label="关闭">✕</button>' +
      '<h2 class="auth__title">' + esc(AP.t("authWelcomeNew")) + '</h2>' +
      '<p class="auth__note">' + esc(AP.t("gateGoNote")) + '</p>' +
      '<a class="btn btn--dark auth__submit" id="authGo" href="' + esc(url) + '" target="_blank" rel="noopener" style="display:flex;text-decoration:none">' + esc(AP.t("gateGoBtn")) + '</a>';
    document.getElementById("authClose2").addEventListener("click", closeModal);
    document.getElementById("authGo").addEventListener("click", function () { setTimeout(closeModal, 100); });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  // ---------- 收藏云同步:登录时"本地 ∪ 云端"合并,之后本地变更防抖推送 ----------
  var pushTimer = null;
  function pushFavorites() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      if (user) post("/api/favorites", { ids: AP.favorites.ids() });
    }, 800);
  }
  // 会话恢复(刷新页面时):云端为准,直接覆盖本地。
  // 不做并集——否则一端删除的收藏会被另一端的旧本地副本"复活"并推回云端。
  function adoptFavorites(u) {
    AP.favorites.replaceAll((u && u.favorites) || []);
    refreshFavUI();
  }
  // 显式登录/注册(迁移时机):把匿名期本地收藏并入云端一次,之后以云端为准。
  function mergeFavoritesOnLogin(u) {
    var local = AP.favorites.ids();
    var remote = (u && u.favorites) || [];
    var seen = {}, out = [], i;
    for (i = 0; i < remote.length; i++) if (!seen[remote[i]]) { seen[remote[i]] = 1; out.push(remote[i]); }
    for (i = 0; i < local.length; i++) if (!seen[local[i]]) { seen[local[i]] = 1; out.push(local[i]); }
    AP.favorites.replaceAll(out);
    if (out.length !== remote.length) post("/api/favorites", { ids: out });   // 有新增才推
    refreshFavUI();
  }
  function refreshFavUI() {
    if (typeof AP.syncFavCount === "function") AP.syncFavCount();
    if (AP.filterState && AP.filterState.favOnly && typeof AP.rerun === "function") AP.rerun();
  }
  AP.favorites.onChange = pushFavorites;

  // ---------- 顶栏入口 ----------
  function updateTopbar() {
    var actions = document.querySelector(".topbar__actions");
    if (!actions) return;
    var btn = document.getElementById("authBtn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button"; btn.id = "authBtn"; btn.className = "btn btn--ghost auth-btn";
      actions.insertBefore(btn, document.getElementById("langBtn"));
      btn.addEventListener("click", function () {
        if (!user) { openModal("login", null); return; }
        toggleMenu(btn);
      });
    }
    if (user) {
      var name = user.nickname || user.email.split("@")[0];
      btn.textContent = name.length > 10 ? name.slice(0, 9) + "…" : name;
      btn.removeAttribute("data-i18n");
    } else {
      btn.textContent = AP.t("authLoginBtn");
      btn.setAttribute("data-i18n", "authLoginBtn");   // 语言切换时由 applyI18n 更新
    }
  }
  function toggleMenu(anchor) {
    var m = document.getElementById("authMenu");
    if (m) { m.remove(); return; }
    m = document.createElement("div");
    m.className = "auth-menu"; m.id = "authMenu";
    var emailDiv = document.createElement("div");
    emailDiv.className = "auth-menu__email"; emailDiv.textContent = user.email;
    var out = document.createElement("button");
    out.type = "button"; out.textContent = AP.t("authLogout");
    out.addEventListener("click", function () {
      post("/api/auth/logout", {}).then(function () {
        user = null; updateTopbar();
        // 清空本地收藏,防同一浏览器换账号登录时把上个账号的收藏并进来(跨账号串号)
        AP.favorites.replaceAll([]);
        var fc = document.getElementById("favCount"); if (fc) { fc.textContent = "0"; fc.hidden = true; }
        if (AP.filterState && AP.filterState.favOnly && typeof AP.rerun === "function") AP.rerun();
        var mm = document.getElementById("authMenu"); if (mm) mm.remove();
        toast(AP.t("authLoggedOut"));
      });
    });
    m.appendChild(emailDiv); m.appendChild(out);
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 6) + "px";
    m.style.right = Math.max(8, window.innerWidth - r.right) + "px";
    setTimeout(function () {
      // 只有真正点到菜单外才移除并解绑;点在菜单内(如邮箱行)不消耗监听,否则会关不掉
      document.addEventListener("click", function outside(ev) {
        if (m.contains(ev.target) || ev.target === anchor) return;
        m.remove();
        document.removeEventListener("click", outside);
      });
    }, 0);
  }

  // ---------- 启动:恢复会话 + 访问上报 + 心跳 ----------
  function init() {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        user = j && j.user ? j.user : null;
        sessionReady = true;
        if (user) adoptFavorites(user);
        updateTopbar();
      })
      .catch(function () { sessionReady = true; updateTopbar(); });
    post("/api/track", { type: "visit", anon: anonId() });
    setInterval(function () {
      if (!document.hidden) post("/api/track", { type: "hb", anon: anonId() });
    }, 60000);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
