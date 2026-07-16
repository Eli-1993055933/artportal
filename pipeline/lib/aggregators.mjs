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

export function hostOf(u) {
  try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; }
}

// 该 URL 是否落在第三方域名(= 不是主办方自己的官网)
export function isThirdParty(u) {
  const h = hostOf(u);
  if (!h) return false;
  return THIRD_PARTY.some(t => h === t || h.endsWith("." + t));
}
