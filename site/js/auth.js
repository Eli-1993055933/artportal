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
  var codeRequired = false;      // 服务端发信已配置 → 注册必须邮箱验证码(/me 下发)

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
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j }; }); });
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
  // 会话确认成立时调用:记住"这台设备登录过谁"(下次掉线弹墙直接给登录页+预填邮箱),
  // 并清零免费点击计数(将来若 cookie 丢失,至少还有 3 次缓冲,不会一点就撞墙)。
  function rememberAuthed(u) {
    try {
      if (u && u.email) localStorage.setItem("ap_email", u.email);
      localStorage.setItem("ap_ow", "0");
    } catch (e) {}
  }
  function knownEmail() { try { return localStorage.getItem("ap_email") || ""; } catch (e) { return ""; } }

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
    openGateWall();
  }, true);

  // 弹墙(修 bug:已登录用户被误拦):
  // ① 这台设备登录过 → 直接给登录页并预填邮箱(输密码就走),不再让人"再注册一遍";
  // ② 弹墙同时向后端复核一次会话——首屏 /me 请求在弱网下失败/超时会把已登录用户误判成
  //    匿名,复核确认在登录就立刻撤墙,换成"前往官网"按钮(保留真实手势,弹窗不被拦)。
  function openGateWall() {
    var em = knownEmail();
    if (em) {
      openModal("login", AP.t("gateWelcomeBack"));
      var input = document.getElementById("authEmail");
      if (input) { input.value = em; }
      setTimeout(function () { var pw = document.getElementById("authPw"); if (pw) pw.focus(); }, 60);
    } else {
      openModal("register", AP.t("gateWallMsg"));
    }
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j) codeRequired = !!j.email_code_required;
        if (!(j && j.user)) return;
        user = j.user; sessionReady = true;
        rememberAuthed(user);
        updateTopbar();
        var go = pendingUrl; pendingUrl = null;
        var modal = document.getElementById("authModal");
        if (go && modal && !modal.hidden) showGoStep(go, AP.t("authWelcomeBack"));
      })
      .catch(function () {});
  }

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
          '<div class="auth__coderow" id="authCodeRow" hidden>' +
            '<input type="text" id="authCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code" />' +
            '<button type="button" class="btn btn--ghost auth__sendcode" id="authSendCode"></button>' +
          '</div>' +
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
    document.getElementById("authSendCode").addEventListener("click", sendCode);
  }
  // 发送邮箱验证码(60 秒倒计时防连点;错误直接显示在表单错误位)
  var codeTimer = null;
  function sendCode() {
    var email = document.getElementById("authEmail").value.trim();
    var err = document.getElementById("authErr");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { err.textContent = AP.t("authBadEmail"); return; }
    var btn = document.getElementById("authSendCode");
    btn.disabled = true;
    post("/api/auth/sendcode", { email: email }).then(function (r) {
      if (!r.ok) {
        btn.disabled = false;
        err.textContent = (r.data && r.data.error) || AP.t("authNetErr");
        if (r.status === 409) setMode("login");   // 已注册 → 直接切登录页
        return;
      }
      err.textContent = "";
      toast(AP.t("authCodeSent"));
      var left = 60;
      btn.textContent = AP.t("authCodeResend") + " " + left + "s";
      clearInterval(codeTimer);
      codeTimer = setInterval(function () {
        left--;
        if (left <= 0) { clearInterval(codeTimer); btn.disabled = false; btn.textContent = AP.t("authSendCode"); }
        else btn.textContent = AP.t("authCodeResend") + " " + left + "s";
      }, 1000);
    }).catch(function () { btn.disabled = false; err.textContent = AP.t("authNetErr"); });
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
    // 验证码行:仅注册页且服务端开了发信才显示
    document.getElementById("authCodeRow").hidden = !(mode === "register" && codeRequired);
    document.getElementById("authCode").placeholder = AP.t("authCodePh");
    var sc = document.getElementById("authSendCode");
    if (!sc.disabled) sc.textContent = AP.t("authSendCode");
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
    var code = document.getElementById("authCode").value.trim();
    if (mode === "register" && codeRequired && code.length !== 6) { err.textContent = AP.t("authCodeNeed"); return; }
    var btn = document.getElementById("authSubmit");
    btn.disabled = true;
    post(mode === "register" ? "/api/auth/register" : "/api/auth/login", { email: email, password: pw, code: code })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          // 已有账号的用户在注册页提交(409)→ 自动切到登录页,邮箱保留、光标进密码框,
          // 不让人卡在"该邮箱已注册"干瞪眼(bug 报告的另一half:被要求"再注册一遍")
          if (mode === "register" && r.status === 409) {
            setMode("login");
            document.getElementById("authErr").textContent = (r.data && r.data.error) || "";
            var pwEl = document.getElementById("authPw"); if (pwEl) pwEl.focus();
            return;
          }
          err.textContent = r.data && r.data.error ? r.data.error : AP.t("authNetErr");
          return;
        }
        onAuthed(r.data.user, mode === "register");
      })
      .catch(function () { btn.disabled = false; err.textContent = AP.t("authNetErr"); });
  }

  function onAuthed(u, isNew) {
    user = u;
    rememberAuthed(u);             // 记住设备登录过 + 清零免费点击计数
    mergeFavoritesOnLogin(u);      // 显式登录/注册:把匿名期攒的本地收藏并入账号(迁移时机)
    updateTopbar();
    if (AP.profilePage) AP.profilePage.reload();   // 正停在别人主页登录 → 按新身份重取(关注按钮状态)
    var go = pendingUrl; pendingUrl = null;
    toast(isNew ? AP.t("authWelcomeNew") : AP.t("authWelcomeBack"));
    // 注册墙场景:不能在 fetch 回调里 window.open(微信/iOS 会拦弹窗)。
    // 改成弹窗内放一个真链接按钮,由用户亲手点击(真实手势)打开官网。
    if (go) { showGoStep(go, isNew ? AP.t("authWelcomeNew") : AP.t("authWelcomeBack")); requireProfile(); return; }
    var el = document.getElementById("authModal");
    if (el) el.hidden = true;
    requireProfile();   // 昵称/头像缺失 → 立即补全(新注册与老用户登录同样强制)
  }
  function showGoStep(url, title) {
    var panel = document.querySelector("#authModal .auth__panel");
    if (!panel) { window.open(url, "_blank", "noopener"); return; }
    panel.innerHTML =
      '<button class="auth__close" id="authClose2" type="button" aria-label="关闭">✕</button>' +
      '<h2 class="auth__title">' + esc(title || AP.t("authWelcomeBack")) + '</h2>' +
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

  // ---------- 顶栏入口(放在中/EN 右侧;点头像直达"我的主页",收藏/编辑资料/退出都在主页里) ----------
  function updateTopbar() {
    var actions = document.querySelector(".topbar__actions");
    if (!actions) return;
    var btn = document.getElementById("authBtn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button"; btn.id = "authBtn"; btn.className = "btn btn--ghost auth-btn";
      actions.appendChild(btn);               // 最右(中/EN 之后)
      btn.addEventListener("click", function () {
        if (!user) { openModal("login", null); return; }
        AP.router.goUser(user.id);            // 直达我的主页,不再弹菜单
      });
    }
    btn.setAttribute("aria-label", AP.t(user ? "menuMyPage" : "authLoginBtn"));
    if (AP.notify) AP.notify.sync();   // 登录态变化 → 铃铛显隐与未读轮询同步
    if (user) {
      var name = user.nickname || user.email.split("@")[0];
      var label = name.length > 10 ? name.slice(0, 9) + "…" : name;
      btn.textContent = "";
      if (user.avatar) {
        var im = document.createElement("img");
        im.className = "auth-avatar"; im.alt = ""; im.src = user.avatar;
        btn.appendChild(im);
      }
      var nm = document.createElement("span");   // 名字包进 span:手机端有头像时 CSS 隐藏文字只留头像
      nm.className = "auth-btn__name";
      nm.textContent = label;
      btn.appendChild(nm);
      btn.removeAttribute("data-i18n");
    } else {
      btn.textContent = AP.t("authLoginBtn");
      btn.setAttribute("data-i18n", "authLoginBtn");   // 语言切换时由 applyI18n 更新
    }
  }
  // 退出登录(由用户主页的"退出登录"按钮调用,顶栏不再有菜单)
  function doLogout() {
    post("/api/auth/logout", {}).then(function () {
      user = null; updateTopbar();
      try { localStorage.removeItem("ap_email"); } catch (e) {}   // 主动退出=不再替这台设备记邮箱(共用电脑不泄露)
      // 清空本地收藏,防同一浏览器换账号登录时把上个账号的收藏并进来(跨账号串号)
      AP.favorites.replaceAll([]);
      if (typeof AP.syncFavCount === "function") AP.syncFavCount();
      if (AP.filterState && AP.filterState.favOnly && typeof AP.rerun === "function") AP.rerun();
      if (AP.profilePage) AP.profilePage.reload();   // 正停在用户主页 → 按访客身份整页重取
      toast(AP.t("authLoggedOut"));
    });
  }

  // ---------- 资料补全(昵称+头像,全站必填;老用户下次进站强制补) ----------
  var avatarData = null;
  function profileModal() {
    var el = document.getElementById("profileModal");
    if (el) return el;
    el = document.createElement("div");
    el.className = "auth"; el.id = "profileModal"; el.hidden = true;
    // 刻意不给关闭按钮/遮罩关闭:昵称头像是必填项,填完才能继续(用户要求"必须立刻补上")
    el.innerHTML =
      '<div class="auth__scrim"></div>' +
      '<div class="auth__panel" role="dialog" aria-modal="true">' +
        '<h2 class="auth__title">' + esc(AP.t("pfTitle")) + '</h2>' +
        '<p class="auth__note">' + esc(AP.t("pfNote")) + '</p>' +
        '<form class="auth__form" id="pfForm" novalidate>' +
          '<input type="text" id="pfNick" maxlength="20" placeholder="' + esc(AP.t("pfPhNick")) + '" autocomplete="nickname" />' +
          '<div class="pf-ava">' +
            '<img id="pfPrev" alt="" />' +
            '<div class="pf-ava__btns">' +
              '<label class="btn btn--ghost pf-file">' + esc(AP.t("pfUpload")) + '<input type="file" id="pfFile" accept="image/*" hidden /></label>' +
              '<button type="button" class="btn btn--ghost" id="pfGen">' + esc(AP.t("pfDefault")) + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="auth__err" id="pfErr"></div>' +
          '<button type="submit" class="btn btn--dark auth__submit" id="pfGo">' + esc(AP.t("pfSave")) + '</button>' +
        '</form>' +
      '</div>';
    document.body.appendChild(el);
    document.getElementById("pfFile").addEventListener("change", onAvatarPick);
    document.getElementById("pfGen").addEventListener("click", genDefaultAvatar);
    document.getElementById("pfForm").addEventListener("submit", onProfileSubmit);
    return el;
  }
  // 头像统一 256×256 JPEG:上传图居中裁方再压缩(裁剪器的兜底,也供旧调用)
  function drawSquare(img) {
    var c = document.createElement("canvas"); c.width = 256; c.height = 256;
    var g = c.getContext("2d");
    var s = Math.min(img.width, img.height);
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
    return c.toDataURL("image/jpeg", 0.82);
  }

  // ---------- 头像裁剪器:拖动选取位置 + 滑杆缩放,圆形取景参考线,输出 256px JPEG ----------
  // 资料补全弹窗与"编辑资料"(profile.js)共用;鼠标/触屏都可拖。
  var CROP_V = 280;                                   // 取景框边长(canvas 分辨率;显示宽随屏收缩)
  function openCropper(img, done) {
    var old = document.getElementById("cropModal");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "auth cropper"; el.id = "cropModal";
    el.innerHTML =
      '<div class="auth__scrim"></div>' +
      '<div class="auth__panel cropper__panel" role="dialog" aria-modal="true">' +
        '<h2 class="auth__title">' + esc(AP.t("crTitle")) + '</h2>' +
        '<p class="auth__note">' + esc(AP.t("crHint")) + '</p>' +
        '<canvas class="cropper__canvas" id="cropCanvas" width="' + CROP_V + '" height="' + CROP_V + '"></canvas>' +
        '<input type="range" class="cropper__zoom" id="cropZoom" min="100" max="300" value="100" aria-label="' + esc(AP.t("crZoom")) + '" />' +
        '<div class="cropper__btns">' +
          '<button type="button" class="btn btn--ghost" id="cropCancel">' + esc(AP.t("aiCancel")) + '</button>' +
          '<button type="button" class="btn btn--dark" id="cropOk">' + esc(AP.t("crOk")) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    var cv = document.getElementById("cropCanvas"), g = cv.getContext("2d");
    var cover = Math.max(CROP_V / img.width, CROP_V / img.height);   // 最小缩放=铺满取景框
    var scale = cover;
    var ox = (CROP_V - img.width * scale) / 2, oy = (CROP_V - img.height * scale) / 2;
    function clamp() {   // 图片任何时候都盖满取景框,不留白边
      ox = Math.min(0, Math.max(CROP_V - img.width * scale, ox));
      oy = Math.min(0, Math.max(CROP_V - img.height * scale, oy));
    }
    function draw() {
      g.clearRect(0, 0, CROP_V, CROP_V);
      g.drawImage(img, ox, oy, img.width * scale, img.height * scale);
      // 圆形取景参考:头像最终是圆的,圈外压暗提示会被裁掉(只画在预览,不影响输出)
      g.fillStyle = "rgba(0,0,0,.38)";
      g.beginPath();
      g.rect(0, 0, CROP_V, CROP_V);
      g.arc(CROP_V / 2, CROP_V / 2, CROP_V / 2 - 1, 0, Math.PI * 2, true);
      g.fill("evenodd");
    }
    clamp(); draw();
    document.getElementById("cropZoom").addEventListener("input", function () {
      var ns = cover * (Number(this.value) / 100);
      // 围绕取景框中心缩放:中心处的原图像素保持不动
      ox = CROP_V / 2 - (CROP_V / 2 - ox) * (ns / scale);
      oy = CROP_V / 2 - (CROP_V / 2 - oy) * (ns / scale);
      scale = ns;
      clamp(); draw();
    });
    // 拖动(鼠标 + 触屏)。canvas 显示宽可能被压缩,位移按分辨率/显示宽换算。
    var drag = null, pxRatio = 1;
    function start(x, y) { pxRatio = CROP_V / cv.getBoundingClientRect().width; drag = { x: x, y: y }; }
    function move(x, y) {
      if (!drag) return;
      ox += (x - drag.x) * pxRatio; oy += (y - drag.y) * pxRatio;
      drag = { x: x, y: y };
      clamp(); draw();
    }
    function onMouseMove(e) { move(e.clientX, e.clientY); }
    function onMouseUp() { drag = null; }
    cv.addEventListener("mousedown", function (e) { e.preventDefault(); start(e.clientX, e.clientY); });
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    cv.addEventListener("touchstart", function (e) { if (e.touches.length === 1) { e.preventDefault(); start(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
    cv.addEventListener("touchmove", function (e) { if (e.touches.length === 1) { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
    cv.addEventListener("touchend", function () { drag = null; });
    function cleanup() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      el.remove();
    }
    document.getElementById("cropCancel").addEventListener("click", cleanup);
    el.querySelector(".auth__scrim").addEventListener("click", cleanup);
    document.getElementById("cropOk").addEventListener("click", function () {
      var out = document.createElement("canvas"); out.width = 256; out.height = 256;
      var k = 256 / CROP_V;
      out.getContext("2d").drawImage(img, ox * k, oy * k, img.width * scale * k, img.height * scale * k);
      cleanup();
      done(out.toDataURL("image/jpeg", 0.84));
    });
  }

  function onAvatarPick() {
    var input = document.getElementById("pfFile");
    var f = input.files[0];
    var err = document.getElementById("pfErr");
    if (!f) return;
    input.value = "";                                  // 允许下次重选同一文件
    if (!/^image\//.test(f.type)) { err.textContent = AP.t("pfErrImg"); return; }
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      openCropper(img, function (dataURL) {            // 用户自己调位置与大小
        avatarData = dataURL;
        var p = document.getElementById("pfPrev"); p.src = avatarData; p.classList.add("has");
        err.textContent = "";
      });
    };
    img.onerror = function () { URL.revokeObjectURL(url); err.textContent = AP.t("pfErrImg"); };
    img.src = url;
  }
  // 默认头像:昵称首字 + 按昵称哈希取色(没图也能 2 秒完成)。makeAvatar 是纯函数,编辑资料弹窗(profile.js)也用它。
  function makeAvatar(nick) {
    nick = (nick || "").trim() || (user && user.email ? user.email[0] : "A");
    var h = 0; for (var i = 0; i < nick.length; i++) h = (h * 31 + nick.charCodeAt(i)) >>> 0;
    var c = document.createElement("canvas"); c.width = 256; c.height = 256;
    var g = c.getContext("2d");
    g.fillStyle = "hsl(" + (h % 360) + ", 48%, 46%)"; g.fillRect(0, 0, 256, 256);
    g.fillStyle = "#fff"; g.font = "700 128px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(nick.charAt(0).toUpperCase(), 128, 140);
    return c.toDataURL("image/jpeg", 0.85);
  }
  function genDefaultAvatar() {
    avatarData = makeAvatar(document.getElementById("pfNick").value);
    var p = document.getElementById("pfPrev"); p.src = avatarData; p.classList.add("has");
    document.getElementById("pfErr").textContent = "";
  }
  function onProfileSubmit(e) {
    e.preventDefault();
    var err = document.getElementById("pfErr");
    var nick = document.getElementById("pfNick").value.trim();
    if (nick.length < 2) { err.textContent = AP.t("pfErrNick"); return; }
    if (!avatarData && !(user && user.avatar)) { err.textContent = AP.t("pfErrAva"); return; }
    var btn = document.getElementById("pfGo");
    btn.disabled = true;
    post("/api/auth/profile", { nickname: nick, avatar: avatarData || "" })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          err.textContent = (r.data && r.data.error) || AP.t("authNetErr");
          if (r.data && r.data.suggest) document.getElementById("pfNick").value = r.data.suggest;
          return;
        }
        user = r.data.user;
        avatarData = null;
        updateTopbar();
        document.getElementById("profileModal").hidden = true;
        toast(AP.t("pfDone"));
      })
      .catch(function () { btn.disabled = false; err.textContent = AP.t("authNetErr"); });
  }
  function requireProfile() {
    if (!user || !user.needs_profile) return;
    profileModal();
    document.getElementById("pfNick").value = user.nickname || "";
    if (user.avatar) { var p = document.getElementById("pfPrev"); p.src = user.avatar; p.classList.add("has"); }
    document.getElementById("profileModal").hidden = false;
    setTimeout(function () { document.getElementById("pfNick").focus(); }, 60);
  }

  // 供其他模块(投稿/用户主页等)使用的最小接口
  AP.auth = {
    isIn: function () { return !!user; },
    current: function () { return user; },                      // 当前登录用户(含自己的公开资料字段)
    apply: function (u) { user = u; updateTopbar(); },          // 编辑资料保存后同步登录态与顶栏
    openLogin: function (note) { openModal("login", note || null); },
    logout: doLogout,                                           // 退出登录(用户主页调用)
    squareFromImg: drawSquare,                                  // 图片 → 居中裁方 256px JPEG dataURL(兜底)
    openCropper: openCropper,                                   // 头像裁剪器(拖动+缩放选范围)
    makeAvatar: makeAvatar                                      // 昵称 → 默认头像 dataURL
  };

  // ---------- 启动:恢复会话 + 访问上报 + 心跳 ----------
  function init() {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        user = j && j.user ? j.user : null;
        codeRequired = !!(j && j.email_code_required);   // 服务端发信配好 → 注册需验证码
        sessionReady = true;
        if (user) { rememberAuthed(user); adoptFavorites(user); }   // 会话有效:记住设备+清零计数
        updateTopbar();
        requireProfile();   // 老用户没补昵称/头像 → 进站即提示必须补上
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
