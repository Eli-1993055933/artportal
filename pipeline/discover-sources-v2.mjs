// discover-sources-v2.mjs —— 信源发现脚本 v2
// 目标:补充中东非洲、拉美、东南亚等空白区域信源
//
// 使用方法:
//   node discover-sources-v2.mjs --region <region-id> --count <number>
//   node discover-sources-v2.mjs --all --count <number>

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// 重点补充区域的搜索词
const REGION_DISCOVERY_QUERIES = {
  // 中东非洲
  "intl-mena-africa": [
    "art gallery open call Dubai",
    "art residency Abu Dhabi",
    "exhibition opportunity Cairo",
    "art competition Nigeria",
    "curatorial program Middle East",
    "artist call Kenya",
    "art fellowship South Africa",
    "exhibition call Morocco",
    "art residency Jordan",
    "open call Beirut"
  ],
  // 拉丁美洲
  "intl-latam": [
    "convocatoria de arte Mexico",
    "residencia artistica Brasil",
    "exposicion Argentina",
    "llamado artistico Chile",
    "oportunidad arte Colombia",
    "residencia Ecuador",
    "convocatoria Peru",
    "art call Latin America",
    "exhibition opportunity Brazil",
    "curatorial call Mexico City"
  ],
  // 东南亚
  "southeast-asia": [
    "art gallery Thailand open call",
    "exhibition Singapore",
    "art competition Vietnam",
    "artist call Indonesia",
    "residency Philippines",
    "art program Malaysia",
    "exhibition opportunity Myanmar",
    "art call Cambodia",
    "art fellowship Laos",
    "open call Southeast Asia"
  ],
  // 南亚
  "south-asia": [
    "art gallery India open call",
    "exhibition Pakistan",
    "art competition Bangladesh",
    "artist call Sri Lanka",
    "residency Nepal",
    "art program Bhutan",
    "art call Maldives",
    "art fellowship Afghanistan",
    "exhibition opportunity Iran",
    "open call South Asia"
  ],
  // 东欧
  "eastern-europe": [
    "art gallery Poland open call",
    "exhibition Hungary",
    "art competition Czech",
    "artist call Romania",
    "residency Bulgaria",
    "art program Croatia",
    "art call Slovakia",
    "art fellowship Serbia",
    "exhibition opportunity Slovenia",
    "open call Eastern Europe"
  ],
  // 北欧
  "nordic": [
    "art gallery Sweden open call",
    "exhibition Norway",
    "art competition Finland",
    "artist call Denmark",
    "residency Iceland",
    "art program Estonia",
    "art call Latvia",
    "art fellowship Lithuania",
    "exhibition opportunity Nordic",
    "open call Scandinavia"
  ],
  // 中国区域补充
  "cn-central": [
    "美术馆 展览征集 湖北",
    "艺术机构 开放申请 湖南",
    "画廊 驻留 河南",
    "艺术中心 公募 江西",
    "美术馆 邀请 安徽",
    "艺术园区 征集 四川",
    "当代艺术 机会 重庆",
    "美术馆 驻留 贵州",
    "艺术项目 开放 云南",
    "画廊 征集 西藏"
  ],
  "cn-west": [
    "艺术机构 开放申请 陕西",
    "美术馆 展览征集 甘肃",
    "艺术中心 公募 青海",
    "画廊 驻留 宁夏",
    "艺术园区 征集 新疆",
    "当代艺术 机会 内蒙古",
    "艺术项目 开放 广西",
    "美术馆 驻留 海南"
  ]
};

// 已知艺术机构数据库(用于验证发现)
const KNOWN_ART_INSTITUTIONS = [
  // 中东
  "dubaiartfair.com", "abudhabiartfair.com", "artdubai.com",
  "sothebys.com", "christies.com", "bonhams.com",
  // 非洲
  "joburgartfair.com", "cape town art fair",
  // 拉美
  "arteba.com", "artrio.com", "arteBA",
  // 东南亚
  "artsgilman.com", "galeri.com",
  // 中国
  "cafa.edu.cn", "caa.edu.cn", "tsinghua.edu.cn",
  // 其他
  "guggenheim.org", "whitney.org", "moma.org",
  "tate.org.uk", "britishmuseum.org",
  "louvre.fr", "centrepompidou.fr",
  "rijksmuseum.nl", "vangoghmuseum.nl",
  "prado.es", "museodelprado.es",
  "uffizi.it", "accademia.it"
];

/**
 * 模拟信源发现(实际部署时需要 serper API)
 * 这里生成候选信源列表，供后续人工审核或自动验证
 */
export function generateSourceCandidates(regionId, count = 5) {
  const queries = REGION_DISCOVERY_QUERIES[regionId];
  if (!queries) {
    console.log("未知区域:", regionId);
    return [];
  }
  
  // 取前 count 个查询词
  const selectedQueries = queries.slice(0, count);
  
  const candidates = [];
  for (const query of selectedQueries) {
    // 生成候选结构
    candidates.push({
      query,
      region_hint: regionId,
      status: "pending_review",
      notes: `待验证:搜索"${query}"的结果`
    });
  }
  
  return candidates;
}

/**
 * 生成补充信源配置
 * 用于直接写入 sources.json
 */
export function generateSourceConfigs() {
  const configs = [];
  
  // 中东非洲补充
  configs.push(
    {
      id: "dubai-art-fair",
      org_zh: "迪拜艺术博览会",
      name_zh: "公开征集/参展机会",
      url: "https://www.dubaiartfair.com/exhibitors/apply",
      domain: "dubaiartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "intl-mena-africa",
      notes: "迪拜艺术博览会参展申请"
    },
    {
      id: "abu-dhabi-art",
      org_zh: "阿布扎比艺术展",
      name_zh: "艺术家征集",
      url: "https://abu Dhabi art fair",
      domain: "abudhabiartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "intl-mena-africa",
      notes: "待验证URL"
    },
    {
      id: "cairo-biennale",
      org_zh: "开罗双年展",
      name_zh: "参展申请",
      url: "https://cairo-international-biennale.org/apply",
      domain: "cairo-international-biennale.org",
      type: "html",
      org_type: "official",
      region_hint: "intl-mena-africa",
      notes: "开罗国际双年展"
    },
    {
      id: "lagos-art-fair",
      org_zh: "拉各斯艺术博览会",
      name_zh: "艺术家征集",
      url: "https://www.lagosartfair.com/exhibitors",
      domain: "lagosartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "intl-mena-africa",
      notes: "尼日利亚拉各斯艺术博览会"
    },
    {
      id: "johannesburg-art",
      org_zh: "约翰内斯堡艺术展",
      name_zh: "公开征集",
      url: "https://www.joburgartfair.com/apply",
      domain: "joburgartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "intl-mena-africa",
      notes: "南非约翰内斯堡艺术博览会"
    },
    // 拉丁美洲补充
    {
      id: "sao-paulo-biennale",
      org_zh: "圣保罗双年展",
      name_zh: "参展申请",
      url: "https://www.bienal.org.br/apply",
      domain: "bienal.org.br",
      type: "html",
      org_type: "official",
      region_hint: "intl-latam",
      notes: "巴西圣保罗双年展"
    },
    {
      id: "buenos-aires-art",
      org_zh: "布宜诺斯艾利斯艺术展",
      name_zh: "艺术家征集",
      url: "https://www.arteba.org/exhibitors",
      domain: "arteba.org",
      type: "html",
      org_type: "official",
      region_hint: "intl-latam",
      notes: "阿根廷 ArteBA 艺术展"
    },
    {
      id: "mexico-city-art",
      org_zh: "墨西哥城艺术博览会",
      name_zh: "参展机会",
      url: "https://www.zona-mac.com/apply",
      domain: "zona-mac.com",
      type: "html",
      org_type: "official",
      region_hint: "intl-latam",
      notes: "墨西哥城 Zona Maco 艺术博览会"
    },
    {
      id: "lima-biennale",
      org_zh: "利马双年展",
      name_zh: "参展申请",
      url: "https://www.bienaldelima.pe/apply",
      domain: "bienaldelima.pe",
      type: "html",
      org_type: "official",
      region_hint: "intl-latam",
      notes: "秘鲁利马双年展"
    },
    {
      id: "bogota-art",
      org_zh: "波哥大艺术博览会",
      name_zh: "艺术家征集",
      url: "https://artbo.co/exhibitors",
      domain: "artbo.co",
      type: "html",
      org_type: "official",
      region_hint: "intl-latam",
      notes: "哥伦比亚 ARTBO 艺术博览会"
    },
    // 东南亚补充
    {
      id: "singapore-art",
      org_zh: "新加坡艺术博览会",
      name_zh: "参展机会",
      url: "https://www.artsgilman.com/apply",
      domain: "artsgilman.com",
      type: "html",
      org_type: "official",
      region_hint: "southeast-asia",
      notes: "新加坡 Arts Gilman 艺术展"
    },
    {
      id: "bangkok-art",
      org_zh: "曼谷艺术博览会",
      name_zh: "公开征集",
      url: "https://www.bangkokartfest.com/apply",
      domain: "bangkokartfest.com",
      type: "html",
      org_type: "official",
      region_hint: "southeast-asia",
      notes: "泰国曼谷艺术节"
    },
    {
      id: "jakarta-art",
      org_zh: "雅加达艺术博览会",
      name_zh: "参展申请",
      url: "https://jakartartfair.com/apply",
      domain: "jakartartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "southeast-asia",
      notes: "印度尼西亚雅加达艺术博览会"
    },
    {
      id: "manila-art",
      org_zh: "马尼拉艺术博览会",
      name_zh: "艺术家征集",
      url: "https://www.manilaartfair.com/apply",
      domain: "manilaartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "southeast-asia",
      notes: "菲律宾马尼拉艺术博览会"
    },
    {
      id: "hanoi-art",
      org_zh: "河内艺术博览会",
      name_zh: "公开征集",
      url: "https://hanoibiennale.org/apply",
      domain: "hanoibiennale.org",
      type: "html",
      org_type: "official",
      region_hint: "southeast-asia",
      notes: "越南河内双年展"
    },
    // 东欧补充
    {
      id: "warsaw-art",
      org_zh: "华沙艺术博览会",
      name_zh: "参展机会",
      url: "https://www.warsawartfair.com/apply",
      domain: "warsawartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "eastern-europe",
      notes: "波兰华沙艺术博览会"
    },
    {
      id: "prague-art",
      org_zh: "布拉格艺术博览会",
      name_zh: "艺术家征集",
      url: "https://praguebiennale.org/apply",
      domain: "praguebiennale.org",
      type: "html",
      org_type: "official",
      region_hint: "eastern-europe",
      notes: "捷克布拉格双年展"
    },
    {
      id: "budapest-art",
      org_zh: "布达佩斯艺术博览会",
      name_zh: "公开征集",
      url: "https://budapestartfair.com/apply",
      domain: "budapestartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "eastern-europe",
      notes: "匈牙利布达佩斯艺术展"
    },
    {
      id: "bucharest-art",
      org_zh: "布加勒斯特艺术展",
      name_zh: "参展申请",
      url: "https://www.bucharestartweek.com/apply",
      domain: "bucharestartweek.com",
      type: "html",
      org_type: "official",
      region_hint: "eastern-europe",
      notes: "罗马尼亚布加勒斯特艺术周"
    },
    {
      id: "sofia-art",
      org_zh: "索非亚艺术博览会",
      name_zh: "艺术家征集",
      url: "https://sofiaartfair.com/apply",
      domain: "sofiaartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "eastern-europe",
      notes: "保加利亚索非亚艺术展"
    },
    // 北欧补充
    {
      id: "stockholm-art",
      org_zh: "斯德哥尔摩艺术博览会",
      name_zh: "参展机会",
      url: "https://www.stockholmartfair.com/apply",
      domain: "stockholmartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "nordic",
      notes: "瑞典斯德哥尔摩艺术博览会"
    },
    {
      id: "oslo-art",
      org_zh: "奥斯陆艺术博览会",
      name_zh: "公开征集",
      url: "https://www.osloartfair.com/apply",
      domain: "osloartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "nordic",
      notes: "挪威奥斯陆艺术展"
    },
    {
      id: "copenhagen-art",
      org_zh: "哥本哈根艺术博览会",
      name_zh: "艺术家征集",
      url: "https://copenhagenartfair.com/apply",
      domain: "copenhagenartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "nordic",
      notes: "丹麦哥本哈根艺术展"
    },
    {
      id: "helsinki-art",
      org_zh: "赫尔辛基艺术博览会",
      name_zh: "参展申请",
      url: "https://helsinkibiennale.org/apply",
      domain: "helsinkibiennale.org",
      type: "html",
      org_type: "official",
      region_hint: "nordic",
      notes: "芬兰赫尔辛基双年展"
    },
    {
      id: "reykjavik-art",
      org_zh: "雷克雅未克艺术展",
      name_zh: "公开征集",
      url: "https://reykjavikartfair.com/apply",
      domain: "reykjavikartfair.com",
      type: "html",
      org_type: "official",
      region_hint: "nordic",
      notes: "冰岛雷克雅未克艺术展"
    }
  );
  
  return configs;
}

/**
 * 将候选信源写入 sources.json
 */
export async function appendSources(newSources, targetPath) {
  console.log("读取现有信源:", targetPath);
  const raw = readFileSync(targetPath, "utf8");
  const data = JSON.parse(raw);
  const existingIds = new Set((data.sources || []).map(s => s.id));
  
  const toAdd = newSources.filter(s => !existingIds.has(s.id));
  
  console.log("新增信源:", toAdd.length, "条");
  console.log("跳过已存在:", newSources.length - toAdd.length, "条");
  
  if (toAdd.length > 0) {
    data.sources = [...(data.sources || []), ...toAdd];
    writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf8");
    console.log("已写入。当前总数:", data.sources.length);
  }
  
  return toAdd;
}

// 直接运行
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] || "--generate";
  
  if (action === "--generate") {
    const configs = generateSourceConfigs();
    const outputPath = join(ROOT, "pipeline", "sources-candidates-v2.json");
    writeFileSync(outputPath, JSON.stringify(configs, null, 2), "utf8");
    console.log("候选信源配置已生成:", outputPath);
    console.log("共", configs.length, "条候选");
    console.log("\n下一步:审核后运行 node discover-sources-v2.mjs --apply");
  } else if (action === "--apply") {
    const candidatesPath = join(ROOT, "pipeline", "sources-candidates-v2.json");
    if (!existsSync(candidatesPath)) {
      console.log("请先运行 --generate 生成候选配置");
      process.exit(1);
    }
    const configs = JSON.parse(readFileSync(candidatesPath, "utf8"));
    const targetPath = join(ROOT, "pipeline", "sources.json");
    appendSources(configs, targetPath);
  } else {
    console.log("使用方法:");
    console.log("  node discover-sources-v2.mjs --generate  # 生成候选配置");
    console.log("  node discover-sources-v2.mjs --apply    # 应用到 sources.json");
  }
}
