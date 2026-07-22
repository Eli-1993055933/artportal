// globe-data.js —— 地球仪地理数据(真实经纬度 [lng,lat])
// 城市/国家中心坐标用于把机会落点到球面;国名中英映射用于地图标注。
// 反幻觉:坐标为城市/国家地理中心的公开常识值,前端如实标注"城市级中心点"。
(function(){
  // 城市名(中文) -> [经度, 纬度]
  var CITY = {
    // —— 中国大陆 ——
    "北京":[116.41,39.90],"上海":[121.47,31.23],"广州":[113.26,23.13],"深圳":[114.06,22.54],
    "成都":[104.07,30.57],"重庆":[106.55,29.56],"天津":[117.36,39.34],"南京":[118.80,32.06],
    "杭州":[120.16,30.27],"武汉":[114.31,30.59],"西安":[108.94,34.34],"厦门":[118.09,24.48],
    "长沙":[112.94,28.23],"郑州":[113.63,34.75],"青岛":[120.38,36.07],"苏州":[120.59,31.30],
    "沈阳":[123.43,41.81],"大连":[121.61,38.91],"昆明":[102.72,25.04],"济南":[117.12,36.65],
    "宁波":[121.55,29.87],"合肥":[117.23,31.82],"福州":[119.30,26.07],"无锡":[120.30,31.57],
    "南昌":[115.86,28.68],"贵阳":[106.63,26.65],"太原":[112.55,37.87],"石家庄":[114.51,38.04],
    "哈尔滨":[126.53,45.80],"长春":[125.32,43.82],"南宁":[108.37,22.82],"兰州":[103.83,36.06],
    "海口":[110.20,20.04],"三亚":[109.51,18.25],"景德镇":[117.18,29.27],"银川":[106.23,38.49],
    "乌鲁木齐":[87.62,43.83],"呼和浩特":[111.75,40.84],"拉萨":[91.17,29.65],"西宁":[101.78,36.62],
    // —— 港澳台 ——
    "香港":[114.17,22.32],"澳门":[113.54,22.20],"台北":[121.57,25.03],"高雄":[120.30,22.63],"台中":[120.67,24.15],
    // —— 亚洲其他 ——
    "东京":[139.65,35.68],"大阪":[135.50,34.69],"京都":[135.77,35.01],"首尔":[126.98,37.57],
    "新加坡":[103.82,1.35],"曼谷":[100.50,13.76],"吉隆坡":[101.69,3.14],"雅加达":[106.85,-6.21],
    "马尼拉":[120.98,14.60],"河内":[105.85,21.03],"孟买":[72.88,19.08],"新德里":[77.10,28.70],
    "迪拜":[55.27,25.20],"沙迦":[55.40,25.36],"阿布扎比":[54.37,24.45],"多哈":[51.53,25.29],
    "伊斯坦布尔":[28.98,41.01],"特拉维夫":[34.78,32.08],
    // —— 欧洲 ——
    "巴黎":[2.35,48.86],"伦敦":[-0.13,51.51],"柏林":[13.40,52.52],"罗马":[12.50,41.90],
    "米兰":[9.19,45.46],"威尼斯":[12.34,45.44],"马德里":[-3.70,40.42],"巴塞罗那":[2.17,41.39],
    "阿姆斯特丹":[4.90,52.37],"维也纳":[16.37,48.21],"苏黎世":[8.54,47.38],"日内瓦":[6.14,46.20],
    "布鲁塞尔":[4.35,50.85],"慕尼黑":[11.58,48.14],"法兰克福":[8.68,50.11],"哥本哈根":[12.57,55.68],
    "斯德哥尔摩":[18.07,59.33],"奥斯陆":[10.75,59.91],"赫尔辛基":[24.94,60.17],"都柏林":[-6.26,53.35],
    "里斯本":[-9.14,38.72],"雅典":[23.73,37.98],"布拉格":[14.44,50.08],"华沙":[21.01,52.23],
    "布达佩斯":[19.04,47.50],"莫斯科":[37.62,55.76],"威尼斯":[12.34,45.44],
    // —— 北美 ——
    "纽约":[-74.01,40.71],"洛杉矶":[-118.24,34.05],"旧金山":[-122.42,37.77],"芝加哥":[-87.63,41.88],
    "波士顿":[-71.06,42.36],"华盛顿":[-77.04,38.91],"西雅图":[-122.33,47.61],"迈阿密":[-80.19,25.76],
    "多伦多":[-79.35,43.65],"温哥华":[-123.12,49.28],"蒙特利尔":[-73.57,45.50],"墨西哥城":[-99.13,19.43],
    // —— 南美 ——
    "圣保罗":[-46.63,-23.55],"里约热内卢":[-43.17,-22.91],"布宜诺斯艾利斯":[-58.38,-34.60],
    "圣地亚哥":[-70.67,-33.45],"利马":[-77.03,-12.05],"波哥大":[-74.07,4.71],
    // —— 大洋洲 ——
    "悉尼":[151.21,-33.87],"墨尔本":[144.96,-37.81],"奥克兰":[174.76,-36.85],"珀斯":[115.86,-31.95],
    // —— 非洲 ——
    "开罗":[31.24,30.04],"拉各斯":[3.38,6.52],"约翰内斯堡":[28.05,-26.20],"内罗毕":[36.82,-1.29],
    "卡萨布兰卡":[-7.59,33.57],"马拉喀什":[-7.98,31.63],"开普敦":[18.42,-33.92],
    // —— 英文别名(招聘等信源原文是英文城市名时落点用;显示仍用原文) ——
    "New York":[-74.01,40.71],"New York City":[-74.01,40.71],"London":[-0.13,51.51],
    "Los Angeles":[-118.24,34.05],"San Francisco":[-122.42,37.77],"Chicago":[-87.63,41.88],
    "Boston":[-71.06,42.36],"Washington":[-77.04,38.91],"Seattle":[-122.33,47.61],
    "Miami":[-80.19,25.76],"Philadelphia":[-75.17,39.95],"费城":[-75.17,39.95],
    "Pittsburgh":[-79.99,40.44],"匹兹堡":[-79.99,40.44],
    "Paris":[2.35,48.86],"Berlin":[13.40,52.52],"Amsterdam":[4.90,52.37],"Vienna":[16.37,48.21],
    "Zurich":[8.54,47.38],"Geneva":[6.14,46.20],"Tokyo":[139.65,35.68],"Hong Kong":[114.17,22.32],
    "Seoul":[126.98,37.57],"Singapore":[103.82,1.35],"Sydney":[151.21,-33.87],
    "Toronto":[-79.35,43.65],"Vancouver":[-123.12,49.28],"Dubai":[55.27,25.20]
  };
  // 国家名(中文) -> [经度,纬度] 地理中心(城市缺失时兜底落点)
  var COUNTRY = {
    "中国":[104,35.5],"美国":[-98,39],"英国":[-2,54],"法国":[2.4,46.6],"德国":[10.4,51.2],
    "意大利":[12.6,42.8],"西班牙":[-3.7,40.2],"荷兰":[5.3,52.1],"比利时":[4.6,50.6],"瑞士":[8.2,46.8],
    "奥地利":[14.5,47.6],"日本":[138,36.5],"韩国":[127.8,36.5],"新加坡":[103.82,1.35],"泰国":[101,15],
    "印度":[79,22],"阿联酋":[54,24],"加拿大":[-106,56],"澳大利亚":[134,-25],"新西兰":[172,-41],
    "巴西":[-52,-11],"墨西哥":[-102,23.6],"阿根廷":[-64,-35],"俄罗斯":[92,62],"土耳其":[35,39],
    "埃及":[30,27],"南非":[24,-29],"沙特阿拉伯":[45,24],"葡萄牙":[-8,39.5],"希腊":[22,39],
    "爱尔兰":[-8,53.2],"丹麦":[10,56],"瑞典":[15,62],"挪威":[8.5,61],"芬兰":[26,64],
    "波兰":[19,52],"捷克":[15.5,49.8],"匈牙利":[19,47],"卡塔尔":[51.2,25.3],"以色列":[35,31.5],
    "印度尼西亚":[113,-2],"马来西亚":[102,4],"越南":[106,16],"菲律宾":[122,12],"摩洛哥":[-6,32],
    "肯尼亚":[38,0],"尼日利亚":[8,10],
    // —— 英文别名 ——
    "USA":[-98,39],"United States":[-98,39],"United States of America":[-98,39],
    "UK":[-2,54],"United Kingdom":[-2,54],"China":[104,35.5],"Japan":[138,36.5],
    "France":[2.4,46.6],"Germany":[10.4,51.2],"Italy":[12.6,42.8],"Spain":[-3.7,40.2],
    "Netherlands":[5.3,52.1],"Switzerland":[8.2,46.8],"Canada":[-106,56],"Australia":[134,-25],
    "South Korea":[127.8,36.5],"Korea":[127.8,36.5]
  };
  // 地图标注:topojson 英文国名 -> 中文名(主要国家;缺失回退英文)
  var NAME_ZH = {
    "China":"中国","United States of America":"美国","United Kingdom":"英国","France":"法国",
    "Germany":"德国","Italy":"意大利","Spain":"西班牙","Netherlands":"荷兰","Belgium":"比利时",
    "Switzerland":"瑞士","Austria":"奥地利","Japan":"日本","South Korea":"韩国","Singapore":"新加坡",
    "Thailand":"泰国","India":"印度","United Arab Emirates":"阿联酋","Canada":"加拿大",
    "Australia":"澳大利亚","New Zealand":"新西兰","Brazil":"巴西","Mexico":"墨西哥","Argentina":"阿根廷",
    "Russia":"俄罗斯","Turkey":"土耳其","Egypt":"埃及","South Africa":"南非","Saudi Arabia":"沙特阿拉伯",
    "Portugal":"葡萄牙","Greece":"希腊","Ireland":"爱尔兰","Denmark":"丹麦","Sweden":"瑞典",
    "Norway":"挪威","Finland":"芬兰","Poland":"波兰","Czechia":"捷克","Hungary":"匈牙利",
    "Indonesia":"印度尼西亚","Malaysia":"马来西亚","Vietnam":"越南","Philippines":"菲律宾",
    "Morocco":"摩洛哥","Kenya":"肯尼亚","Nigeria":"尼日利亚","Algeria":"阿尔及利亚","Libya":"利比亚",
    "Sudan":"苏丹","Chad":"乍得","Niger":"尼日尔","Mali":"马里","Iran":"伊朗","Iraq":"伊拉克",
    "Saudi Arabia":"沙特阿拉伯","Ukraine":"乌克兰","Kazakhstan":"哈萨克斯坦","Mongolia":"蒙古",
    "Pakistan":"巴基斯坦","Afghanistan":"阿富汗","Myanmar":"缅甸","Colombia":"哥伦比亚","Peru":"秘鲁",
    "Chile":"智利","Venezuela":"委内瑞拉","Ethiopia":"埃塞俄比亚","Tanzania":"坦桑尼亚",
    "Dem. Rep. Congo":"刚果(金)","Angola":"安哥拉","Namibia":"纳米比亚","Botswana":"博茨瓦纳",
    "Zambia":"赞比亚","Mozambique":"莫桑比克","Madagascar":"马达加斯加","Somalia":"索马里",
    "Syria":"叙利亚","Jordan":"约旦","Yemen":"也门","Oman":"阿曼","Israel":"以色列","Iceland":"冰岛"
  };
  // 分类 -> {中文名, 颜色}(机会四类 + 招聘/资讯/作品三频道)
  var CATEGORY = {
    opencall:{zh:"艺术展览征集", color:"#C0392B"},
    residency:{zh:"艺术家驻留", color:"#2E6FA7"},
    award:{zh:"艺术奖金与资助", color:"#C08A1E"},
    workshop:{zh:"策展工坊与研讨", color:"#6B5B95"},
    jobs:{zh:"艺术招聘", color:"#3A7D44"},
    news:{zh:"艺术资讯", color:"#2A7F7A"},
    works:{zh:"艺术家作品", color:"#B0578D"}
  };
  // 资讯无条目级地理字段 -> 按信源(媒体/机构)公开驻地落点,如实标注"信源地"。
  // 键为信源名子串(按插入顺序匹配,中文版在前),值为 CITY 键名或直接 [lng,lat]。
  var SOURCE_LOC = {
    "艺术论坛":"北京","artforum.com.cn":"北京","Artforum":"纽约",
    "Hyperallergic":"纽约","MoMA":"纽约","Sotheby":"纽约","世界新闻网":"纽约","纽约":"纽约","The Latinx Project":"纽约",
    "The Art Newspaper":"伦敦","Tate":"伦敦","BBC":"伦敦","ArtReview":"伦敦",
    "UNESCO":"巴黎","欧洲时报":"巴黎","La Biennale":"威尼斯","Berlin Art Link":"柏林","SWI":[7.45,46.95],
    "新华":"北京","中国新闻网":"北京","中国日报":"北京","新京报":"北京","雅昌":"北京","艺术中国":"北京",
    "中国美术馆":"北京","中央美术学院":"北京","清华大学美术学院":"北京","UCCA":"北京","北京":"北京",
    "中国国家博物馆":"北京","空白空间":"北京","唐人":"北京",
    "澎湃":"上海","上观":"上海","联合早报":"新加坡",
    "香港":"香港","info.gov.hk":"香港","ArtAsiaPacific":"香港",
    "國立臺灣美術館":"台中","臺南市美術館":[120.20,23.00],"新竹":[120.97,24.80],
    "藝術家雜誌社":"台北","報導者":"台北",
    "Ota Fine Arts":"东京","Whitestone":"东京","San-x":"东京","大地藝術祭":[138.76,37.13],
    "江西日报":"南昌","景德镇陶瓷大学":"景德镇","悉尼":"悉尼",
    "Kurimanzutto":"墨西哥城","Southeastern Louisiana":[-90.46,30.50],
    "MassArt":"波士顿","Massachusetts College":"波士顿","Museum of Contemporary Art Arlington":[-77.09,38.88]
  };
  // 远景分层地名:缩到最小显大洲,稍放大显次区域(光标在这两层隐藏)
  var REGIONS = {
    continents: [
      {ll:[90,48], zh:"亚洲", en:"Asia"}, {ll:[20,52], zh:"欧洲", en:"Europe"},
      {ll:[18,4], zh:"非洲", en:"Africa"}, {ll:[-100,48], zh:"北美洲", en:"North America"},
      {ll:[-60,-14], zh:"南美洲", en:"South America"}, {ll:[140,-26], zh:"大洋洲", en:"Oceania"}
    ],
    subregions: [
      {ll:[108,36], zh:"东亚", en:"East Asia"}, {ll:[108,8], zh:"东南亚", en:"Southeast Asia"},
      {ll:[77,21], zh:"南亚", en:"South Asia"}, {ll:[64,44], zh:"中亚", en:"Central Asia"},
      {ll:[45,31], zh:"西亚", en:"West Asia"}, {ll:[100,63], zh:"西伯利亚", en:"Siberia"},
      {ll:[2,47], zh:"西欧", en:"Western Europe"}, {ll:[17,63], zh:"北欧", en:"Northern Europe"},
      {ll:[14,41], zh:"南欧", en:"Southern Europe"}, {ll:[31,53], zh:"东欧", en:"Eastern Europe"},
      {ll:[13,26], zh:"北非", en:"North Africa"}, {ll:[-4,12], zh:"西非", en:"West Africa"},
      {ll:[20,1], zh:"中非", en:"Central Africa"}, {ll:[38,3], zh:"东非", en:"East Africa"},
      {ll:[24,-26], zh:"南部非洲", en:"Southern Africa"}, {ll:[-100,45], zh:"北美", en:"North America"},
      {ll:[-90,16], zh:"中美洲", en:"Central America"}, {ll:[-60,-14], zh:"南美", en:"South America"},
      {ll:[140,-26], zh:"大洋洲", en:"Oceania"}
    ]
  };
  // ===== 艺术门类标签(v0.66 体系原样移植):程序关键词匹配真实字段,可审计不编造 =====
  // 中文高区分度词包含匹配;英文词边界整词匹配;作品优先作者自选标签
  var TAGS = [
    { id:"painting", h:8, zh:"绘画", en:"Painting",
      k:["绘画","油画","水彩","丙烯","坦培拉","壁画","岩彩","架上"],
      e:["painting","painter","watercolor","watercolour","acrylic","mural"] },
    { id:"ink", h:230, zh:"水墨/书法", en:"Ink & Calligraphy",
      k:["水墨","国画","中国画","书法","篆刻","工笔","写意","书画"],
      e:["ink painting","ink art","calligraphy"] },
    { id:"printmaking", h:28, zh:"版画", en:"Printmaking",
      k:["版画","丝网印","铜版","木刻","石版","藏书票"],
      e:["printmaking","etching","lithography","lithograph","woodcut","silkscreen","screen print","linocut"] },
    { id:"illustration", h:340, zh:"插画/漫画", en:"Illustration",
      k:["插画","绘本","漫画","连环画","插图"],
      e:["illustration","illustrator","comic","comics","manga","picture book"] },
    { id:"photography", h:205, zh:"摄影", en:"Photography",
      k:["摄影"],
      e:["photography","photographer","photographic","photobook","photo book"] },
    { id:"sculpture", h:150, zh:"雕塑", en:"Sculpture",
      k:["雕塑","雕刻"], e:["sculpture","sculptor","carving"] },
    { id:"installation", h:270, zh:"装置", en:"Installation",
      k:["装置"], e:["installation"] },
    { id:"video", h:245, zh:"影像/电影", en:"Film & Video",
      k:["影像","录像","电影","短片","纪录片","影片"],
      e:["video","film","cinema","moving image","documentary","filmmaker"] },
    { id:"animation", h:38, zh:"动画", en:"Animation",
      k:["动画","动漫"], e:["animation","animator","anime"] },
    { id:"newmedia", h:190, zh:"新媒体/数字", en:"New Media & Digital",
      k:["新媒体","数字艺术","数码艺术","生成艺术","交互艺术","虚拟现实","增强现实","人工智能","电子艺术","科技艺术","游戏艺术"],
      e:["new media","digital art","generative","interactive art","net art","virtual reality","augmented reality","ai art","creative coding","game art"] },
    { id:"sound", h:165, zh:"声音/音乐", en:"Sound & Music",
      k:["声音艺术","声音","音乐","作曲","乐团","乐队","唱片","声响"],
      e:["sound art","sound","music","composer","composition","musician","audio"] },
    { id:"performance", h:335, zh:"行为艺术", en:"Performance Art",
      k:["行为艺术","现场艺术"], e:["performance art","live art"] },
    { id:"theater", h:295, zh:"舞蹈/戏剧", en:"Dance & Theatre",
      k:["舞蹈","戏剧","剧场","戏曲","舞台","编舞","话剧","音乐剧","木偶","舞者"],
      e:["dance","dancer","theatre","theater","choreograph","choreographer","performing arts","opera","puppet"] },
    { id:"literature", h:52, zh:"写作/文学", en:"Writing & Literature",
      k:["写作","文学","诗歌","小说","散文","剧本","征文","诗人","作家","翻译"],
      e:["writing","writer","literature","literary","poetry","poet","fiction","essay","screenwriting","novel"] },
    { id:"design", h:215, zh:"设计", en:"Design",
      k:["设计"], e:["design","designer","graphic"] },
    { id:"fashion", h:315, zh:"时尚/服饰", en:"Fashion",
      k:["时尚","服装","服饰","时装","穿戴"], e:["fashion","costume","apparel","wearable"] },
    { id:"architecture", h:200, zh:"建筑/空间", en:"Architecture & Space",
      k:["建筑","景观","城市设计","空间设计","人居","乡建"],
      e:["architecture","architect","urban design","landscape","spatial design"] },
    { id:"ceramics", h:18, zh:"陶瓷", en:"Ceramics",
      k:["陶瓷","陶艺","陶器","瓷器","青瓷","白瓷","柴烧","紫砂"],
      e:["ceramic","ceramics","pottery","porcelain","clay"] },
    { id:"glass", h:178, zh:"玻璃", en:"Glass",
      k:["玻璃","琉璃"], e:["glass","glassblowing","stained glass"] },
    { id:"textile", h:95, zh:"纤维/织物", en:"Textile & Fiber",
      k:["纤维","织物","编织","刺绣","染织","缂丝","地毯","毛毡","织造"],
      e:["textile","fiber art","fibre art","weaving","embroidery","tapestry","felt"] },
    { id:"craft", h:42, zh:"工艺", en:"Craft",
      k:["工艺","手作","手工","漆艺","大漆","木作","金工","首饰","珠宝","竹编","民艺","非遗"],
      e:["craft","jewelry","jewellery","lacquer","woodworking","metalwork","artisan"] },
    { id:"curation", h:258, zh:"策展/研究", en:"Curation & Research",
      k:["策展","研究","艺术史","理论","批评","学术","档案","艺术管理","评论"],
      e:["curator","curatorial","art history","research","criticism","critic","archive","scholar"] },
    { id:"mixed", h:280, zh:"跨媒介/综合", en:"Interdisciplinary",
      k:["跨媒介","跨学科","综合材料","多媒介","实验艺术","社会参与","公共艺术","不限","所有媒介","各类媒介","任何媒介","媒介不限","多学科","所有艺术"],
      e:["interdisciplinary","multidisciplinary","mixed media","cross-media","all media","any medium","open to all","social practice","public art"] }
  ];
  for(var ti=0;ti<TAGS.length;ti++){
    TAGS[ti].re=new RegExp("\\b(?:"+TAGS[ti].e.join("|").replace(/ /g,"[ -]")+")\\b","i");
  }
  var TAG_IDS={};
  TAGS.forEach(function(t){ TAG_IDS[t.id]=t; });
  function tagTextOf(o){
    var c=o.category;
    if(c==='jobs') return [o.title,o.title_zh,o.title_en,o.org,o.org_zh,o.summary,o.summary_zh,o.summary_en].filter(Boolean).join(" ");
    if(c==='news') return [o.title,o.title_zh,o.title_en,o.summary,o.summary_zh,o.summary_en,o.topic].filter(Boolean).join(" ");
    if(c==='works') return [o.title_zh,o.summary_zh].filter(Boolean).join(" ");
    return [(o.disciplines||[]).join(" "),o.title_zh,o.title_en,o.summary_zh,o.eligibility&&o.eligibility.nationality].filter(Boolean).join(" ");
  }
  function tagsOf(o){
    if(o.category==='works'&&Array.isArray(o.tags)&&o.tags.length){
      return o.tags.filter(function(id){ return TAG_IDS[id]; });
    }
    if(o._aptags) return o._aptags;
    var text=tagTextOf(o), lower=text.toLowerCase(), hits=[];
    for(var i=0;i<TAGS.length;i++){
      var t=TAGS[i], hit=false;
      for(var j=0;j<t.k.length;j++){ if(text.indexOf(t.k[j])!==-1){ hit=true; break; } }
      if(!hit&&t.re.test(lower)) hit=true;
      if(hit) hits.push(t.id);
    }
    o._aptags=hits;
    return hits;
  }
  // 省(短名)-> 省会城市(IP 属地落点用:属地只到省级时按省会坐标,如实标注"IP属地")
  var PROV_CAP = {
    "北京":"北京","天津":"天津","河北":"石家庄","山西":"太原","内蒙古":"呼和浩特","辽宁":"沈阳",
    "吉林":"长春","黑龙江":"哈尔滨","上海":"上海","江苏":"南京","浙江":"杭州","安徽":"合肥",
    "福建":"福州","江西":"南昌","山东":"济南","河南":"郑州","湖北":"武汉","湖南":"长沙",
    "广东":"广州","广西":"南宁","海南":"海口","重庆":"重庆","四川":"成都","贵州":"贵阳",
    "云南":"昆明","西藏":"拉萨","陕西":"西安","甘肃":"兰州","青海":"西宁","宁夏":"银川",
    "新疆":"乌鲁木齐","台湾":"台北","香港":"香港","澳门":"澳门"
  };
  window.GLOBE_DATA = { CITY:CITY, COUNTRY:COUNTRY, NAME_ZH:NAME_ZH, CATEGORY:CATEGORY, REGIONS:REGIONS,
    TAGS:TAGS, tagsOf:tagsOf,
    // 条目 -> [lng,lat]:优先城市,其次国家中心;资讯再兜底信源驻地;都无则 null(不落点,绝不编造)
    locate:function(o){
      var c = o.city_zh && CITY[o.city_zh];
      if(c) return {ll:c, prec:"城市"};
      var k = o.country_zh && COUNTRY[o.country_zh];
      if(k) return {ll:k, prec:"国家"};
      if(o.category==='news' && o.source){ var s=String(o.source);
        for(var key in SOURCE_LOC){ if(s.indexOf(key)>=0){
          var v=SOURCE_LOC[key], ll=(typeof v==='string')?CITY[v]:v;
          if(ll) return {ll:ll, prec:"信源地"}; } } }
      // 作品/用户发布:按 IP 属地落点(境内省会/城市,境外国家中心),如实标注
      if(o.ip_region){ var r2=o.ip_region, ll2=null;
        if(r2.country==="中国") ll2=CITY[r2.city]||CITY[PROV_CAP[r2.province]]||COUNTRY["中国"];
        else ll2=COUNTRY[r2.country]||null;
        if(ll2) return {ll:ll2, prec:"IP属地"}; }
      return null;
    }
  };
})();
