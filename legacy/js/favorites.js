/* 收藏:localStorage 为主;登录后由 auth.js 通过 replaceAll/onChange 与账号云同步。
   v0.73.0 起收藏扩展到四频道:键做频道命名空间——
   机会保持"裸 id"(向后兼容旧收藏与旧调用),资讯/招聘/作品加前缀 news:/job:/work:。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var KEY = "ap_favorites";
  var set = load();

  // 频道 → 键前缀(机会无前缀,保持裸 id)
  var PFX = { news: "news:", jobs: "job:", works: "work:" };
  function keyOf(id, ch) { return (PFX[ch] || "") + String(id); }
  // 键 → {ch, id};无已知前缀视为机会(兼容历史裸 id)
  function parseKey(key) {
    key = String(key);
    if (key.indexOf("news:") === 0) return { ch: "news", id: key.slice(5) };
    if (key.indexOf("job:") === 0)  return { ch: "jobs", id: key.slice(4) };
    if (key.indexOf("work:") === 0) return { ch: "works", id: key.slice(5) };
    return { ch: "opportunities", id: key };
  }

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
    // ch 省略 = 机会(向后兼容:filters.js/app.js 详情页仍按机会裸 id 调用)
    has: function (id, ch) { return set.has(keyOf(id, ch)); },
    count: function () { return set.size; },
    ids: function () { return Array.from(set); },
    keyOf: keyOf,
    parse: parseKey,
    toggle: function (id, ch) {
      var k = keyOf(id, ch);
      if (set.has(k)) set.delete(k); else set.add(k);
      save();
      if (typeof AP.favorites.onChange === "function") AP.favorites.onChange();
      return set.has(k);
    },
    // 登录后云同步用:整体替换本地收藏(不触发 onChange,避免回环)
    replaceAll: function (ids) {
      set = new Set(Array.isArray(ids) ? ids : []);
      save();
    },
    onChange: null
  };
})();
