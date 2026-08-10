#!/usr/bin/env node
// migrate-geo.mjs —— 地理信息回填脚本(v1.8.0)
//
// 功能:
//   1. 对现有 opportunities.json 的所有记录执行地理信息兜底
//   2. 统一国家名(美国/United States/USA -> 美国)
//   3. 输出变更统计报告
//
// 用法:
//   cd pipeline && node migrate-geo.mjs          # 执行迁移
//   cd pipeline && node migrate-geo.mjs --dry    # 仅预览变更,不写盘

import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fillGeoFallback } from "./lib/geolocation-fallback.mjs";
import { normalizeCountry } from "./lib/country-normalize.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const DATA_PATH = join(ROOT, "site", "data", "opportunities.json");

const isDryRun = process.argv.includes("--dry");

async function main() {
  console.log("=".repeat(60));
  console.log("ArtPortal 地理信息回填脚本 v1.8.0");
  console.log(isDryRun ? "模式: DRY RUN (预览,不写盘)" : "模式: 执行写入");
  console.log("=".repeat(60));

  // 读取现有数据
  console.log("\n📖 读取数据...");
  const raw = await readFile(DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  const items = data.opportunities || [];
  console.log(`  共 ${items.length} 条记录`);

  // 统计变量
  let cityFilled = 0;       // 城市被兜底填充的数量
  let countryFilled = 0;   // 国家被兜底填充的数量
  let countryNormalized = 0; // 国家名被标准化的数量
  let bothFilled = 0;       // 城市+国家都被填充的数量
  const fallbackSources = {}; // 各兜底来源的计数

  // 处理每条记录
  console.log("\n🔄 处理记录...");
  const updated = items.map((item, idx) => {
    if (idx % 100 === 0 && idx > 0) {
      process.stderr.write(`  进度: ${idx}/${items.length}\r`);
    }

    const originalCity = item.city_zh;
    const originalCountry = item.country_zh;

    // Step 1: 国家名标准化(先标准化,再兜底)
    if (originalCountry && originalCountry !== "未知") {
      const normalized = normalizeCountry(originalCountry);
      if (normalized !== originalCountry) {
        item.country_zh = normalized;
        countryNormalized++;
      }
    }

    // Step 2: 地理信息兜底
    const needsGeo = !item.city_zh || item.city_zh === "未知" || !item.country_zh || item.country_zh === "未知";
    if (needsGeo) {
      const sourceText = [
        item.title_zh || "",
        item.title_en || "",
        item.org_zh || "",
        item.org_en || "",
        item.summary_zh || ""
      ].join(" ");

      const ctx = {
        domain: item.domain || "",
        source_url: item.url || item.source_url || ""
      };

      const result = fillGeoFallback(item, ctx, sourceText);

      if (result.geo_fallback !== "ai") {
        if (result.geo_fallback !== "unknown") {
          if (fallbackSources[result.geo_fallback]) {
            fallbackSources[result.geo_fallback]++;
          } else {
            fallbackSources[result.geo_fallback] = 1;
          }
        }

        let cityChanged = false;
        let countryChanged = false;

        if ((!item.city_zh || item.city_zh === "未知") && result.city_zh) {
          item.city_zh = result.city_zh;
          cityChanged = true;
        }
        if ((!item.country_zh || item.country_zh === "未知") && result.country_zh) {
          item.country_zh = result.country_zh;
          countryChanged = true;
        }

        if (cityChanged) cityFilled++;
        if (countryChanged) countryFilled++;
        if (cityChanged && countryChanged) bothFilled++;
      }
    }

    return item;
  });

  process.stderr.write("\n");

  // 生成报告
  console.log("\n📊 变更报告:");
  console.log("-".repeat(40));
  console.log(`  总记录数:           ${items.length}`);
  console.log(`  城市被兜底填充:     ${cityFilled} 条`);
  console.log(`  国家被兜底填充:     ${countryFilled} 条`);
  console.log(`  城市+国家都被填充:  ${bothFilled} 条`);
  console.log(`  国家名被标准化:     ${countryNormalized} 条`);
  console.log("-".repeat(40));
  console.log("\n  兜底来源分布:");
  for (const [source, count] of Object.entries(fallbackSources)) {
    const labels = {
      text_match: "原文正则匹配",
      domain_infer: "域名推断",
      region_context: "区域上下文",
      country_infer: "国家反推城市",
      unknown: "标记为未知"
    };
    console.log(`    ${labels[source] || source}: ${count} 条`);
  }

  // 填充后统计
  const afterCityNull = updated.filter(i => !i.city_zh || i.city_zh === "未知").length;
  const afterCountryNull = updated.filter(i => !i.country_zh || i.country_zh === "未知").length;
  console.log("\n📈 填充后状态:");
  console.log(`  城市仍为"未知":     ${afterCityNull} 条 (${((afterCityNull / items.length) * 100).toFixed(1)}%)`);
  console.log(`  国家仍为"未知":     ${afterCountryNull} 条 (${((afterCountryNull / items.length) * 100).toFixed(1)}%)`);

  // 写入
  if (!isDryRun) {
    console.log("\n💾 写入文件...");
    const output = {
      ...data,
      _meta: {
        ...(data._meta || {}),
        geo_migrated_at: new Date().toISOString(),
        geo_migration_version: "v1.8.0",
        geo_stats: { cityFilled, countryFilled, countryNormalized, afterCityNull, afterCountryNull }
      },
      opportunities: updated
    };

    const tmpPath = DATA_PATH + ".tmp-" + process.pid;
    await writeFile(tmpPath, JSON.stringify(output, null, 2), "utf8");
    // 原子写入
    const { rename } = await import("node:fs/promises");
    await rename(tmpPath, DATA_PATH);

    console.log("✅ 迁移完成!");
    console.log(`\n建议: 启动服务验证: cd pipeline && node server.mjs`);
  } else {
    console.log("\n🔍 DRY RUN 完成,未写入任何文件。");
    console.log("确认无误后,去掉 --dry 参数执行正式迁移。");
  }
}

main().catch(e => {
  console.error("\n❌ 迁移失败:", e.message);
  process.exit(1);
});
