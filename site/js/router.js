/* 极简 hash 路由。深链 #/o/<id> 必须可分享(微信群传播)。
   关键:开/关详情都以 hash 变化为准,确保 hashchange/popstate 一定触发 syncRoute。
   之前用 history.pushState 关闭详情——pushState 不触发任何事件,导致详情关不掉,已修复。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});

  AP.router = {
    _appNav: false, // 是否由站内点击进入过详情(用于决定返回用 history.back 还是清 hash)

    // 解析当前 hash → { name, id }
    parse: function () {
      var h = location.hash || "";
      var m = /^#\/o\/(.+)$/.exec(h);
      if (m) return { name: "detail", id: decodeURIComponent(m[1]) };
      return { name: "list", id: null };
    },

    goDetail: function (id) {
      this._appNav = true;
      location.hash = "#/o/" + encodeURIComponent(id); // 触发 hashchange → 打开详情
    },

    goList: function () {
      if (this.parse().name !== "detail") return;
      if (this._appNav && history.length > 1) {
        // 站内进入的:用浏览器后退,URL 干净、与前进后退一致
        this._appNav = false;
        history.back();                 // 触发 popstate → syncRoute → 关闭详情
      } else {
        // 直接打开深链的:清掉 hash 并手动同步(replaceState 不发事件,需手动派发)
        history.replaceState("", document.title, location.pathname + location.search);
        window.dispatchEvent(new Event("hashchange"));
      }
    },

    onChange: function (cb) {
      window.addEventListener("hashchange", cb);
      window.addEventListener("popstate", cb);
    }
  };
})();
