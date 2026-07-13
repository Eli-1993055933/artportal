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
    showPast: true,        // 默认显示"过往项目"(灰卡)
    showUpcoming: true,    // 默认显示"即将开启"(周期展下届推算)
    favOnly: false
  };

  AP.hasActiveMoreFilters = function () {
    return state.regions.size || state.freeOnly || state.funds.size ||
           state.discs.size || state.verifiedOnly ||
           state.showPast === false || state.showUpcoming === false;
  };

  AP.clearMoreFilters = function () {
    state.regions.clear(); state.freeOnly = false; state.funds.clear();
    state.discs.clear(); state.verifiedOnly = false;
    state.showPast = true; state.showUpcoming = true;   // 复位为默认全显
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
      // 三态显示范围:open 恒显;past/upcoming 默认显示,用户可在"更多筛选"里关掉
      var st = F.itemState(o);
      if (st === "past" && !state.showPast) return false;
      if (st === "upcoming" && !state.showUpcoming) return false;
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

  // 排序分层:正在开放 → 即将开启 → 过往项目,组内再按日期。
  function deadlineRank(o) {
    var st = F.itemState(o);
    var n = F.daysUntil(o.deadline);
    if (st === "open") return (o.deadline == null || n == null) ? 5e8 : n;   // 未来越近越前;常年排开放组末尾
    if (st === "upcoming") return 1e9 + (n == null ? 0 : n);                 // 即将开启组
    return 2e9 + (n == null ? 0 : n);                                        // 过往组置底
  }
})();
