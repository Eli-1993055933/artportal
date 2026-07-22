/* 搜索面板(路线图 8.2):聚焦搜索框弹出。
   无输入 → 最近搜索(本机 localStorage,可清空);
   输入中 → 实时联想:用户(/api/users/search)+ 当前频道内容标题(本地数据,零请求)+ "✦ AI 全网检索"操作行。
   学习对象:小红书/B站搜索联想、GitHub 作用域建议。输入本身仍实时过滤列表(app.js),面板只做增强。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var input = null, panel = null, wrap = null, timer = null, lastQ = null;
  var HKEY = "ap_shist";

  function hist() {
    try { var a = JSON.parse(localStorage.getItem(HKEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function pushHist(q) {
    q = String(q || "").trim();
    if (!q) return;
    var a = hist().filter(function (x) { return x !== q; });
    a.unshift(q);
    try { localStorage.setItem(HKEY, JSON.stringify(a.slice(0, 8))); } catch (e) {}
  }

  function openPanel() { if (panel && panel.innerHTML) panel.hidden = false; }
  function closePanel() { if (panel) panel.hidden = true; }

  function secTitle(t, extra) {
    return '<div class="spanel__sec"><span>' + esc(t) + '</span>' + (extra || "") + '</div>';
  }

  function renderPanel(q) {
    if (!panel) return;
    var html = "";
    if (!q) {
      var h = hist();
      if (h.length) {
        html += secTitle(AP.t("spRecent"), '<button class="spanel__clear" id="spClear" type="button">' + esc(AP.t("spClear")) + '</button>');
        html += '<div class="spanel__chips">' + h.map(function (x) {
          return '<button class="spanel__chip" type="button" data-sq="' + esc(x) + '">' + esc(x) + '</button>';
        }).join("") + '</div>';
      }
      panel.innerHTML = html;
      panel.hidden = !html;
      return;
    }
    // 内容标题建议:当前频道已加载数据里取前 5 条命中(机会频道点击进详情;资讯/招聘卡片是外链,不做建议)
    var ch = AP.currentChannel ? AP.currentChannel() : "opportunities";
    if (ch === "opportunities") {
      var data = (AP.channelData && AP.channelData(ch)) || [];
      var ql = q.toLowerCase(), items = [];
      for (var i = 0; i < data.length && items.length < 5; i++) {
        var t = data[i].title_zh || data[i].title_en || "";
        if (t.toLowerCase().indexOf(ql) !== -1) items.push({ id: data[i].id, t: t });
      }
      if (items.length) {
        html += secTitle(AP.t("spItems"));
        html += items.map(function (x) {
          return '<button class="spanel__row" type="button" data-soid="' + esc(x.id) + '"><span class="spanel__rt">' + esc(x.t) + '</span></button>';
        }).join("");
      }
    }
    html = '<div id="spUsers"></div>' + html;   // 用户区块占位,异步填充
    html += '<button class="spanel__row spanel__ai" id="spAi" type="button">✦ ' + esc(AP.t("spAi")) + '「' + esc(q) + '」</button>';
    panel.innerHTML = html;
    panel.hidden = false;
    fetchUsers(q);
  }

  function fetchUsers(q) {
    lastQ = q;
    fetch("/api/users/search?q=" + encodeURIComponent(q), { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (lastQ !== q || !panel || panel.hidden) return;   // 面板已关/词已变,丢弃
        var box = document.getElementById("spUsers");
        if (!box || !j || !j.users || !j.users.length) return;
        box.innerHTML = secTitle(AP.t("spUsers")) + j.users.map(function (m) {
          return '<button class="spanel__row" type="button" data-suid="' + esc(m.id) + '">' +
            '<img class="spanel__ava" alt="" src="' + esc(m.avatar || "") + '" />' +
            '<span class="spanel__rt">' + esc(m.nickname) + '</span>' +
            (m.identity ? '<span class="spanel__idn">' + esc(AP.t("idn_" + m.identity)) + '</span>' : "") +
          '</button>';
        }).join("");
      })
      .catch(function () {});
  }

  function onPanelClick(e) {
    var h = e.target.closest("[data-sq]");
    if (h) {   // 点历史词:填入并复用 app.js 的实时过滤
      var q = h.getAttribute("data-sq");
      input.value = q;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      pushHist(q);
      renderPanel(q);
      input.focus();
      return;
    }
    if (e.target.closest("#spClear")) {
      try { localStorage.removeItem(HKEY); } catch (x) {}
      renderPanel("");
      return;
    }
    var urow = e.target.closest("[data-suid]");
    if (urow) { pushHist(input.value); closePanel(); AP.router.goUser(urow.getAttribute("data-suid")); return; }
    var crow = e.target.closest("[data-soid]");
    if (crow) { pushHist(input.value); closePanel(); AP.router.goDetail(crow.getAttribute("data-soid")); return; }
    if (e.target.closest("#spAi")) {
      pushHist(input.value);
      closePanel();
      var btn = document.getElementById("aiSearchBtn");
      if (btn) btn.click();
    }
  }

  function init() {
    wrap = document.querySelector(".searchbar");
    input = document.getElementById("searchInput");
    if (!wrap || !input) return;
    panel = document.createElement("div");
    panel.className = "spanel";
    panel.hidden = true;
    wrap.appendChild(panel);
    panel.addEventListener("click", onPanelClick);
    // 聚焦或再次点击搜索框都弹出联想(Esc 关掉后原地再点也能召回——已聚焦时不会再触发 focus 事件)
    function reopen() { renderPanel(input.value.trim()); openPanel(); }
    input.addEventListener("focus", reopen);
    input.addEventListener("click", reopen);
    input.addEventListener("input", function () {
      var q = input.value.trim();
      clearTimeout(timer);
      timer = setTimeout(function () { renderPanel(q); }, 180);   // 防抖:少打后端,少闪面板
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { pushHist(input.value); closePanel(); input.blur(); }
      else if (e.key === "Escape") closePanel();
    });
    // 点/触面板外即收起联想:捕获阶段——下游(如卡片门类彩标)stopPropagation 也拦不住它,面板必能关上。
    // pointerdown 覆盖鼠标+触摸,手机/微信里比 click 更即时可靠(click 有时因焦点转移/300ms 延迟不触发)。
    function outsideClose(e) { if (panel && !panel.hidden && !wrap.contains(e.target)) closePanel(); }
    document.addEventListener("pointerdown", outsideClose, true);
    document.addEventListener("click", outsideClose, true);
    // 点「AI 检索」按钮开始检索时,联想面板让位收起(按钮在 searchbar 内,外部关闭逻辑不覆盖它)
    var aiBtn = document.getElementById("aiSearchBtn");
    if (aiBtn) aiBtn.addEventListener("click", closePanel);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
