/* 艺术门类标签体系(v0.66.0)——全站统一,四频道(机会/资讯/招聘/作品)共用。
   调研依据:国际驻留与征集平台的学科分类(MacDowell/Centrum/Art Omi/DAAD/ArtRabbit:
   Visual Arts、Writing、Curatorial、Dance、Music/Sound、Film/Video、Architecture、
   Interdisciplinary…)+ Artsy/维基"艺术媒介清单" + 国内美院学科体系(中国画书法、
   实验艺术、工艺美术[陶瓷/玻璃/漆艺/金工]、纤维、跨媒体…)。
   原则:
   - 标签由【程序关键词匹配】从已有真实字段(disciplines/标题/摘要)推导,可审计、
     不经 AI、绝不编造;作品频道优先用作者自选标签(最准),缺省才关键词兜底。
   - 匹配是"导航辅助",宁可漏标不误导:中文用高区分度词(绝不用单字"画"这类),
     英文按词边界整词匹配。 */
(function () {
  "use strict";
  var AP = window.AP || (window.AP = {});

  // 23 门类:id 全站唯一(存库/筛选用),zh/en 为展示名。顺序即展示顺序(大门类在前)。
  var TAGS = [
    { id: "painting",     zh: "绘画",       en: "Painting",
      k: ["绘画", "油画", "水彩", "丙烯", "坦培拉", "壁画", "岩彩", "架上"],
      e: ["painting", "painter", "watercolor", "watercolour", "acrylic", "mural"] },
    { id: "ink",          zh: "水墨/书法",  en: "Ink & Calligraphy",
      k: ["水墨", "国画", "中国画", "书法", "篆刻", "工笔", "写意", "书画"],
      e: ["ink painting", "ink art", "calligraphy"] },
    { id: "printmaking",  zh: "版画",       en: "Printmaking",
      k: ["版画", "丝网印", "铜版", "木刻", "石版", "藏书票"],
      e: ["printmaking", "etching", "lithography", "lithograph", "woodcut", "silkscreen", "screen print", "linocut"] },
    { id: "illustration", zh: "插画/漫画",  en: "Illustration",
      k: ["插画", "绘本", "漫画", "连环画", "插图"],
      e: ["illustration", "illustrator", "comic", "comics", "manga", "picture book"] },
    { id: "photography",  zh: "摄影",       en: "Photography",
      k: ["摄影"],
      e: ["photography", "photographer", "photographic", "photobook", "photo book"] },
    { id: "sculpture",    zh: "雕塑",       en: "Sculpture",
      k: ["雕塑", "雕刻"],
      e: ["sculpture", "sculptor", "carving"] },
    { id: "installation", zh: "装置",       en: "Installation",
      k: ["装置"],
      e: ["installation"] },
    { id: "video",        zh: "影像/电影",  en: "Film & Video",
      k: ["影像", "录像", "电影", "短片", "纪录片", "影片"],
      e: ["video", "film", "cinema", "moving image", "documentary", "filmmaker"] },
    { id: "animation",    zh: "动画",       en: "Animation",
      k: ["动画", "动漫"],
      e: ["animation", "animator", "anime"] },
    { id: "newmedia",     zh: "新媒体/数字", en: "New Media & Digital",
      k: ["新媒体", "数字艺术", "数码艺术", "生成艺术", "交互艺术", "虚拟现实", "增强现实", "人工智能", "电子艺术", "科技艺术", "游戏艺术"],
      e: ["new media", "digital art", "generative", "interactive art", "net art", "virtual reality", "augmented reality", "ai art", "creative coding", "game art"] },
    { id: "sound",        zh: "声音/音乐",  en: "Sound & Music",
      k: ["声音艺术", "声音", "音乐", "作曲", "乐团", "乐队", "唱片", "声响"],
      e: ["sound art", "sound", "music", "composer", "composition", "musician", "audio"] },
    { id: "performance",  zh: "行为艺术",   en: "Performance Art",
      k: ["行为艺术", "现场艺术"],
      e: ["performance art", "live art"] },
    { id: "theater",      zh: "舞蹈/戏剧",  en: "Dance & Theatre",
      k: ["舞蹈", "戏剧", "剧场", "戏曲", "舞台", "编舞", "话剧", "音乐剧", "木偶", "舞者"],
      e: ["dance", "dancer", "theatre", "theater", "choreograph", "choreographer", "performing arts", "opera", "puppet"] },
    { id: "literature",   zh: "写作/文学",  en: "Writing & Literature",
      k: ["写作", "文学", "诗歌", "小说", "散文", "剧本", "征文", "诗人", "作家", "翻译"],
      e: ["writing", "writer", "literature", "literary", "poetry", "poet", "fiction", "essay", "screenwriting", "novel"] },
    { id: "design",       zh: "设计",       en: "Design",
      k: ["设计"],
      e: ["design", "designer", "graphic"] },
    { id: "fashion",      zh: "时尚/服饰",  en: "Fashion",
      k: ["时尚", "服装", "服饰", "时装", "穿戴"],
      e: ["fashion", "costume", "apparel", "wearable"] },
    { id: "architecture", zh: "建筑/空间",  en: "Architecture & Space",
      k: ["建筑", "景观", "城市设计", "空间设计", "人居", "乡建"],
      e: ["architecture", "architect", "urban design", "landscape", "spatial design"] },
    { id: "ceramics",     zh: "陶瓷",       en: "Ceramics",
      k: ["陶瓷", "陶艺", "陶器", "瓷器", "青瓷", "白瓷", "柴烧", "紫砂"],
      e: ["ceramic", "ceramics", "pottery", "porcelain", "clay"] },
    { id: "glass",        zh: "玻璃",       en: "Glass",
      k: ["玻璃", "琉璃"],
      e: ["glass", "glassblowing", "stained glass"] },
    { id: "textile",      zh: "纤维/织物",  en: "Textile & Fiber",
      k: ["纤维", "织物", "编织", "刺绣", "染织", "缂丝", "地毯", "毛毡", "织造"],
      e: ["textile", "fiber art", "fibre art", "weaving", "embroidery", "tapestry", "felt"] },
    { id: "craft",        zh: "工艺",       en: "Craft",
      k: ["工艺", "手作", "手工", "漆艺", "大漆", "木作", "金工", "首饰", "珠宝", "竹编", "民艺", "非遗"],
      e: ["craft", "jewelry", "jewellery", "lacquer", "woodworking", "metalwork", "artisan"] },
    { id: "curation",     zh: "策展/研究",  en: "Curation & Research",
      k: ["策展", "研究", "艺术史", "理论", "批评", "学术", "档案", "艺术管理", "评论"],
      e: ["curator", "curatorial", "art history", "research", "criticism", "critic", "archive", "scholar"] },
    { id: "mixed",        zh: "跨媒介/综合", en: "Interdisciplinary",
      k: ["跨媒介", "跨学科", "综合材料", "多媒介", "实验艺术", "社会参与", "公共艺术", "不限", "所有媒介", "各类媒介", "任何媒介", "媒介不限", "多学科", "所有艺术"],
      e: ["interdisciplinary", "multidisciplinary", "mixed media", "cross-media", "all media", "any medium", "open to all", "social practice", "public art"] }
  ];
  // 英文整词匹配:预编译每个门类一条词边界正则(避免 glass 命中 glasses、art 命中 party 之类)
  for (var ti = 0; ti < TAGS.length; ti++) {
    TAGS[ti].re = new RegExp("\\b(?:" + TAGS[ti].e.join("|").replace(/ /g, "[ -]") + ")\\b", "i");
  }
  var TAG_IDS = {};
  TAGS.forEach(function (t) { TAG_IDS[t.id] = t; });

  // 各频道参与匹配的文本字段(机会以 disciplines 为主;作品仅兜底用)
  function textOf(o, channel) {
    var parts;
    if (channel === "opportunities") {
      parts = [(o.disciplines || []).join(" "), o.title_zh, o.title_en, o.summary_zh, o.eligibility && o.eligibility.nationality];
    } else if (channel === "news") {
      parts = [o.title, o.title_zh, o.title_en, o.summary, o.summary_zh, o.summary_en, o.category];
    } else if (channel === "jobs") {
      parts = [o.title, o.title_zh, o.title_en, o.org, o.org_zh, o.summary, o.summary_zh, o.summary_en];
    } else {  // works 兜底(有作者自选标签时不会走到这)
      parts = [o.title, o.description];
    }
    return parts.filter(Boolean).join(" ");
  }

  // 一条内容 → 命中的门类 id 数组。作品优先作者自选;结果 memo 在对象上(数据会话内不变)。
  function tagsOf(o, channel) {
    if (channel === "works" && Array.isArray(o.tags) && o.tags.length) {
      return o.tags.filter(function (id) { return TAG_IDS[id]; });
    }
    if (o._aptags) return o._aptags;
    var text = textOf(o, channel);
    var lower = text.toLowerCase();
    var hits = [];
    for (var i = 0; i < TAGS.length; i++) {
      var t = TAGS[i], hit = false;
      for (var j = 0; j < t.k.length; j++) {
        if (text.indexOf(t.k[j]) !== -1) { hit = true; break; }
      }
      if (!hit && t.re.test(lower)) hit = true;
      if (hit) hits.push(t.id);
    }
    o._aptags = hits;
    return hits;
  }

  // 门类计数(渲染 chip 行用):可传 pre(o)=>bool 先做硬性过滤(如机会的官网闸)
  function tagCounts(list, channel, pre) {
    var counts = {};
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (pre && !pre(o)) continue;
      var ts = tagsOf(o, channel);
      for (var j = 0; j < ts.length; j++) counts[ts[j]] = (counts[ts[j]] || 0) + 1;
    }
    return counts;
  }

  AP.TAGS = TAGS;
  AP.tagLabel = function (id) { var t = TAG_IDS[id]; return t ? (AP.lang === "en" ? t.en : t.zh) : id; };
  AP.tagsOf = tagsOf;
  AP.tagCounts = tagCounts;
})();
