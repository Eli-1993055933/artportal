/* 极简 hash 路由。深链 #/o/<id> 必须可分享(微信群传播)。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});

  AP.router = {
    // 解析当前 hash → { name, id }
    parse: function () {
      var h = location.hash || "";
      var m = /^#\/o\/(.+)$/.exec(h);
      if (m) return { name: "detail", id: decodeURIComponent(m[1]) };
      return { name: "list", id: null };
    },
    goDetail: function (id) { location.hash = "#/o/" + encodeURIComponent(id); },
    goList: function () {
      // 用 history 保留返回;若无历史则清 hash
      if (location.hash && location.hash.indexOf("#/o/") === 0) {
        history.pushState("", document.title, location.pathname + location.search);
      }
    },
    onChange: function (cb) {
      window.addEventListener("hashchange", cb);
      window.addEventListener("popstate", cb);
    }
  };
})();
