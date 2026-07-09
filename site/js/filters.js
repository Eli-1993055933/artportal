/* 筛选 / 搜索 / 排序 —— 纯前端,不接 AI。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var F = AP.format;

  var state = AP.filterState = {
    q: "",
    cat: "all",
    regions: new Set(),
    freeOnly: false,
    funds: new Set(),          // stipend / housing / travel
    discs: new Set(),
    verifiedOnly: false,
    sort: "deadline",
    showExpired: false,
    favOnly: false
  };

  AP.hasActiveMoreFilters = function () {
    return state.regions.size || state.freeOnly || state.funds.size ||
           state.discs.size || state.verifiedOnly;
  };

  AP.clearMoreFilters = function () {
    state.regions.clear(); state.freeOnly = false; state.funds.clear();
    state.discs.clear(); state.verifiedOnly = false;
  };

  // 主流程:返回过滤+排序后的数组
  AP.applyFilters = function (list) {
    var q = state.q.trim().toLowerCase();
    var out = list.filter(function (o) {
      // 收藏视图
      if (state.favOnly && !AP.favorites.has(o.id)) return false;
      // dead 状态永不显示
      if (o.status === "dead") return false;
      // 分类
      if (state.cat !== "all" && o.category !== state.cat) return false;
      // 已截止:默认隐藏(常年 deadline=null 的不算过期)
      if (!state.showExpired && F.isExpired(o)) return false;
      // 关键词
      if (q && F.searchText(o).indexOf(q) === -1) return false;
      // 地区
      if (state.regions.size && !state.regions.has(F.region(o))) return false;
      // 完全免费
      if (state.freeOnly && !F.isFullyFree(o)) return false;
      // 资助(需全部选中项都为 true)
      if (state.funds.size) {
        var f = o.funding || {};
        var ok = true;
        state.funds.forEach(function (k) { if (f[k] !== true) ok = false; });
        if (!ok) return false;
      }
      // 学科(任一命中即可)
      if (state.discs.size) {
        var ds = o.disciplines || [];
        var hit = false;
        state.discs.forEach(function (d) { if (ds.indexOf(d) !== -1) hit = true; });
        if (!hit) return false;
      }
      // 仅看已人工核实
      if (state.verifiedOnly && o.trust !== "verified") return false;
      return true;
    });

    out.sort(function (a, b) {
      if (state.sort === "updated") {
        return String(b.updated_at || "").localeCompare(String(a.updated_at || ""));
      }
      // 截止由近到远:null(常年)排最后;已过期排更后
      return deadlineRank(a) - deadlineRank(b);
    });
    return out;
  };

  function deadlineRank(o) {
    var n = F.daysUntil(o.deadline);
    if (o.deadline == null || n == null) return 1e9;      // 常年 → 末尾
    if (n < 0) return 1e8 + n;                             // 已过期 → 靠后但保留相对序
    return n;                                              // 未来天数越小越靠前
  }
})();
