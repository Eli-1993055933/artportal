/* 收藏:localStorage 为主;登录后由 auth.js 通过 replaceAll/onChange 与账号云同步。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var KEY = "ap_favorites";
  var set = load();

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(Array.from(set))); } catch (e) {}
  }

  AP.favorites = {
    has: function (id) { return set.has(id); },
    count: function () { return set.size; },
    ids: function () { return Array.from(set); },
    toggle: function (id) {
      if (set.has(id)) set.delete(id); else set.add(id);
      save();
      if (typeof AP.favorites.onChange === "function") AP.favorites.onChange();
      return set.has(id);
    },
    // 登录后云同步用:整体替换本地收藏(不触发 onChange,避免回环)
    replaceAll: function (ids) {
      set = new Set(Array.isArray(ids) ? ids : []);
      save();
    },
    onChange: null
  };
})();
