/* 用户投稿(路线图第3项):登录用户按卡片模板填写机会 → 后端敏感词+AI 机审 → 待审队列,
   管理员在 /admin 通过后才发布,卡片打"用户投稿·未经核实"标(诚实红线)。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var esc = AP.format.esc;

  var CATS = ["opencall", "residency", "award", "workshop"];
  function build() {
    var el = document.getElementById("submitModal");
    if (el) return el;
    el = document.createElement("div");
    el.className = "auth"; el.id = "submitModal"; el.hidden = true;
    var catOpts = "";
    for (var i = 0; i < CATS.length; i++) catOpts += '<option value="' + CATS[i] + '">' + esc(AP.tt[AP.lang].cat[CATS[i]]) + '</option>';
    el.innerHTML =
      '<div class="auth__scrim" id="sfScrim"></div>' +
      '<div class="auth__panel" role="dialog" aria-modal="true" aria-labelledby="sfTitleEl">' +
        '<button class="auth__close" id="sfClose" type="button" aria-label="关闭">✕</button>' +
        '<h2 class="auth__title" id="sfTitleEl">' + esc(AP.t("sfTitle")) + '</h2>' +
        '<p class="auth__note">' + esc(AP.t("sfNote")) + '</p>' +
        '<form class="auth__form" id="sfForm" novalidate>' +
          '<input type="text" id="sfT" maxlength="120" placeholder="' + esc(AP.t("sfPhTitle")) + '" />' +
          '<select id="sfC">' + catOpts + '</select>' +
          '<input type="text" id="sfO" maxlength="80" placeholder="' + esc(AP.t("sfPhOrg")) + '" />' +
          '<input type="text" id="sfSrc" maxlength="150" placeholder="' + esc(AP.t("sfPhSrc")) + '" />' +
          '<div class="sf-row">' +
            '<input type="text" id="sfCity" maxlength="40" placeholder="' + esc(AP.t("sfPhCity")) + '" />' +
            '<input type="text" id="sfCountry" maxlength="40" placeholder="' + esc(AP.t("sfPhCountry")) + '" />' +
          '</div>' +
          '<label class="sf-label">' + esc(AP.t("sfPhDeadline")) + '<input type="date" id="sfD" /></label>' +
          '<input type="url" id="sfU" maxlength="300" placeholder="' + esc(AP.t("sfPhUrl")) + '" />' +
          '<textarea id="sfS" maxlength="500" placeholder="' + esc(AP.t("sfPhSummary")) + '"></textarea>' +
          '<label class="sf-label sf-cover">' + esc(AP.t("sfPhCover")) +
            '<input type="file" id="sfCov" accept="image/*" />' +
            '<img id="sfCovPrev" alt="" hidden />' +
          '</label>' +
          '<div class="auth__err" id="sfErr"></div>' +
          '<button type="submit" class="btn btn--dark auth__submit" id="sfGo">' + esc(AP.t("sfSubmit")) + '</button>' +
        '</form>' +
        '<p class="auth__privacy">' + esc(AP.t("sfPrivacy")) + '</p>' +
      '</div>';
    document.body.appendChild(el);
    document.getElementById("sfClose").addEventListener("click", close);
    document.getElementById("sfScrim").addEventListener("click", close);
    document.getElementById("sfForm").addEventListener("submit", onSubmit);
    document.getElementById("sfCov").addEventListener("change", onCoverPick);
    document.addEventListener("keydown", function (e) {
      var m = document.getElementById("submitModal");
      var am = document.getElementById("authModal");
      if (am && !am.hidden) return;                      // 登录墙在上层时让行
      if (e.key === "Escape" && m && !m.hidden) { e.stopImmediatePropagation(); close(); }
    }, true);
    return el;
  }
  function close() { var el = document.getElementById("submitModal"); if (el) el.hidden = true; }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._apTimer);
    t._apTimer = setTimeout(function () { t.hidden = true; }, 3200);
  }

  // 封面选择:客户端压缩(最长边 1280、JPEG)后作为 data URL 随表单提交;审核通过才落地成文件
  var coverData = null;
  function onCoverPick() {
    var input = document.getElementById("sfCov");
    var err = document.getElementById("sfErr");
    var prev = document.getElementById("sfCovPrev");
    coverData = null; prev.hidden = true; err.textContent = "";
    var file = input.files && input.files[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) { err.textContent = AP.t("sfErrCover"); input.value = ""; return; }
    var obj = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(obj);
      var max = 1280, scale = Math.min(1, max / Math.max(img.width, img.height));
      var c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      var d = c.toDataURL("image/jpeg", 0.78);
      if (d.length > 700000) d = c.toDataURL("image/jpeg", 0.55);
      if (d.length > 800000) { err.textContent = AP.t("sfErrCover"); input.value = ""; return; }
      coverData = d;
      prev.src = d; prev.hidden = false;
    };
    img.onerror = function () { URL.revokeObjectURL(obj); err.textContent = AP.t("sfErrCover"); input.value = ""; };
    img.src = obj;
  }

  function onSubmit(e) {
    e.preventDefault();
    var err = document.getElementById("sfErr");
    var $ = function (id) { return document.getElementById(id).value.trim(); };
    var data = { title: $("sfT"), category: $("sfC"), org: $("sfO"), source_note: $("sfSrc"), city: $("sfCity"), country: $("sfCountry"), deadline: $("sfD"), url: $("sfU"), summary: $("sfS"), cover: coverData };
    if (data.title.length < 2) { err.textContent = AP.t("sfErrTitle"); return; }
    if (data.org.length < 2) { err.textContent = AP.t("sfErrOrg"); return; }
    if (data.source_note.length < 2) { err.textContent = AP.t("sfErrSrc"); return; }
    if (data.url && !/^https?:\/\//i.test(data.url)) { err.textContent = AP.t("sfErrUrl"); return; }
    var btn = document.getElementById("sfGo");
    btn.disabled = true; err.textContent = "";
    fetch("/api/submit", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, data: j }; }); })
      .then(function (r) {
        btn.disabled = false;
        if (r.status === 401) { close(); if (AP.auth) AP.auth.openLogin(AP.t("sfNeedLogin")); return; }
        if (r.status !== 200) { err.textContent = (r.data && r.data.error) || AP.t("authNetErr"); return; }
        close();
        toast(r.data.status === "rejected" ? AP.t("sfRejected") : AP.t("sfOk"));
        document.getElementById("sfForm").reset();
        coverData = null;
      })
      .catch(function () { btn.disabled = false; err.textContent = AP.t("authNetErr"); });
  }

  AP.submitForm = {
    open: function () {
      // 未登录先走登录(投稿必须实名到账号,合规留痕)
      if (AP.auth && !AP.auth.isIn()) { AP.auth.openLogin(AP.t("sfNeedLogin")); return; }
      var el = document.getElementById("submitModal");
      if (el) el.remove();                               // 重建以刷新语言
      build().hidden = false;
      setTimeout(function () { document.getElementById("sfT").focus(); }, 50);
    }
  };
})();
