/* 筛选 / 搜索 / 排序 —— 纯前端,不接 AI。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});
  var F = AP.format;

  var state = AP.filterState = {
    q: "",
    cat: "all",
    tag: "",                   // 艺术门类(tags.js 的 23 门类,单选;""=全部;四频道共用)
    regions: new Set(),
    freeOnly: false,
    funds: new Set(),          // stipend / housing / travel
    orgTypes: new Set(),       // official / independent / commercial
    verifiedOnly: false,
    sort: "deadline",
    showPast: true,        // 默认显示"过往项目"(灰卡)
    showUpcoming: true,    // 默认显示"即将开启"(周期展下届推算)
    showUserSub: true,     // 默认显示"用户上传"(trust:user 投稿)
    showAiSearch: true,    // 默认显示"AI 检索"入库的条目
    favOnly: false,
    pinnedIds: null        // 本次 AI 检索新增的 id 集合:免搜索/筛选过滤,并置顶显示
  };

  AP.hasActiveMoreFilters = function () {
    return state.regions.size || state.freeOnly || state.funds.size ||
           state.orgTypes.size || state.verifiedOnly ||
           state.showPast === false || state.showUpcoming === false ||
           state.showUserSub === false || state.showAiSearch === false;
  };

  AP.clearMoreFilters = function () {
    state.regions.clear(); state.freeOnly = false; state.funds.clear();
    state.orgTypes.clear(); state.verifiedOnly = false;
    state.showPast = true; state.showUpcoming = true;   // 复位为默认全显
    state.showUserSub = true; state.showAiSearch = true;
  };

  // 主流程:返回过滤+排序后的数组
  AP.applyFilters = function (list) {
    var q = state.q.trim().toLowerCase();
    var out = list.filter(function (o) {
      // 收藏视图
      if (state.favOnly && !AP.favorites.has(o.id)) return false;
      // dead 状态永不显示
      if (o.status === "dead") return false;
      // 硬性保证:只展示能一点击直达主办方官网的条目。定位不到官网的先不显示,
      // 管道每晚持续重试,定位到官网后自动出现(绝不让用户点到聚合平台/新闻页)。
      // 例外:用户投稿(trust:"user")官网链接为选填——无链接也展示(卡片"前往官网"呈禁用态,
      // 且有"用户投稿·未经核实"标注),来源在详情页如实展示。
      if (!F.officialUrl(o) && o.trust !== "user") return false;
      // 本次 AI 检索新增:免搜索/分类/筛选过滤,保证一定看得到(排序里再置顶)
      if (state.pinnedIds && state.pinnedIds.has(o.id)) return true;
      // 分类
      if (state.cat !== "all" && o.category !== state.cat) return false;
      // 艺术门类(标签行,单选;tags.js 关键词匹配 disciplines/标题/摘要)
      if (state.tag && AP.tagsOf(o, "opportunities").indexOf(state.tag) === -1) return false;
      // 三态显示范围:open 恒显;past/upcoming 默认显示,用户可在"更多筛选"里关掉
      var st = F.itemState(o);
      if (st === "past" && !state.showPast) return false;
      if (st === "upcoming" && !state.showUpcoming) return false;
      // 来源范围:用户上传 / AI 检索,默认显示,可关
      if (!state.showUserSub && (o.trust === "user" || o._via === "submit")) return false;
      if (!state.showAiSearch && o._via === "search") return false;
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
      // 机构类型(任一命中即可)
      if (state.orgTypes.size && !state.orgTypes.has(o.org_type)) return false;
      // 仅看已人工核实
      if (state.verifiedOnly && o.trust !== "verified") return false;
      return true;
    });

    out.sort(function (a, b) {
      if (state.pinnedIds) {                       // 本次检索新增置顶
        var pa = state.pinnedIds.has(a.id) ? 0 : 1, pb = state.pinnedIds.has(b.id) ? 0 : 1;
        if (pa !== pb) return pa - pb;
      }
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
