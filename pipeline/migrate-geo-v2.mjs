#!/usr/bin/env node
// migrate-geo-v2.mjs —— 地理信息二次补全迁移脚本
//
// 使用方法: node pipeline/migrate-geo-v2.mjs [--apply|--dry]

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fillGeoFallbackV2 } from "./lib/geolocation-fallback-v2.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

const DRY_RUN = process.argv.includes("--dry");
const APPLY = process.argv.includes("--apply");

async function main() {
  const dataPath = join(ROOT, "site", "data", "opportunities.json");
  
  console.log("读取数据:", dataPath);
  const raw = readFileSync(dataPath, "utf8");
  const data = JSON.parse(raw);
  const items = data.opportunities || data.items || [];
  
  console.log("总条目:", items.length);
  
  let improvedCity = 0;
  let improvedCountry = 0;
  let onlineDetected = 0;
  let orgKeywordHit = 0;
  let domainPatternHit = 0;
  let capitalInferHit = 0;
  
  const stats = {
    beforeNoCity: 0,
    beforeNoCountry: 0,
    afterNoCity: 0,
    afterNoCountry: 0,
    byMethod: {}
  };
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const beforeCity = item.city_zh;
    const beforeCountry = item.country_zh;
    
    // 统计之前状态
    if (!beforeCity || beforeCity === "未知") stats.beforeNoCity++;
    if (!beforeCountry || beforeCountry === "未知") stats.beforeNoCountry++;
    
    // 构造上下文
    const ctx = {};
    if (item.url) {
      try {
        ctx.domain = new URL(item.url).hostname;
      } catch (e) {}
    }
    
    // 应用二次补全
    const result = fillGeoFallbackV2(item, ctx, item.summary_zh || item.summary || "");
    
    // 统计改善
    const cityImproved = (!beforeCity || beforeCity === "未知") && 
                          result.city_zh && result.city_zh !== "未知";
    const countryImproved = (!beforeCountry || beforeCountry === "未知") && 
                             result.country_zh && result.country_zh !== "未知";
    
    if (cityImproved) {
      improvedCity++;
      stats.byMethod[result.geo_fallback] = (stats.byMethod[result.geo_fallback] || 0) + 1;
      
      if (result.geo_fallback === "v2_online") onlineDetected++;
      else if (result.geo_fallback === "v2_org_keyword") orgKeywordHit++;
      else if (result.geo_fallback === "v2_domain_pattern") domainPatternHit++;
      else if (result.geo_fallback === "v2_capital_infer") capitalInferHit++;
    }
    if (countryImproved) improvedCountry++;
    
    // 应用变更
    if (!DRY_RUN && (cityImproved || countryImproved)) {
      if (result.city_zh) items[i].city_zh = result.city_zh;
      if (result.country_zh) items[i].country_zh = result.country_zh;
      items[i].geo_fallback = result.geo_fallback;
    }
  }
  
  // 统计之后状态
  for (const item of items) {
    if (!item.city_zh || item.city_zh === "未知") stats.afterNoCity++;
    if (!item.country_zh || item.country_zh === "未知") stats.afterNoCountry++;
  }
  
  console.log("\n=== 二次补全统计 ===");
  console.log("模式:", DRY_RUN ? "试运行(不写回)" : "应用变更");
  console.log("");
  console.log("城市:");
  console.log("  之前缺失:", stats.beforeNoCity, "(" + (stats.beforeNoCity / items.length * 100).toFixed(1) + "%)");
  console.log("  改善数量:", improvedCity);
  console.log("  之后缺失:", stats.afterNoCity, "(" + (stats.afterNoCity / items.length * 100).toFixed(1) + "%)");
  console.log("");
  console.log("国家:");
  console.log("  之前缺失:", stats.beforeNoCountry, "(" + (stats.beforeNoCountry / items.length * 100).toFixed(1) + "%)");
  console.log("  改善数量:", improvedCountry);
  console.log("  之后缺失:", stats.afterNoCountry, "(" + (stats.afterNoCountry / items.length * 100).toFixed(1) + "%)");
  console.log("");
  console.log("改善方法分布:");
  console.log("  - 线上事件检测:", onlineDetected);
  console.log("  - 机构关键词匹配:", orgKeywordHit);
  console.log("  - 域名特征匹配:", domainPatternHit);
  console.log("  - 首都推断:", capitalInferHit);
  console.log("  - 其他:", Object.entries(stats.byMethod).filter(([k]) => 
    !["v2_online", "v2_org_keyword", "v2_domain_pattern", "v2_capital_infer"].includes(k)
  ).map(([k, v]) => `${k}: ${v}`).join(", ") || "0");
  
  if (!DRY_RUN) {
    // 备份原文件
    const backupPath = dataPath + ".bak-v2-" + Date.now();
    copyFileSync(dataPath, backupPath);
    console.log("\n备份已创建:", backupPath);
    
    // 写回
    data.opportunities = items;
    writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
    console.log("已写回:", dataPath);
  } else {
    console.log("\n试运行完成。运行 --apply 应用变更。");
  }
}

main().catch(console.error);
