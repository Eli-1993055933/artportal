/* 评论(路线图第 2 项):四类内容通用(opportunity/news/job/work)。
   形态:mount(内嵌:机会详情页底部、作品查看器底部)+ sheet(弹层:资讯/招聘卡片 💬)。
   结构学小红书:扁平 + 一层回复;元素:头像/昵称(点进主页)/内容/时间/点赞/回复/举报/删除(本人)。
   审核:AI 干净即显示;可疑压下,作者本人可见并标"审核中"。未登录可看,发评论需登录。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._apTimer);
    t._apTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }
  function post(url, data) {
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, data: j }; }); });
  }
  function rel(iso) {
    var t = Date.parse(iso);
    if (!t) return "";
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return AP.t("cmtJustNow");
    if (s < 3600) return Math.round(s / 60) + " " + AP.t("cmtMinAgo");
    if (s < 86400) return Math.round(s / 3600) + " " + AP.t("cmtHourAgo");
    if (s < 30 * 86400) return Math.round(s / 86400) + " " + AP.t("cmtDayAgo");
    return iso.slice(0, 10);
  }

  // ---------- 挂载一个评论区到容器 ----------
  function mount(box, kind, target) {
    var list = [], replyTo = null;   // replyTo = {id, nick}
    box.className = (box.className ? box.className + " " : "") + "cmts";
    box.innerHTML = "";
    render();
    load();

    function load() {
      fetch("/api/comments?kind=" + encodeURIComponent(kind) + "&id=" + encodeURIComponent(target), { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (j) { list = (j && j.comments) || []; render(); })
        .catch(function () {});
    }

    function render() {
      var tops = list.filter(function (c) { return !c.parent; }).reverse();   // 主评论:新的在前
      var byParent = {};
      list.forEach(function (c) { if (c.parent) (byParent[c.parent] = byParent[c.parent] || []).push(c); });
      var h =
        '<div class="cmts__head">' + esc(AP.t("cmtTitle")) + ' <span class="cmts__n">' + list.length + '</span></div>' +
        '<div class="cmts__composer">' +
          (replyTo ? '<div class="cmts__replying">' + esc(AP.t("cmtReplyTo")) + ' @' + esc(replyTo.nick) + ' <button type="button" class="cmts__cancel" data-cmtact="cancel">' + esc(AP.t("cmtCancel")) + '</button></div>' : "") +
          '<textarea class="cmts__input" maxlength="500" placeholder="' + esc(AP.t("cmtPh")) + '"></textarea>' +
          '<button type="button" class="btn btn--dark cmts__send" data-cmtact="send">' + esc(AP.t("cmtSend")) + '</button>' +
        '</div>' +
        (tops.length ? tops.map(function (c) { return item(c, byParent[c.id] || [], false); }).join("")
                     : '<p class="cmts__empty">' + esc(AP.t("cmtEmpty")) + '</p>');
      box.innerHTML = h;
    }

    function item(c, replies, isReply) {
      var me = AP.auth && AP.auth.current();
      var mine = !!(me && c.uid === me.id);
      var a = c.author || {};
      return '<div class="cmt' + (isReply ? " cmt--reply" : "") + '" data-cid="' + c.id + '">' +
        '<img class="cmt__ava" alt="" src="' + esc(a.avatar || "") + '" data-cmtu="' + esc(a.id || "") + '" />' +
        '<div class="cmt__main">' +
          '<div class="cmt__top">' +
            '<button type="button" class="cmt__nick" data-cmtu="' + esc(a.id || "") + '">' + esc(a.nickname || "…") + '</button>' +
            (c.status === "pending" ? '<span class="cmt__pending">' + esc(AP.t("cmtPending")) + '</span>' : "") +
          '</div>' +
          '<div class="cmt__body">' + esc(c.content) + '</div>' +
          '<div class="cmt__ops">' +
            '<span class="cmt__time">' + esc(rel(c.created_at)) + '</span>' +
            (c.status === "approved" ? '<button type="button" class="cmt__op' + (c.liked ? " is-on" : "") + '" data-cmtact="like" data-id="' + c.id + '">♥ ' + (c.likes || "") + '</button>' : "") +
            (c.status === "approved" && !isReply ? '<button type="button" class="cmt__op" data-cmtact="reply" data-id="' + c.id + '" data-nick="' + esc(a.nickname || "") + '">' + esc(AP.t("cmtReply")) + '</button>' : "") +
            (mine ? '<button type="button" class="cmt__op" data-cmtact="del" data-id="' + c.id + '">' + esc(AP.t("cmtDelete")) + '</button>'
                  : '<button type="button" class="cmt__op" data-cmtact="report" data-id="' + c.id + '">' + esc(AP.t("reportErr")) + '</button>') +
          '</div>' +
          (replies.length ? '<div class="cmt__replies">' + replies.map(function (r) { return item(r, [], true); }).join("") + '</div>' : "") +
        '</div>' +
      '</div>';
    }

    box.addEventListener("click", function (e) {
      var uEl = e.target.closest("[data-cmtu]");
      if (uEl && uEl.getAttribute("data-cmtu")) {
        closeSheet();                                 // 弹层里点人 → 先收弹层再跳主页
        AP.router.goUser(uEl.getAttribute("data-cmtu"));
        return;
      }
      var op = e.target.closest("[data-cmtact]");
      if (!op) return;
      var act = op.getAttribute("data-cmtact"), id = Number(op.getAttribute("data-id"));
      if (act === "cancel") { replyTo = null; render(); return; }
      if (act === "reply") {
        if (!(AP.auth && AP.auth.current())) { AP.auth.openLogin(); return; }
        replyTo = { id: id, nick: op.getAttribute("data-nick") || "" };
        render();
        box.querySelector(".cmts__input").focus();
        return;
      }
      if (act === "send") { send(); return; }
      if (act === "like") {
        if (!(AP.auth && AP.auth.current())) { AP.auth.openLogin(); return; }
        post("/api/comments/like", { id: id }).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || AP.t("authNetErr")); return; }
          var c = list.filter(function (x) { return x.id === id; })[0];
          if (c) { c.liked = r.data.liked; c.likes = r.data.likes; render(); }
        });
        return;
      }
      if (act === "del") {
        if (!confirm(AP.t("cmtDelAsk"))) return;
        post("/api/comments/delete", { id: id }).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || AP.t("authNetErr")); return; }
          toast(AP.t("cmtDeleted"));
          load();
        });
        return;
      }
      if (act === "report") {
        post("/api/comments/report", { id: id }).then(function (r) {
          toast(r.ok ? AP.t("wkReported") : ((r.data && r.data.error) || AP.t("authNetErr")));
        });
      }
    });

    function send() {
      if (!(AP.auth && AP.auth.current())) { AP.auth.openLogin(); return; }
      var input = box.querySelector(".cmts__input");
      var content = input.value.trim();
      if (!content) { input.focus(); return; }
      var btn = box.querySelector(".cmts__send");
      btn.disabled = true;
      post("/api/comments", { kind: kind, target: target, content: content, parent: replyTo ? replyTo.id : null })
        .then(function (r) {
          btn.disabled = false;
          if (!r.ok) { toast((r.data && r.data.error) || AP.t("authNetErr")); return; }
          replyTo = null;
          toast(AP.t(r.data.status === "approved" ? "cmtSentLive" : "cmtSentPending"));
          load();
        })
        .catch(function () { btn.disabled = false; toast(AP.t("authNetErr")); });
    }
  }

  // ---------- 弹层形态(资讯/招聘卡片 💬):桌面居中面板,手机底部抽屉 ----------
  function sheet(kind, target, title) {
    var el = document.getElementById("cmtSheet");
    if (!el) { el = document.createElement("div"); el.className = "cmtsheet"; el.id = "cmtSheet"; document.body.appendChild(el); }
    el.innerHTML =
      '<div class="cmtsheet__scrim" id="csScrim"></div>' +
      '<div class="cmtsheet__panel">' +
        '<div class="cmtsheet__bar"><span class="cmtsheet__t">' + esc(title || AP.t("cmtTitle")) + '</span>' +
          '<button type="button" class="auth__close cmtsheet__close" id="csClose" aria-label="关闭">✕</button></div>' +
        '<div class="cmtsheet__body" id="csBody"></div>' +
      '</div>';
    el.hidden = false;
    document.getElementById("csScrim").addEventListener("click", closeSheet);
    document.getElementById("csClose").addEventListener("click", closeSheet);
    mount(document.getElementById("csBody"), kind, target);
  }
  function closeSheet() {
    var el = document.getElementById("cmtSheet");
    if (el) el.hidden = true;
  }

  AP.comments = { mount: mount, sheet: sheet, closeSheet: closeSheet };
})();
