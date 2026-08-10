---
name: artportal-roadmap
description: ArtPortal(全球艺术机会平台)是用户自建自运营的主产品;画室点评是其子工具。含架构与下一步路线图。
metadata: 
  node_type: memory
  type: project
  originSessionId: cbc1fb01-81d9-4de0-ac84-165b903c6575
---

用户不只是画室老师([[user-art-teacher]]),也是 **ArtPortal「全球艺术机会」平台**的开发者/运营者——一个聚合全球艺术机会(展览、驻地、比赛、招聘等)的网站。画室点评工具([[deck-review-workflow]] 第二阶段、[[studio-web-server]])只是挂在它下面的一个子工具(`/studio`)。

**ArtPortal 架构**(同一台阿里云 `60.205.212.195`,SSH `admin@`,key+免密 sudo):
- Node 服务 `artportal.service`,代码 `/home/admin/artportal/pipeline/server.mjs`(:80),鉴权/用户/注册在 `lib/auth.mjs`(用户存文件、邮箱验证码注册、session cookie)。改前先备份、`node --check`、restart。
- 首页现为机会列表(卡片流);登录后云同步收藏。画室工具走 `/studio/*` 反代到 8791。

**下一步路线图(2026-07-20 用户口述,新对话要做)**:
1. **调研**:AI 时代的信息交互模式,如何比上一代互联网更高效、更人性化(为产品形态定方向)。
2. **主界面改成【地球仪/3D 地球】**:把所有现有 + 未来的"机会"按地理位置放到地球上(可视化入口)。
3. **继续优化界面**。
4. **强化数据获取的精准度 + 扩充各地区数据量**,尤其**中国境内**的体制内、商业、学术类项目与展览(目前中国境内数据可能偏少)。

接新对话时:先确认要先做哪一项;②③是大改前端(地球仪可能要 WebGL/three.js,注意 CSP/自包含与移动端性能);④是数据管线(server.mjs 里可能已有抓取/backfill 脚本如 `backfill-covers.mjs`、`run.mjs`、`sync-server.mjs`,先摸清现有数据源与 schema)。
