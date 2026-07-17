/* 站内通知(8.4 一期):顶栏 🔔 + 未读角标 + 通知面板。
   覆盖:被关注 / 评论被回复 / 评论被点赞 / 作品被评论 / 内容审核结果。
   打开面板即全部标记已读;点通知跳到对应处(关注→TA主页;评论类→目标内容;审核→我的主页)。
   轮询:登录后每 60 秒拉一次未读数(轻量接口只回数字)。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function rel(iso) {
    var t = Date.parse(iso);
    if (!t) return "";
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return AP.t("cmtJustNow");
    if (s < 3600) return Math.round(s / 60) + " " + AP.t("cmtMinAgo");
    if (s < 86400) return Math.round(s / 3600) + " " + AP.t("cmtHourAgo");
    return iso.slice(5, 10);
  }

  var btn = null, badge = null, timer = null;

  function ensureBtn() {
    if (btn) return;
    var actions = document.querySelector(".topbar__actions");
    if (!actions) return;
    btn = document.createElement("button");
    btn.type = "button"; btn.id = "notifBtn"; btn.className = "icon-btn notif-btn";
    btn.setAttribute("aria-label", AP.t("ntTitle"));
    btn.hidden = true;
    btn.innerHTML =
      '<svg viewBox="0 0 20 20" aria-hidden="true" width="19" height="19"><path d="M10 2.5a5 5 0 0 0-5 5v2.8l-1.4 2.9a.7.7 0 0 0 .63 1h11.54a.7.7 0 0 0 .63-1L15 10.3V7.5a5 5 0 0 0-5-5Zm-1.8 12.7a1.9 1.9 0 0 0 3.6 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<span class="notif-badge" id="notifBadge" hidden></span>';
    // 插在主题按钮前(顶栏顺序:提交 🔔 🌙 中/EN 头像)
    var themeBtn = document.getElementById("themeBtn");
    actions.insertBefore(btn, themeBtn);
    badge = btn.querySelector("#notifBadge");
    btn.addEventListener("click", openPanel);
  }

  function setUnread(n) {
    if (!badge) return;
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
  }
  function poll() {
    if (!(AP.auth && AP.auth.current())) return;
    fetch("/api/notifications?count=1", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && typeof j.unread === "number") setUnread(j.unread); })
      .catch(function () {});
  }

  // 登录态变化时由 auth.js 调用:显示/隐藏铃铛并启停轮询
  function sync() {
    ensureBtn();
    if (!btn) return;
    var on = !!(AP.auth && AP.auth.current());
    btn.hidden = !on;
    clearInterval(timer);
    if (on) { poll(); timer = setInterval(poll, 60000); }
    else setUnread(0);
  }

  // 通知文案:类型 + 发起人 + 摘要
  function lineOf(n) {
    var who = n.actor ? '<b>' + esc(n.actor.nickname) + '</b> ' : "";
    var pv = n.ref && n.ref.preview ? ':' + esc(n.ref.preview) : "";
    if (n.type === "follow") return who + esc(AP.t("ntFollow"));
    if (n.type === "reply") return who + esc(AP.t("ntReply")) + pv;
    if (n.type === "like") return who + esc(AP.t("ntLike")) + pv;
    if (n.type === "comment") return who + esc(AP.t("ntComment")) + (n.ref && n.ref.title ? '《' + esc(n.ref.title) + '》' : "") + pv;
    if (n.type === "decide") {
      var what = { work: AP.t("ntWhatWork"), submission: AP.t("ntWhatSub"), comment: AP.t("ntWhatCmt") }[n.ref && n.ref.what] || "";
      var res = (n.ref && n.ref.result) === "approved" ? AP.t("ntResOk") : AP.t("ntResNo");
      return esc(AP.t("ntDecide")) + " " + esc(what) + (n.ref && n.ref.title ? '《' + esc(n.ref.title) + '》' : "") + (n.ref && n.ref.preview ? '「' + esc(n.ref.preview) + '」' : "") + ':' + esc(res);
    }
    return esc(n.type);
  }

  function openPanel() {
    var el = document.getElementById("notifPanel");
    if (!el) { el = document.createElement("div"); el.className = "cmtsheet"; el.id = "notifPanel"; document.body.appendChild(el); }
    el.innerHTML =
      '<div class="cmtsheet__scrim" id="npScrim"></div>' +
      '<div class="cmtsheet__panel">' +
        '<div class="cmtsheet__bar"><span class="cmtsheet__t">' + esc(AP.t("ntTitle")) + '</span>' +
          '<button type="button" class="auth__close cmtsheet__close" id="npClose" aria-label="关闭">✕</button></div>' +
        '<div class="cmtsheet__body notifs" id="npBody"><p class="ppage__empty">…</p></div>' +
      '</div>';
    el.hidden = false;
    document.getElementById("npScrim").addEventListener("click", close);
    document.getElementById("npClose").addEventListener("click", close);
    function close() { el.hidden = true; }
    fetch("/api/notifications", { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var list = (j && j.list) || [];
        var body = document.getElementById("npBody");
        if (!list.length) { body.innerHTML = '<p class="ppage__empty">' + esc(AP.t("ntEmpty")) + '</p>'; setUnread(0); return; }
        body.innerHTML = list.map(function (n) {
          return '<button type="button" class="notif' + (n.read ? "" : " is-unread") + '" data-ni="' + n.id + '">' +
            (n.actor ? '<img class="notif__ava" alt="" src="' + esc(n.actor.avatar || "") + '" />' : '<span class="notif__ico">✦</span>') +
            '<span class="notif__main"><span class="notif__line">' + lineOf(n) + '</span>' +
            '<span class="notif__time">' + esc(rel(n.created_at)) + '</span></span>' +
          '</button>';
        }).join("");
        // 打开即已读(小红书式):角标清零,后端标记
        fetch("/api/notifications/read", { method: "POST", credentials: "same-origin" }).catch(function () {});
        setUnread(0);
        body.addEventListener("click", function (e) {
          var item = e.target.closest("[data-ni]");
          if (!item) return;
          var n = list.filter(function (x) { return x.id === Number(item.getAttribute("data-ni")); })[0];
          if (!n) return;
          close();
          go(n);
        });
      })
      .catch(function () {});
  }

  // 点通知跳转:关注→TA主页;评论/点赞/回复→目标内容;审核→我的主页(看状态)
  function go(n) {
    if (n.type === "follow" && n.actor) { AP.router.goUser(n.actor.id); return; }
    if (n.type === "decide") {
      var me = AP.auth && AP.auth.current();
      if (me) AP.router.goUser(me.id);
      return;
    }
    var ref = n.ref || {};
    if (ref.kind === "opportunity") { AP.router.goDetail(ref.target); return; }
    if (ref.kind === "work") {
      var me2 = AP.auth && AP.auth.current();
      if (n.type === "comment" && me2) { AP.router.goUser(me2.id); return; }   // 自己的作品被评论 → 我的主页作品tab
      if (AP.comments) AP.comments.sheet("work", ref.target, AP.t("cmtTitle"));
      return;
    }
    if ((ref.kind === "news" || ref.kind === "job") && AP.comments) {
      AP.comments.sheet(ref.kind, ref.target, AP.t("cmtTitle"));
    }
  }

  AP.notify = { sync: sync };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync);
  else sync();
})();
