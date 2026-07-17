/* 作品集(路线图 8.3):上传(多图,前端压缩)→ 人工审核 → 主页瀑布流展示 + 大图查看器。
   合规:待审图片在服务器非公开目录,过审才可见;上传即声明拥有版权;作品可举报。
   学习对象:Behance/ArtStation 作品页、小红书瀑布流。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toast(msg) {
    var t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(t._apTimer);
    t._apTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }
  function post(url, data) {
    return fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data || {}) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, data: j }; }); });
  }

  // ---------- 图片压缩:整图等比缩到长边 ≤1600、JPEG q0.8(不裁剪,和头像的方裁不同) ----------
  function fileToJpeg(file, cb, onErr) {
    if (!/^image\//.test(file.type)) { onErr(); return; }
    var draw = function (img, w, h) {
      var k = Math.min(1, 1600 / Math.max(w, h));
      var c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      var out = c.toDataURL("image/jpeg", 0.8);
      if (out.length > 1000000) out = c.toDataURL("image/jpeg", 0.6);   // 兜底再压一档
      cb(out);
    };
    if (window.createImageBitmap) {   // 优先走 createImageBitmap:自动按 EXIF 转正手机照片
      createImageBitmap(file, { imageOrientation: "from-image" })
        .then(function (bm) { draw(bm, bm.width, bm.height); })
        .catch(function () { plain(); });
    } else plain();
    function plain() {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); draw(img, img.width, img.height); };
      img.onerror = function () { URL.revokeObjectURL(url); onErr(); };
      img.src = url;
    }
  }

  // ---------- 上传弹窗 ----------
  var upImgs = [];   // dataURL 列表
  function uploadOpen(onDone) {
    var me = AP.auth && AP.auth.current();
    if (!me) { AP.auth.openLogin(); return; }
    upImgs = [];
    var el = document.getElementById("wkUpModal");
    if (!el) { el = document.createElement("div"); el.className = "auth"; el.id = "wkUpModal"; document.body.appendChild(el); }
    el.innerHTML =
      '<div class="auth__scrim" id="wkScrim"></div>' +
      '<div class="auth__panel" role="dialog" aria-modal="true">' +
        '<button class="auth__close" id="wkClose" type="button" aria-label="关闭">✕</button>' +
        '<h2 class="auth__title">' + esc(AP.t("wkUpTitle")) + '</h2>' +
        '<p class="auth__note">' + esc(AP.t("wkUpNote")) + '</p>' +
        '<form class="auth__form" id="wkForm" novalidate>' +
          '<input type="text" id="wkTitle" maxlength="60" placeholder="' + esc(AP.t("wkTitlePh")) + '" />' +
          '<textarea id="wkDesc" maxlength="500" placeholder="' + esc(AP.t("wkDescPh")) + '"></textarea>' +
          '<label class="btn btn--ghost pf-file wk-pick">' + esc(AP.t("wkPick")) + '<input type="file" id="wkFiles" accept="image/*" multiple hidden /></label>' +
          '<div class="wk-thumbs" id="wkThumbs"></div>' +
          '<div class="auth__err" id="wkErr"></div>' +
          '<button type="submit" class="btn btn--dark auth__submit" id="wkGo">' + esc(AP.t("wkSubmit")) + '</button>' +
          '<p class="auth__privacy">' + esc(AP.t("wkCopyright")) + '</p>' +
        '</form>' +
      '</div>';
    el.hidden = false;
    var close = function () { el.hidden = true; };
    document.getElementById("wkClose").addEventListener("click", close);
    document.getElementById("wkScrim").addEventListener("click", close);
    document.getElementById("wkFiles").addEventListener("change", function () {
      var files = Array.prototype.slice.call(this.files || []);
      this.value = "";
      var err = document.getElementById("wkErr");
      files.forEach(function (f) {
        if (upImgs.length >= 9) return;
        fileToJpeg(f, function (dataURL) {
          if (dataURL.length > 1000000) { err.textContent = AP.t("wkErrBig"); return; }
          upImgs.push(dataURL);
          renderThumbs();
        }, function () { err.textContent = AP.t("pfErrImg"); });
      });
    });
    document.getElementById("wkThumbs").addEventListener("click", function (e) {
      var b = e.target.closest("[data-rm]");
      if (!b) return;
      upImgs.splice(Number(b.getAttribute("data-rm")), 1);
      renderThumbs();
    });
    document.getElementById("wkForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var err = document.getElementById("wkErr");
      var title = document.getElementById("wkTitle").value.trim();
      if (title.length < 2) { err.textContent = AP.t("wkErrTitle"); return; }
      if (!upImgs.length) { err.textContent = AP.t("wkErrImgs"); return; }
      var btn = document.getElementById("wkGo");
      btn.disabled = true; btn.textContent = AP.t("wkUploading");
      post("/api/works", { title: title, description: document.getElementById("wkDesc").value.trim(), images: upImgs })
        .then(function (r) {
          btn.disabled = false; btn.textContent = AP.t("wkSubmit");
          if (!r.ok) { err.textContent = (r.data && r.data.error) || AP.t("authNetErr"); return; }
          close();
          toast(AP.t("wkDone"));
          if (onDone) onDone();
        })
        .catch(function () { btn.disabled = false; btn.textContent = AP.t("wkSubmit"); err.textContent = AP.t("authNetErr"); });
    });
    function renderThumbs() {
      var box = document.getElementById("wkThumbs");
      box.innerHTML = upImgs.map(function (d, i) {
        return '<div class="wk-thumb"><img src="' + d + '" alt="" /><button type="button" data-rm="' + i + '" aria-label="移除">✕</button></div>';
      }).join("");
      document.getElementById("wkErr").textContent = upImgs.length >= 9 ? AP.t("wkErrMax") : "";
    }
  }

  // ---------- 主页"作品"tab 渲染:瀑布流(CSS columns) ----------
  function renderTab(body, u, isMe, onChanged) {
    body.innerHTML = '<p class="ppage__empty">…</p>';
    fetch("/api/works?uid=" + encodeURIComponent(u.id), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var works = (j && j.works) || [];
        var html = "";
        if (isMe) html += '<button class="btn btn--dark wk-add" id="wkAdd" type="button">＋ ' + esc(AP.t("wkUpTitle")) + '</button>';
        if (!works.length) {
          html += '<p class="ppage__empty">' + esc(AP.t(isMe ? "wkEmptyMe" : "wkEmpty")) + '</p>';
          body.innerHTML = html;
          wire();
          return;
        }
        html += '<div class="wk-flow">' + works.map(function (w, idx) {
          var cover = w.images[0];
          return '<div class="wk-card" data-widx="' + idx + '">' +
            (cover
              ? '<img class="wk-card__img" loading="lazy" src="' + esc(cover) + '" alt="" />'
              : '<div class="wk-card__hold">' + esc(AP.t(w.status === "rejected" ? "wkRejected" : "wkPending")) + ' · ' + w.n + ' ' + esc(AP.t("wkImgs")) + '</div>') +
            '<div class="wk-card__t">' + esc(w.title) +
              (w.n > 1 ? ' <span class="wk-card__n">' + w.n + '</span>' : "") +
              (isMe && w.status !== "approved" ? ' <span class="wk-card__st">' + esc(AP.t(w.status === "rejected" ? "wkRejected" : "wkPending")) + '</span>' : "") +
            '</div></div>';
        }).join("") + '</div>';
        body.innerHTML = html;
        wire();
        body.querySelector(".wk-flow").addEventListener("click", function (e) {
          var card = e.target.closest("[data-widx]");
          if (!card) return;
          openViewer(works[Number(card.getAttribute("data-widx"))], isMe, onChanged);
        });
        function noop() {}
      })
      .catch(function () { body.innerHTML = '<p class="ppage__empty">' + esc(AP.t("authNetErr")) + '</p>'; });
    function wire() {
      var add = document.getElementById("wkAdd");
      if (add) add.addEventListener("click", function () { uploadOpen(onChanged); });
    }
  }

  // ---------- 大图查看器:左右翻页 + 删除(本人)/举报(他人) ----------
  function openViewer(w, isMe, onChanged) {
    if (!w.images.length) { if (isMe) toast(AP.t("wkPendingTip")); return; }
    var i = 0;
    var el = document.getElementById("wkViewer");
    if (!el) { el = document.createElement("div"); el.className = "wkview"; el.id = "wkViewer"; document.body.appendChild(el); }
    function render() {
      el.innerHTML =
        '<div class="wkview__scrim" id="wvScrim"></div>' +
        '<div class="wkview__box">' +
          '<button class="wkview__close" id="wvClose" type="button" aria-label="关闭">✕</button>' +
          '<img class="wkview__img" src="' + esc(w.images[i]) + '" alt="" />' +
          (w.images.length > 1 ?
            '<button class="wkview__nav wkview__prev" id="wvPrev" type="button" aria-label="上一张">‹</button>' +
            '<button class="wkview__nav wkview__next" id="wvNext" type="button" aria-label="下一张">›</button>' +
            '<span class="wkview__ct">' + (i + 1) + " / " + w.images.length + '</span>' : "") +
          '<div class="wkview__meta">' +
            '<div class="wkview__title">' + esc(w.title) + '</div>' +
            (w.description ? '<div class="wkview__desc">' + esc(w.description) + '</div>' : "") +
            '<div class="wkview__ops">' +
              (isMe
                ? '<button class="wkview__op wkview__op--del" id="wvDel" type="button">' + esc(AP.t("wkDelete")) + '</button>'
                : '<button class="wkview__op" id="wvReport" type="button">' + esc(AP.t("reportErr")) + '</button>') +
            '</div>' +
          '</div>' +
        '</div>';
      document.getElementById("wvScrim").addEventListener("click", close);
      document.getElementById("wvClose").addEventListener("click", close);
      var pv = document.getElementById("wvPrev"), nx = document.getElementById("wvNext");
      if (pv) pv.addEventListener("click", function () { i = (i - 1 + w.images.length) % w.images.length; render(); });
      if (nx) nx.addEventListener("click", function () { i = (i + 1) % w.images.length; render(); });
      var del = document.getElementById("wvDel");
      if (del) del.addEventListener("click", function () {
        if (!confirm(AP.t("wkDelAsk"))) return;
        post("/api/works/delete", { id: w.id }).then(function (r) {
          if (!r.ok) { toast((r.data && r.data.error) || AP.t("authNetErr")); return; }
          close();
          toast(AP.t("wkDeleted"));
          if (onChanged) onChanged();
        });
      });
      var rp = document.getElementById("wvReport");
      if (rp) rp.addEventListener("click", function () {
        post("/api/works/report", { id: w.id }).then(function (r) {
          toast(r.ok ? AP.t("wkReported") : ((r.data && r.data.error) || AP.t("authNetErr")));
        });
      });
    }
    function close() { el.hidden = true; document.removeEventListener("keydown", onKey, true); }
    function onKey(e) {
      if (el.hidden) return;
      if (e.key === "Escape") { e.stopImmediatePropagation(); close(); }
      else if (e.key === "ArrowLeft" && w.images.length > 1) { i = (i - 1 + w.images.length) % w.images.length; render(); }
      else if (e.key === "ArrowRight" && w.images.length > 1) { i = (i + 1) % w.images.length; render(); }
    }
    el.hidden = false;
    render();
    document.addEventListener("keydown", onKey, true);
  }

  AP.works = { renderTab: renderTab, uploadOpen: uploadOpen };
})();
