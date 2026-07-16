/* 详情原地展开:入库时已把官网原文翻好中英双语存档(data/fulltext/*.json),
   点「详情」就地展开当前界面语言的版本——零现场检索、零现场翻译、不弹任何独立界面。
   诚实红线:展示的是翻译侧时,顶部标注"机器翻译·以官网为准";原文侧标注"官网原文"。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var esc = AP.format.esc;
  var cache = {};   // 存档路径 -> 已解析 JSON(会话内复用)

  function pickLang(doc) {
    var want = AP.lang === "en" ? "en" : "zh";
    var text = doc[want] || doc[doc.src] || doc.zh || doc.en || "";
    return { text: text, mt: !!(doc[want] && want !== doc.src) };
  }
  function render(box, doc) {
    var p = pickLang(doc);
    var html = '<p class="ft-note">' + esc(AP.t(p.mt ? "ftMtNote" : "ftSrcNote")) + '</p>';
    var parts = String(p.text || "").split(/\n+/);
    for (var i = 0; i < parts.length; i++) if (parts[i].trim()) html += "<p>" + esc(parts[i]) + "</p>";
    box.innerHTML = p.text ? html : ('<p class="ft-note">' + esc(AP.t("ftMissing")) + '</p>');
  }
  function setLabel(btn, open) {
    btn.textContent = open ? (AP.t("detailCollapse") + " ▴") : (AP.t("detailMore") + " ▸");
  }

  AP.fulltext = {
    toggle: function (btn) {
      var path = btn.getAttribute("data-fulltext");
      if (!path) return;
      var box = btn._ftBox;
      if (box && !box.hidden) { box.hidden = true; setLabel(btn, false); return; }   // 收起
      if (!box) {
        box = document.createElement("div");
        box.className = "ft-body";
        box.addEventListener("click", function (e) { e.stopPropagation(); });   // 展开区内点击不触发整卡跳转
        var anchor = btn.closest(".d-morewrap") || btn.closest(".card__foot") || btn;
        anchor.parentNode.insertBefore(box, anchor.nextSibling);
        btn._ftBox = box;
      }
      box.hidden = false;
      setLabel(btn, true);
      var doc = cache[path];
      if (doc) { render(box, doc); return; }
      box.innerHTML = '<p class="ft-note">…</p>';
      fetch(path, { cache: "force-cache" })
        .then(function (r) { if (!r.ok) throw 0; return r.json(); })
        .then(function (d) { cache[path] = d; render(box, d); })
        .catch(function () { box.innerHTML = '<p class="ft-note">' + esc(AP.t("ftMissing")) + '</p>'; });
    }
  };
})();
