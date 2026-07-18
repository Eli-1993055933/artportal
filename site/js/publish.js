/* 统一发布入口(v0.72.0,学小红书发布系统):
   顶栏「➕ 发布」/ 手机右下角 ➕ → 选择面板:机会 / 招聘 / 资讯 / 作品 四选一。
   - 机会 → 现有投稿表单(submit.js);作品 → 现有上传(works.js);
   - 招聘 / 资讯 → 本文件的轻表单 → POST /api/submit(kind=job/news),
     与机会投稿同一条链:敏感词+AI 机审 → 干净即发/可疑转人工,发布后标"用户投稿·未经核实"。 */
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

  // ---------- 选择面板(手机底部抽屉 / 桌面居中) ----------
  function openPicker() {
    if (AP.auth && !AP.auth.isIn()) { AP.auth.openLogin(AP.t("pubNeedLogin")); return; }
    var el = document.getElementById("pubModal");
    if (!el) {
      el = document.createElement("div"); el.className = "auth pubsheet"; el.id = "pubModal"; document.body.appendChild(el);
      document.addEventListener("keydown", function (e) {   // Esc 关闭(捕获,与站内其它弹层一致,不连带关详情)
        var m = document.getElementById("pubModal");
        if (e.key === "Escape" && m && !m.hidden) { e.stopImmediatePropagation(); m.hidden = true; }
      }, true);
    }
    var items = [
      { k: "opp",  ico: "🎯", t: AP.t("pubOpp"),  d: AP.t("pubOppD") },
      { k: "job",  ico: "💼", t: AP.t("pubJob"),  d: AP.t("pubJobD") },
      { k: "news", ico: "📰", t: AP.t("pubNews"), d: AP.t("pubNewsD") },
      { k: "work", ico: "🎨", t: AP.t("pubWork"), d: AP.t("pubWorkD") }
    ];
    el.innerHTML =
      '<div class="auth__scrim" id="pubScrim"></div>' +
      '<div class="auth__panel pub__panel" role="dialog" aria-modal="true" aria-label="' + esc(AP.t("pubTitle")) + '">' +
        '<button class="auth__close" id="pubClose" type="button" aria-label="关闭">✕</button>' +
        '<h2 class="auth__title">' + esc(AP.t("pubTitle")) + '</h2>' +
        '<p class="auth__note">' + esc(AP.t("pubNote")) + '</p>' +
        '<div class="pub__grid">' + items.map(function (it) {
          return '<button type="button" class="pub__item" data-pub="' + it.k + '">' +
            '<span class="pub__ico" aria-hidden="true">' + it.ico + '</span>' +
            '<span class="pub__t">' + esc(it.t) + '</span>' +
            '<span class="pub__d">' + esc(it.d) + '</span></button>';
        }).join("") + '</div>' +
      '</div>';
    el.hidden = false;
    var close = function () { el.hidden = true; };
    document.getElementById("pubClose").addEventListener("click", close);
    document.getElementById("pubScrim").addEventListener("click", close);
    el.querySelector(".pub__grid").addEventListener("click", function (e) {
      var b = e.target.closest("[data-pub]"); if (!b) return;
      var k = b.getAttribute("data-pub");
      close();
      if (k === "opp") { if (AP.submitForm) AP.submitForm.open(); }
      else if (k === "work") { if (AP.works) AP.works.uploadOpen(); }
      else openForm(k);
    });
  }

  // ---------- 招聘 / 资讯 轻表单 ----------
  function field(id, ph, type, extra) {
    return '<input type="' + (type || "text") + '" id="' + id + '" placeholder="' + esc(ph) + '" ' + (extra || "") + ' />';
  }
  // date 输入不显示 placeholder:必须配可见 label(复用 submit.js 的 .sf-label 样式)
  function dateField(id, label) {
    return '<label class="sf-label">' + esc(label) + '<input type="date" id="' + id + '" /></label>';
  }
  function openForm(kind) {
    var el = document.getElementById("pubFormModal");
    if (!el) {
      el = document.createElement("div"); el.className = "auth"; el.id = "pubFormModal"; document.body.appendChild(el);
      document.addEventListener("keydown", function (e) {
        var m = document.getElementById("pubFormModal");
        if (e.key === "Escape" && m && !m.hidden) { e.stopImmediatePropagation(); m.hidden = true; }
      }, true);
    }
    var isJob = kind === "job";
    var empOpts = ["全职", "兼职", "实习", "合约", "志愿者", "其他"].map(function (t) { return '<option value="' + t + '">' + esc(AP.lang === "en" ? ({ "全职": "Full-time", "兼职": "Part-time", "实习": "Internship", "合约": "Contract", "志愿者": "Volunteer", "其他": "Other" })[t] : t) + '</option>'; }).join("");
    el.innerHTML =
      '<div class="auth__scrim" id="pfScrim2"></div>' +
      '<div class="auth__panel" role="dialog" aria-modal="true">' +
        '<button class="auth__close" id="pfClose2" type="button" aria-label="关闭">✕</button>' +
        '<h2 class="auth__title">' + esc(AP.t(isJob ? "pubJobTitle" : "pubNewsTitle")) + '</h2>' +
        '<p class="auth__note">' + esc(AP.t(isJob ? "pubJobNote" : "pubNewsNote")) + '</p>' +
        '<form class="auth__form" id="pubForm" novalidate>' +
          field("pbTitle", AP.t(isJob ? "pbJobT" : "pbNewsT")) +
          (isJob
            ? field("pbOrg", AP.t("pbJobOrg")) +
              '<div class="pub__row">' + field("pbCity", AP.t("sfPhCity")) + field("pbCountry", AP.t("sfPhCountry")) + '</div>' +
              '<div class="pub__row"><select id="pbEmp"><option value="">' + esc(AP.t("pbEmp")) + '</option>' + empOpts + '</select>' + field("pbSalary", AP.t("pbSalary")) + '</div>' +
              dateField("pbDeadline", AP.t("pbDeadline")) +
              field("pbUrl", AP.t("pbJobUrl"), "url")
            : field("pbSource", AP.t("pbNewsSrc")) +
              dateField("pbDeadline", AP.t("pbNewsDate")) +
              field("pbUrl", AP.t("pbNewsUrl"), "url")
          ) +
          '<textarea id="pbSummary" maxlength="500" placeholder="' + esc(AP.t(isJob ? "pbJobSum" : "pbNewsSum")) + '"></textarea>' +
          '<div class="auth__err" id="pbErr"></div>' +
          '<button type="submit" class="btn btn--dark auth__submit" id="pbGo">' + esc(AP.t("sfSubmit")) + '</button>' +
          '<p class="auth__privacy">' + esc(AP.t("pubPrivacy")) + '</p>' +
        '</form>' +
      '</div>';
    el.hidden = false;
    var close = function () { el.hidden = true; };
    document.getElementById("pfClose2").addEventListener("click", close);
    document.getElementById("pfScrim2").addEventListener("click", close);
    document.getElementById("pubForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var err = document.getElementById("pbErr");
      var $v = function (id) { var n = document.getElementById(id); return n ? n.value.trim() : ""; };
      var body = { kind: kind, title: $v("pbTitle"), url: $v("pbUrl"), deadline: $v("pbDeadline"), summary: $v("pbSummary") };
      if (isJob) { body.org = $v("pbOrg"); body.city = $v("pbCity"); body.country = $v("pbCountry"); body.employment_type = $v("pbEmp"); body.salary = $v("pbSalary"); }
      else body.source = $v("pbSource");
      if (body.title.length < 2) { err.textContent = AP.t("pbErrTitle"); return; }
      if (isJob && body.org.length < 2) { err.textContent = AP.t("pbErrOrg"); return; }
      if (!isJob && (body.source || "").length < 2) { err.textContent = AP.t("pbErrSrc"); return; }
      if (!/^https?:\/\//i.test(body.url)) { err.textContent = AP.t("sfErrUrl"); return; }
      var btn = document.getElementById("pbGo");
      btn.disabled = true;
      post("/api/submit", body).then(function (r) {
        btn.disabled = false;
        if (!r.ok) { err.textContent = (r.data && r.data.error) || AP.t("authNetErr"); return; }
        close();
        toast(AP.t(r.data.status === "approved" ? "pubLive" : r.data.status === "duplicate" ? "pubDup" : "sfOk"));
      }).catch(function () { btn.disabled = false; err.textContent = AP.t("authNetErr"); });
    });
  }

  AP.publish = { open: openPicker };
})();
