/* 用户主页(路线图 8.1):#/u/<uid> 深链可分享(微信群传播,同 #/o/)。
   展示:头像/昵称/身份/所在地/加入时间/简介/创作领域/个人网站 + tabs(收藏/投稿)。
   本人可编辑资料:昵称(7 天一改)/头像/简介/身份/领域/所在地/网站/收藏公开开关;
   文本字段由后端机审(敏感词+DeepSeek),他人收藏尊重隐私开关。
   红线:/api/users/<uid> 只回公开字段,绝不含邮箱。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._apTimer);
    t._apTimer = setTimeout(function () { t.hidden = true; }, 2500);
  }

  var root = null, current = null, curTab = "favs", curUid = null;

  function build() {
    if (root) return;
    root = document.createElement("div");
    root.className = "ppage"; root.id = "profilePage"; root.hidden = true;
    document.body.appendChild(root);
    root.addEventListener("click", function (e) {
      if (e.target.closest("#ppBack")) { e.preventDefault(); AP.router.goList(); return; }
      if (e.target.closest("#ppEdit")) { editOpen(); return; }
      var tab = e.target.closest("[data-pptab]");
      if (tab) { curTab = tab.getAttribute("data-pptab"); render(); return; }
      // 卡片点击 → 详情(标题真链接拦默认统一走 goDetail 保留返回;官网外链/封面链接放行,注册墙照常拦)
      if (e.target.closest('[data-gate="official"]') || e.target.closest(".card__media-link")) return;
      var card = e.target.closest(".card");
      if (card) {
        if (e.target.closest(".card__title-link")) e.preventDefault();
        AP.router.goDetail(card.getAttribute("data-id"));
      }
    });
  }

  function open(uid) {
    build();
    root.hidden = false;
    document.body.style.overflow = "hidden";
    // 同一主页有缓存(如从详情返回)→ 先即时渲染;但无论如何都后台重取一次,
    // 保证隐私开关/资料变更不会因缓存而显示旧数据(stale-while-revalidate)。
    if (current && curUid === uid) { render(); }
    else { curUid = uid; current = null; curTab = "favs"; root.innerHTML = '<div class="ppage__inner">' + backBtn() + '<p class="ppage__empty">…</p></div>'; }
    curUid = uid;
    fetch("/api/users/" + encodeURIComponent(uid), { credentials: "same-origin" })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); })
      .then(function (r) {
        if (curUid !== uid) return;                        // 期间已切去别的主页
        if (!r.ok || !r.data || !r.data.user) { if (!current) renderMissing(); return; }
        current = r.data;
        render();
      })
      .catch(function () { if (curUid === uid && !current) renderMissing(); });
  }
  function close() {
    if (root && !root.hidden) { root.hidden = true; document.body.style.overflow = ""; }
  }

  function backBtn() {
    return '<button class="btn btn--ghost ppage__back" id="ppBack" type="button">← ' + esc(AP.t("back")) + '</button>';
  }
  function renderMissing() {
    root.innerHTML = '<div class="ppage__inner">' + backBtn() + '<p class="ppage__empty">' + esc(AP.t("ppNotFound")) + '</p></div>';
  }

  function render() {
    var u = current.user;
    var me = AP.auth && AP.auth.current();
    var isMe = !!(me && me.id === u.id);
    var favIds = isMe ? AP.favorites.ids() : (u.favorites || []);   // 自己的以本地(最新)为准
    var subs = current.submissions || [];
    var metaBits = [];
    if (u.identity) metaBits.push(esc(AP.t("idn_" + u.identity)));
    if (u.location) metaBits.push(esc(u.location));
    if (u.joined) metaBits.push(esc(AP.t("ppJoined")) + " " + esc(u.joined));
    var favN = (u.fav_public || isMe) ? " " + favIds.length : "";
    root.innerHTML =
      '<div class="ppage__inner">' + backBtn() +
      '<div class="ppage__head">' +
        '<img class="ppage__ava" alt="" src="' + esc(u.avatar || "") + '" />' +
        '<div class="ppage__info">' +
          '<h1 class="ppage__name">' + esc(u.nickname) +
            (isMe ? ' <button class="btn btn--ghost ppage__editbtn" id="ppEdit" type="button">' + esc(AP.t("menuEditProfile")) + '</button>' : "") +
          '</h1>' +
          (metaBits.length ? '<p class="ppage__meta">' + metaBits.join(" · ") + '</p>' : "") +
          (u.fields ? '<p class="ppage__meta">' + esc(AP.t("ppFields")) + ':' + esc(u.fields) + '</p>' : "") +
          (u.bio ? '<p class="ppage__bio">' + esc(u.bio) + '</p>' : "") +
          (u.website ? '<p class="ppage__link"><a href="' + esc(u.website) + '" target="_blank" rel="noopener nofollow ugc">' + esc(u.website) + '</a></p>' : "") +
        '</div>' +
      '</div>' +
      '<div class="ppage__tabs">' +
        '<button type="button" data-pptab="favs" class="' + (curTab === "favs" ? "is-active" : "") + '">' + esc(AP.t("ppTabFavs")) + favN + '</button>' +
        '<button type="button" data-pptab="subs" class="' + (curTab === "subs" ? "is-active" : "") + '">' + esc(AP.t("ppTabSubs")) + " " + subs.length + '</button>' +
      '</div>' +
      '<div id="ppBody"></div>' +
      '</div>';
    renderBody(u, isMe, favIds, subs);
  }

  function renderBody(u, isMe, favIds, subs) {
    var body = document.getElementById("ppBody");
    var data = AP.channelData ? (AP.channelData("opportunities") || []) : [];
    function grid(ids, emptyKey) {
      var byId = {}, i;
      for (i = 0; i < data.length; i++) byId[data[i].id] = data[i];
      var g = document.createElement("div");
      g.className = "grid ppage__grid";
      var found = 0;
      for (i = 0; i < ids.length; i++) {
        var o = byId[ids[i]];
        if (o) { g.appendChild(AP.renderCard(o)); found++; }
      }
      if (!found) { body.innerHTML = '<p class="ppage__empty">' + esc(AP.t(emptyKey)) + '</p>'; return; }
      body.innerHTML = "";
      body.appendChild(g);
    }
    if (curTab === "favs") {
      if (!isMe && !u.fav_public) { body.innerHTML = '<p class="ppage__empty">' + esc(AP.t("ppFavPrivate")) + '</p>'; return; }
      grid(favIds, "ppFavEmpty");
    } else {
      var oids = [];
      for (var i = 0; i < subs.length; i++) oids.push(subs[i].oid);
      grid(oids, "ppSubEmpty");
    }
  }

  // ---------- 编辑资料弹窗(顶栏菜单与主页"编辑资料"共用) ----------
  var newAvatar = null;
  function editOpen() {
    var me = AP.auth && AP.auth.current();
    if (!me) { AP.auth.openLogin(); return; }
    // 先拉最新资料再预填:防止本页加载后资料在别处(其他标签页/设备)改过,旧值覆盖新值
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.user) AP.auth.apply(j.user); buildEdit(AP.auth.current()); })
      .catch(function () { buildEdit(me); });
  }
  function buildEdit(me) {
    newAvatar = null;
    var el = document.getElementById("peModal");
    if (!el) {
      el = document.createElement("div");
      el.className = "auth"; el.id = "peModal"; el.hidden = true;
      document.body.appendChild(el);
    }
    var idOpts = "";
    var kinds = ["artist", "curator", "student", "org", "fan"];
    for (var i = 0; i < kinds.length; i++) {
      idOpts += '<option value="' + kinds[i] + '"' + (me.identity === kinds[i] ? " selected" : "") + '>' + esc(AP.t("idn_" + kinds[i])) + '</option>';
    }
    el.innerHTML =
      '<div class="auth__scrim" id="peScrim"></div>' +
      '<div class="auth__panel" role="dialog" aria-modal="true">' +
        '<button class="auth__close" id="peClose" type="button" aria-label="关闭">✕</button>' +
        '<h2 class="auth__title">' + esc(AP.t("peTitle")) + '</h2>' +
        '<form class="auth__form" id="peForm" novalidate>' +
          '<input type="text" id="peNick" maxlength="20" value="' + esc(me.nickname || "") + '" placeholder="' + esc(AP.t("pfPhNick")) + '" />' +
          '<p class="pe-hint">' + esc(AP.t("peNickHint")) + '</p>' +
          '<div class="pf-ava">' +
            '<img id="pePrev" class="has" alt="" src="' + esc(me.avatar || "") + '" />' +
            '<div class="pf-ava__btns">' +
              '<label class="btn btn--ghost pf-file">' + esc(AP.t("pfUpload")) + '<input type="file" id="peFile" accept="image/*" hidden /></label>' +
              '<button type="button" class="btn btn--ghost" id="peGen">' + esc(AP.t("pfDefault")) + '</button>' +
            '</div>' +
          '</div>' +
          '<textarea id="peBio" maxlength="300" placeholder="' + esc(AP.t("peBioPh")) + '">' + esc(me.bio || "") + '</textarea>' +
          '<select id="peIdentity"><option value="">' + esc(AP.t("peIdentityNone")) + '</option>' + idOpts + '</select>' +
          '<input type="text" id="peFields" maxlength="60" value="' + esc(me.fields || "") + '" placeholder="' + esc(AP.t("peFieldsPh")) + '" />' +
          '<input type="text" id="peLocation" maxlength="40" value="' + esc(me.location || "") + '" placeholder="' + esc(AP.t("peLocationPh")) + '" />' +
          '<input type="url" id="peWebsite" maxlength="200" value="' + esc(me.website || "") + '" placeholder="' + esc(AP.t("peWebsitePh")) + '" />' +
          '<label class="sf-label pe-check"><input type="checkbox" id="peFavPub"' + (me.fav_public !== false ? " checked" : "") + ' /> ' + esc(AP.t("peFavPub")) + '</label>' +
          '<div class="auth__err" id="peErr"></div>' +
          '<button type="submit" class="btn btn--dark auth__submit" id="peGo">' + esc(AP.t("pfSave")) + '</button>' +
        '</form>' +
      '</div>';
    el.hidden = false;
    document.getElementById("peClose").addEventListener("click", function () { el.hidden = true; });
    document.getElementById("peScrim").addEventListener("click", function () { el.hidden = true; });
    document.getElementById("peGen").addEventListener("click", function () {
      newAvatar = AP.auth.makeAvatar(document.getElementById("peNick").value);
      document.getElementById("pePrev").src = newAvatar;
    });
    document.getElementById("peFile").addEventListener("change", function () {
      var f = this.files[0], err = document.getElementById("peErr");
      if (!f) return;
      if (!/^image\//.test(f.type)) { err.textContent = AP.t("pfErrImg"); return; }
      var url = URL.createObjectURL(f), img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        newAvatar = AP.auth.squareFromImg(img);
        document.getElementById("pePrev").src = newAvatar;
        err.textContent = "";
      };
      img.onerror = function () { URL.revokeObjectURL(url); err.textContent = AP.t("pfErrImg"); };
      img.src = url;
    });
    document.getElementById("peForm").addEventListener("submit", saveEdit);
  }

  function saveEdit(e) {
    e.preventDefault();
    var err = document.getElementById("peErr");
    var nick = document.getElementById("peNick").value.trim();
    if (nick.length < 2) { err.textContent = AP.t("pfErrNick"); return; }
    var website = document.getElementById("peWebsite").value.trim();
    if (website && !/^https?:\/\//i.test(website)) { err.textContent = AP.t("peErrWebsite"); return; }
    var btn = document.getElementById("peGo");
    btn.disabled = true;
    fetch("/api/auth/profile", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nickname: nick, avatar: newAvatar || "",
        bio: document.getElementById("peBio").value.trim(),
        identity: document.getElementById("peIdentity").value,
        fields: document.getElementById("peFields").value.trim(),
        location: document.getElementById("peLocation").value.trim(),
        website: website,
        fav_public: document.getElementById("peFavPub").checked
      })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          err.textContent = (r.data && r.data.error) || AP.t("authNetErr");
          if (r.data && r.data.suggest) document.getElementById("peNick").value = r.data.suggest;
          return;
        }
        AP.auth.apply(r.data.user);
        document.getElementById("peModal").hidden = true;
        toast(AP.t("peDone"));
        // 自己的主页开着 → 重取并重渲(昵称/简介立即生效)
        if (root && !root.hidden && curUid === r.data.user.id) { current = null; open(curUid); }
      })
      .catch(function () { btn.disabled = false; err.textContent = AP.t("authNetErr"); });
  }

  AP.profilePage = {
    open: open, close: close, editOpen: editOpen,
    refresh: function () { if (root && !root.hidden && current) render(); }   // 语言切换时重渲
  };
})();
