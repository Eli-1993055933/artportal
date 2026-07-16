/* 官网内容速览:把本站收录的官网页面正文经后端机器翻译,在站内面板辅助阅读,中/EN 一键切换。
   诚实边界:面板固定标注"机器翻译·以官网原文为准",主按钮仍是"前往官网"(带注册墙 gate)。
   注:无法在别人的官网页面上注入翻译(浏览器同源安全边界),故做站内速览而非"代理翻译"。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var esc = AP.format.esc;
  var cur = { url: null, to: null, ctrl: null };

  function build() {
    var el = document.getElementById("transModal");
    if (el) return el;
    el = document.createElement("div");
    el.className = "trans"; el.id = "transModal"; el.hidden = true;
    el.innerHTML =
      '<div class="trans__scrim" id="transScrim"></div>' +
      '<div class="trans__panel" role="dialog" aria-modal="true" aria-labelledby="transTitleEl">' +
        '<button class="auth__close" id="transClose" type="button" aria-label="关闭">✕</button>' +
        '<h2 class="auth__title" id="transTitleEl"></h2>' +
        '<div class="trans__tabs" role="tablist">' +
          '<button type="button" data-to="zh" id="transTabZh">中文</button>' +
          '<button type="button" data-to="en" id="transTabEn">English</button>' +
        '</div>' +
        '<p class="trans__note" id="transNote"></p>' +
        '<div class="trans__body" id="transBody"></div>' +
        '<div class="d-actions trans__foot">' +
          '<a class="btn btn--dark" id="transGo" href="#" target="_blank" rel="noopener"></a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(el);
    document.getElementById("transClose").addEventListener("click", close);
    document.getElementById("transScrim").addEventListener("click", close);
    // 已在当前语言就不重发(重复点当前 tab 会自我 abort 造成假失败)
    document.getElementById("transTabZh").addEventListener("click", function () { if (cur.url && cur.to !== "zh") load(cur.url, "zh"); });
    document.getElementById("transTabEn").addEventListener("click", function () { if (cur.url && cur.to !== "en") load(cur.url, "en"); });
    // 面板打开时吞 Esc(捕获阶段),避免连带关掉底下的详情页;
    // 但注册墙(z-index 更高)叠在上面时让行,由 auth 的 Esc 处理
    document.addEventListener("keydown", function (e) {
      var m = document.getElementById("transModal");
      var am = document.getElementById("authModal");
      if (am && !am.hidden) return;
      if (e.key === "Escape" && m && !m.hidden) { e.stopImmediatePropagation(); close(); }
    }, true);
    return el;
  }
  function close() {
    var el = document.getElementById("transModal");
    if (el) el.hidden = true;
    if (cur.ctrl) { try { cur.ctrl.abort(); } catch (e) {} }
    seq++;                                               // 使在飞回调全部失效
    cur = { url: null, to: null, ctrl: null };
  }
  function setTabs(to) {
    document.getElementById("transTabZh").className = to === "zh" ? "is-active" : "";
    document.getElementById("transTabEn").className = to === "en" ? "is-active" : "";
  }
  var seq = 0;   // 请求序号:只有"最新一次 load"能写面板(同 url+to 的新旧请求也能分清)
  function load(url, to) {
    var myId = ++seq;
    cur.url = url; cur.to = to;
    setTabs(to);
    var body = document.getElementById("transBody");
    body.innerHTML = '<p class="trans__loading">' + esc(AP.t("transLoading")) + '</p>';
    if (cur.ctrl) { try { cur.ctrl.abort(); } catch (e) {} }
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    cur.ctrl = ctrl;
    // 错误文案:中文界面可以直用后端 message(更具体);EN 界面统一用本地英文文案
    function failMsg(j) { return (AP.lang === "zh" && j && j.message) ? j.message : AP.t("transFail"); }
    fetch("/api/pagetrans?url=" + encodeURIComponent(url) + "&to=" + to, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (myId !== seq) return;                        // 已被更新的请求取代/面板已关
        if (!j || j.error) {
          body.innerHTML = '<p class="trans__loading">' + esc(failMsg(j)) + '</p>';
          return;
        }
        var html = "";
        if (j.title) html += '<h3 class="trans__pagetitle">' + esc(j.title) + '</h3>';
        var parts = String(j.text || "").split(/\n+/);
        for (var i = 0; i < parts.length; i++) if (parts[i].trim()) html += "<p>" + esc(parts[i]) + "</p>";
        if (j.truncated) html += '<p class="trans__loading">' + esc(AP.t("transTruncated")) + '</p>';
        body.innerHTML = html || ('<p class="trans__loading">' + esc(AP.t("transFail")) + '</p>');
      })
      .catch(function () {
        if (myId !== seq) return;                        // 含被 abort 的旧请求:不许覆盖新加载态
        body.innerHTML = '<p class="trans__loading">' + esc(AP.t("transFail")) + '</p>';
      });
  }

  AP.pageTrans = {
    open: function (url) {
      if (!url) return;
      build();
      document.getElementById("transTitleEl").textContent = AP.t("transTitle");
      document.getElementById("transNote").textContent = AP.t("transNote");
      var go = document.getElementById("transGo");
      go.href = url;
      go.textContent = AP.t("gotoSite") + " ↗";
      go.setAttribute("data-gate", "official");          // 从面板去官网同样走注册墙计数,口径一致
      document.getElementById("transModal").hidden = false;
      load(url, AP.lang === "en" ? "en" : "zh");
    },
    close: close
  };
})();
