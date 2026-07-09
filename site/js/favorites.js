/* 收藏:纯 localStorage,无账号。 */
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
      return set.has(id);
    }
  };
})();
