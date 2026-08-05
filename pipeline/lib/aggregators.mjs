// aggregators.mjs —— 第三方域名黑名单(共享给管道/搜索/定位器/前端理念一致)。
//
// 这些域名不是"展览项目主办方自己的官网":聚合平台、机会目录、新闻转载、
// 设计赛事门户、文档托管、杂志。用户点「前往官网」绝不能落到这里,必须定位到主办方本站。
// 判定:host 完全等于名单项,或以 ".<名单项>" 结尾(覆盖子域)。

export const THIRD_PARTY = [
  // 机会聚合 / 驻留目录
  "curatorspace.com", "artconnect.com", "chinaresidencies.com", "resartis.org",
  "transartists.org", "artenda.net", "open-calls.art", "artresidencyguide.com",
  "artistcommunities.org", "e-flux.com", "art-hub.co.uk", "artrabbit.com",
  "artsandculture.google.com", "substack.com",   // 平台/个人媒体,非主办方官网(v1.4.0 区域扩员实测混入)
  // 杂志 / 艺讯
  "artforum.com.cn", "artealdia.com", "leapleapleap.com", "artforum.com", "artsy.net",
  // 新闻门户 / 转载
  "news.qq.com", "qq.com", "chinanews.com.cn", "gmw.cn", "xinhuanet.com",
  "zijing.com.cn", "china.cn", "52hrtt.com", "people.com.cn", "sina.com.cn",
  "sohu.com", "163.com", "thepaper.cn", "artron.net",
  // 文档托管
  "scribd.com", "docin.com", "doc88.com",
  // 设计赛事 / 征稿门户(转载征集信息,非主办方)
  "shejijingsai.com", "xingxiancn.com", "sj33.cn", "archcollege.com", "cn5v.com",
  "gaoyy.com", "chinaawards.net", "huaxiajiang.com", "zjideas.com", "whaleideas.com",
  "yczhansai.com", "cnyisai.com", "eduzs.org.cn", "10100.com", "jsmsg.com",
  "zhiliaobiaoxun.com", "ogdcn.com", "zcool.com.cn", "gtn9.com", "logohhh.com",
  "arting365.com", "68design.net", "shijue.me", "missku.com",
  // 社交(本就不抓,双保险)
  "mp.weixin.qq.com", "weixin.qq.com", "xiaohongshu.com", "douyin.com", "weibo.com", "zhihu.com"
];

// 可信机会/报名平台(TRUSTED_PLATFORMS,v0.76.0 L1)——第三方黑名单里【正经承载艺术机会/报名】的那一批。
// 国际公开征集大量【只存在于这些平台】、没有独立主办方官网;硬守"官网必达"等于把它们全拒之门外。
// L1 拆分:反幻觉红线(evidence 逐字校验)不变;"官网必达"放松为"官网优先、可信平台可接受(如实标注平台来源)"。
// 只收【真正的机会/驻留/报名平台】,不含杂志/新闻门户/设计赛事转载/文档托管/社媒——那些仍是硬垃圾、绝不放行。
export const TRUSTED_PLATFORMS = [
  // 驻留 / 机会目录与平台
  "curatorspace.com", "artconnect.com", "chinaresidencies.com", "resartis.org", "transartists.org",
  "artistcommunities.org", "open-calls.art", "artresidencyguide.com", "art-hub.co.uk", "artrabbit.com",
  "e-flux.com", "artenda.net",
  // 公开征集 / 报名托管平台(国际机构常把"官方报名页"直接放这上面)
  "callforentry.org", "submittable.com", "artcall.org", "entrythingy.com", "slideroom.com",
  "zapplication.org", "theartlist.com"
];

export function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; }
}

// 该 URL 是否落在第三方域名(= 不是主办方自己的官网)。语义不变,run.mjs/定位器/前端照旧。
export function isThirdParty(u) {
  const h = hostOf(u);
  if (!h) return false;
  return THIRD_PARTY.some(t => h === t || h.endsWith("." + t));
}

// 该 URL 是否是"可信机会平台"(第三方,但可作为可接受的落点,须如实标注"平台登记·非官网直采")。
export function isTrustedPlatform(u) {
  const h = hostOf(u);
  if (!h) return false;
  return TRUSTED_PLATFORMS.some(t => h === t || h.endsWith("." + t));
}
