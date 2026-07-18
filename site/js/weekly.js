/* AI 艺术周报(路线图第 5 项):
   - 资讯频道顶部横条:最新一期入口(有周报才显示);
   - #/w/<期号> 阅读页(深链可分享):导语/机会/资讯/招聘各节,条目为站内已核实数据;
   - 诚实标注:AI 撰写导语与编排,条目事实以原文为准。
   数据全部来自静态归档 data/weekly/index.json 与 data/weekly/<id>.json(服务器每周一生成)。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var index = null, indexLoaded = false, loadingIdx = false;
  var bar = null, page = null, curId = null;
  var reports = {};   // id -> report(本次会话缓存)

  // ---------- 资讯频道顶部横条 ----------
  function ensureBar() {
    if (bar) return bar;
    bar = document.getElementById("weeklyBar");
    return bar;
  }
  function renderBar() {
    var el = ensureBar();
    if (!el) return;
    var latest = index && index.list && index.list[0];
    if (!latest) { el.hidden = true; return; }
    el.innerHTML =
      '<a class="wr-bar__main" href="#/w/' + encodeURIComponent(latest.id) + '">' +
        '<span class="wr-bar__ico" aria-hidden="true">✦</span>' +
        '<span class="wr-bar__title">' + esc(latest.title) + '</span>' +
        '<span class="wr-bar__meta">' + esc(latest.date || latest.id) + ' · ' + esc(AP.t("wrRead")) + ' →</span>' +
      '</a>';
    el.hidden = false;
  }
  function loadIndex() {
    if (indexLoaded || loadingIdx) { renderBar(); return; }
    loadingIdx = true;
    fetch("data/weekly/index.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { loadingIdx = false; indexLoaded = true; index = j || { list: [] }; renderBar(); })
      .catch(function () { loadingIdx = false; indexLoaded = true; index = { list: [] }; renderBar(); });
  }
  // app.js 频道切换时调用:资讯频道才显示横条
  function sync(channel) {
    var el = ensureBar();
    if (!el) return;
    if (channel === "news") loadIndex();
    else el.hidden = true;
  }

  // ---------- 阅读页(#/w/<id>) ----------
  function build() {
    if (page) return;
    page = document.createElement("div");
    page.className = "ppage"; page.id = "weeklyPage"; page.hidden = true;
    document.body.appendChild(page);
    page.addEventListener("click", function (e) {
      if (e.target.closest("#wrBack")) { e.preventDefault(); AP.router.goList(); }
    });
  }
  function backBtn() {
    return '<button class="btn btn--ghost ppage__back" id="wrBack" type="button">← ' + esc(AP.t("back")) + '</button>';
  }
  function itemRow(it) {
    var meta = [];
    var href, ext = false;
    if (it.kind === "opp") {
      href = "#/o/" + encodeURIComponent(it.oid);
      if (it.org) meta.push(it.org);
      var place = [it.city, it.country].filter(Boolean).join(" ");
      if (place) meta.push(place);
      if (it.deadline) meta.push(esc(AP.t("job_deadline")) + " " + it.deadline);
    } else if (it.kind === "news") {
      href = it.url; ext = true;
      if (it.source) meta.push(it.source);
      if (it.published_at) meta.push(it.published_at);
    } else {
      href = it.url; ext = true;
      if (it.org) meta.push(it.org);
      if (it.location) meta.push(it.location);
      if (it.deadline) meta.push(esc(AP.t("job_deadline")) + " " + it.deadline);
    }
    if (!href) return "";
    return '<a class="wr-item" href="' + esc(href) + '"' + (ext ? ' target="_blank" rel="noopener nofollow"' : "") + '>' +
      '<span class="wr-item__title">' + esc(it.title) + (ext ? ' <span class="wr-item__ext" aria-hidden="true">↗</span>' : "") + '</span>' +
      (meta.length ? '<span class="wr-item__meta">' + esc(meta.join(" · ")) + '</span>' : "") +
      (it.summary ? '<span class="wr-item__sum">' + esc(it.summary) + '</span>' : "") +
    '</a>';
  }
  function headingOf(s) {
    if (s.key === "opps") return AP.t("wrSecOpps");
    if (s.key === "news") return AP.t("wrSecNews");
    if (s.key === "jobs") return AP.t("wrSecJobs");
    return s.heading || "";
  }
  function renderReport(r) {
    var html =
      '<div class="ppage__inner wrpage">' + backBtn() +
      '<div class="wr-head">' +
        '<div class="wr-head__brand">ARTPORTAL · ' + esc(AP.t("wrBrand")) + '</div>' +
        '<h1 class="wr-head__title">' + esc(r.title) + '</h1>' +
        '<p class="wr-head__meta">' + esc(r.date || r.id) + (r.ai_composed ? ' · ' + esc(AP.t("wrAiNote")) : "") + '</p>' +
      '</div>' +
      (r.intro ? '<p class="wr-intro">' + esc(r.intro) + '</p>' : "");
    for (var i = 0; i < (r.sections || []).length; i++) {
      var s = r.sections[i];
      if (!s.items || !s.items.length) continue;
      html += '<section class="wr-sec"><h2 class="wr-sec__h">' + esc(headingOf(s)) + '</h2>' +
        (s.note ? '<p class="wr-sec__note">' + esc(s.note) + '</p>' : "");
      for (var j = 0; j < s.items.length; j++) html += itemRow(s.items[j]);
      html += '</section>';
    }
    if (r.outro) html += '<p class="wr-outro">' + esc(r.outro) + '</p>';
    // 往期
    if (index && index.list && index.list.length > 1) {
      html += '<div class="wr-arch"><h2 class="wr-sec__h">' + esc(AP.t("wrArchive")) + '</h2>';
      for (var k = 0; k < Math.min(index.list.length, 12); k++) {
        var it = index.list[k];
        if (it.id === r.id) continue;
        html += '<a class="wr-arch__row" href="#/w/' + encodeURIComponent(it.id) + '">' + esc(it.title) + ' <span class="wr-item__meta">' + esc(it.date || it.id) + '</span></a>';
      }
      html += '</div>';
    }
    html += '</div>';
    page.innerHTML = html;
    page.scrollTop = 0;
  }
  function open(id) {
    build();
    page.hidden = false;
    document.body.style.overflow = "hidden";
    curId = id;
    if (!indexLoaded) loadIndex();   // 往期列表用
    if (reports[id]) { renderReport(reports[id]); return; }
    page.innerHTML = '<div class="ppage__inner">' + backBtn() + '<p class="ppage__empty">…</p></div>';
    fetch("data/weekly/" + encodeURIComponent(id) + ".json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (r) {
        if (curId !== id) return;
        if (!r) { page.innerHTML = '<div class="ppage__inner">' + backBtn() + '<p class="ppage__empty">' + esc(AP.t("wrNotFound")) + '</p></div>'; return; }
        reports[id] = r;
        renderReport(r);
      })
      .catch(function () {
        if (curId === id) page.innerHTML = '<div class="ppage__inner">' + backBtn() + '<p class="ppage__empty">' + esc(AP.t("authNetErr")) + '</p></div>';
      });
  }
  function close() {
    if (page && !page.hidden) { page.hidden = true; document.body.style.overflow = ""; curId = null; }
  }

  // 路由:#/w/<id> 打开,其余关闭(router.parse 已识别 weekly)
  function onRoute() {
    var r = AP.router.parse();
    if (r.name === "weekly") open(r.id);
    else close();
  }
  AP.router.onChange(onRoute);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onRoute);
  else onRoute();

  AP.weekly = { sync: sync, refresh: function () { if (page && !page.hidden && curId && reports[curId]) renderReport(reports[curId]); renderBar(); } };
})();
