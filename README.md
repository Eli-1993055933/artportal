# ArtPortal · 全球艺术机会

聚合全球艺术展览征集、驻留、奖项、工作坊的申请机会,面向中国艺术家与艺术院校学生。
一眼说清三件事:**真不真 · 急不急 · 给不给钱**。

## 仓库结构

```
site/       纯静态前端(零依赖零构建,只读一个 JSON,无后端/数据库/Docker)
pipeline/   数据管道(每天定时抓官网/RSS → 更新 site/data/opportunities.json)
.github/    GitHub Actions 定时任务(第 6 步接入,当前尚未启用)
```

## 运行前端(本地)

前端读取 JSON 需经 HTTP(`file://` 下 fetch 会被拦),用任意静态服务器:

```bash
npx serve site -l 4321
# 或
python -m http.server 4321 --directory site
```

然后打开 http://localhost:4321

- 无需构建、无需 npm install。
- 字体用系统字体栈,不加载任何 CDN / webfont —— 中国大陆可正常打开。
- 深链形如 `#/o/<id>`,可直接复制分享(微信群深链可用)。

## 数据

- 前端唯一数据源:`site/data/opportunities.json`,字段定义见文件内 `_meta` 与需求第五节。
- 当前为 **16 条真实种子数据**,均由 2026-07-09 实际抓取机构官网原文整理,非 AI 凭知识生成。
- `trust` 两档对用户可见:`verified`(已人工核实)/ `auto`(程序自动收录,前端明确标注"未人工核实")。
- 原文逐字 evidence 存档于 `pipeline/state/seed-provenance.json`(不进前端公开数据)。

## 合规红线(写进代码注释,不可违反)

1. 只抓机构官网与公开 RSS;**绝不抓微信公众号 / 小红书 / 抖音**(中国刑事与民事法律风险)。
2. 抓取前先读 robots.txt 并遵守,禁止即跳过;同域名请求间隔 ≥ 3 秒;UA 如实报明身份+邮箱。
3. AI 只读原文、只整理格式,不联网、不补全、不用自身知识生成一条机会。
4. 每个关键字段由 AI 输出逐字 evidence,再由**程序**核对是否为原文子串;不是则该字段作废并记日志。
5. API key 只存 GitHub Secrets,绝不出现在前端代码或页面。

## 进度

- [x] 第 1–3 步:目录核查、结构与依赖确定、信源清单核验(见 `pipeline/sources.json`)
- [x] 第 4 步:前端 site/ + 16 条真实数据,自查 11 项全部通过
- [x] 第 5 步:pipeline 抓取+提取跑通(2 信源真实验证;evidence 子串校验、伪造拦截、哈希省钱均实测)
- [x] 第 6 步:GitHub Actions 每日定时(`.github/workflows/daily.yml`)

## 上线前你需要人工做的 3 件事

1. 建远程仓库并推送:`git remote add origin <你的仓库>` → `git push -u origin master`
2. 仓库 Settings → Secrets → 新增 `ANTHROPIC_API_KEY`(值为你的 Anthropic API key)
3. Settings → Actions → General → Workflow permissions 选 "Read and write permissions"

前端部署:把 `site/` 目录托管到任意静态服务(GitHub Pages / Vercel / 自有服务器均可)。