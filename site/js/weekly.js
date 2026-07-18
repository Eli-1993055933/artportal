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
    var barTitle = (AP.lang === "en" && latest.title_en) ? latest.title_en : latest.title;
    el.innerHTML =
      '<a class="wr-bar__main" href="#/w/' + encodeURIComponent(latest.id) + '">' +
        '<span class="wr-bar__ico" aria-hidden="true">✦</span>' +
        '<span class="wr-bar__title">' + esc(barTitle) + '</span>' +
        '<span class="wr-bar__date">' + esc(latest.date || latest.id) + '</span>' +
        '<span class="wr-bar__meta">' + esc(AP.t("wrRead")) + ' →</span>' +
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
  // 周报横条全局常显(用户 2026-07-18 要求:切任何频道都固定在栏目条+标签条下方)。
  // app.js 频道切换仍会调用 sync(兼容旧签名)——现在只负责语言切换等场景的重渲。
  function sync() { renderBar(); }

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
  // 往期目录(两种渲染格式共用)
  function archiveHtml(curId) {
    if (!(index && index.list && index.list.length > 1)) return "";
    var html = '<div class="wr-arch"><h2 class="wr-sec__h">' + esc(AP.t("wrArchive")) + '</h2>';
    for (var k = 0; k < Math.min(index.list.length, 12); k++) {
      var it = index.list[k];
      if (it.id === curId) continue;
      var tt = (AP.lang === "en" && it.title_en) ? it.title_en : it.title;
      html += '<a class="wr-arch__row" href="#/w/' + encodeURIComponent(it.id) + '">' + esc(tt) + ' <span class="wr-item__meta">' + esc(it.date || it.id) + '</span></a>';
    }
    return html + '</div>';
  }
  // ---------- 文章型周刊(format 2,v0.70.0):撰稿 agent 成文,NYT 式排版 ----------
  // 文内引用(程序回填的真实链接):机会→站内详情深链,资讯/招聘→原文新窗口;带上标编号对应文末「本期提及」。
  function refLinkHtml(ref) {
    var href = ref.kind === "opp" ? "#/o/" + encodeURIComponent(ref.oid) : (ref.url || "#");
    var ext = ref.kind !== "opp";
    return '<a class="wra-ref" href="' + esc(href) + '"' + (ext ? ' target="_blank" rel="noopener nofollow"' : "") + '>' + esc(ref.text) + '</a><sup class="wra-sup">[' + ref.n + ']</sup>';
  }
  function renderArticle(r) {
    // 中英切换:英文界面且该期带 en 平行版 → 用英文文本层(image/references 共用中文版;
    // 英文由机器翻译,meta 行如实标注);老刊/翻译失败 → 英文界面回退中文。
    var en = AP.lang === "en" && r.en;
    var T = en ? r.en : r;
    var byline = (AP.lang === "en" ? "By " : "文 / ") + (r.author || "Eli");
    var html =
      '<div class="ppage__inner wrpage wra">' + backBtn() +
      '<header class="wra-head">' +
        '<div class="wra-brand">ARTPORTAL · ' + esc(AP.t("wrBrand")) + '</div>' +
        '<h1 class="wra-title">' + esc(T.title) + '</h1>' +
        (T.subtitle ? '<p class="wra-sub">' + esc(T.subtitle) + '</p>' : "") +
        '<p class="wra-meta">' + esc(byline) + ' · ' + esc(r.id + " · " + (r.date || "")) + '</p>' +
      '</header>';
    (T.sections || []).forEach(function (sc, i) {
      var zhSec = (r.sections || [])[i] || {};          // 配图跟中文版结构走(en 只译文本层)
      html += '<section class="wra-sec"><h2 class="wra-h2">' + esc(sc.heading) + '</h2>';
      if (zhSec.image) {
        var cap = (en && zhSec.image.caption_en) ? zhSec.image.caption_en : zhSec.image.caption;
        html += '<figure class="wra-fig"><img loading="lazy" src="' + esc(zhSec.image.src) + '" alt="" onerror="this.parentNode.remove()" />' +
          '<figcaption>' + esc(cap) + '</figcaption></figure>';
      }
      (sc.paragraphs || []).forEach(function (p) {
        html += '<p class="wra-p">' + p.map(function (sg) { return sg.t != null ? esc(sg.t) : refLinkHtml(sg.ref); }).join("") + '</p>';
      });
      html += '</section>';
    });
    if (T.closing) html += '<p class="wra-closing">' + esc(T.closing) + '</p>';
    if (r.references && r.references.length) {
      html += '<div class="wra-refs"><h2 class="wra-h2">' + esc(AP.t("wraRefs")) + '</h2>';
      r.references.forEach(function (ref) {
        var href = ref.kind === "opp" ? "#/o/" + encodeURIComponent(ref.oid) : (ref.url || "#");
        var ext = ref.kind !== "opp";
        var rTitle = (en && ref.title_en) ? ref.title_en : ref.title;
        var rMeta = (en && ref.meta_en) ? ref.meta_en : ref.meta;
        html += '<p class="wra-refrow">[' + ref.n + '] <a href="' + esc(href) + '"' + (ext ? ' target="_blank" rel="noopener nofollow"' : "") + '>' + esc(rTitle) + '</a>' +
          (rMeta ? ' <span class="wra-refmeta">— ' + esc(rMeta) + '</span>' : "") + '</p>';
      });
      html += '</div>';
    }
    // AI 生成提示:按用户要求从标题下移到文章最末尾的小字(诚实标注不变,位置更克制)
    html += '<p class="wra-ainote">' + esc(AP.t("wraAiFoot")) + (en ? esc(" · Machine-translated from the Chinese original.") : "") + '</p>';
    html += archiveHtml(r.id) + '</div>';
    page.innerHTML = html;
    page.scrollTop = 0;
  }
  function renderReport(r) {
    if (r.format === 2) { renderArticle(r); return; }
    var html =
      '<div class="ppage__inner wrpage">' + backBtn() +
      '<div class="wr-head">' +
        '<div class="wr-head__brand">ARTPORTAL · ' + esc(AP.t("wrBrand")) + '</div>' +
        '<h1 class="wr-head__title">' + esc(r.title) + '</h1>' +
        '<p class="wr-head__meta">' + esc(r.date || r.id) + '</p>' +
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
    if (r.ai_composed) html += '<p class="wra-ainote">' + esc(AP.t("wraAiFoot")) + '</p>';
    html += archiveHtml(r.id) + '</div>';
    page.innerHTML = html;
    page.scrollTop = 0;
  }
  // 衬线 webfont(思源宋体分片)只在进入周刊阅读页时加载:主站不背这份体积,
  // 手机(安卓/微信无内置衬线中文字体)也能得到与电脑一致的宋体排版。
  var fontLoaded = false;
  function ensureFont() {
    if (fontLoaded) return;
    fontLoaded = true;
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "assets/fonts/noto-serif-sc/serif.css";
    document.head.appendChild(l);
  }
  function open(id) {
    build();
    ensureFont();
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
  function boot() { onRoute(); loadIndex(); }   // 启动即取周报目录:横条第一屏就位(任何频道)
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  AP.weekly = { sync: sync, refresh: function () { if (page && !page.hidden && curId && reports[curId]) renderReport(reports[curId]); renderBar(); } };
})();
