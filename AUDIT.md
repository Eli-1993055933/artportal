# ArtPortal 信息采集管线重构 — 阶段 0 现状盘点(AUDIT)

> 对应《ArtPortal-采集管线重构-实施计划.md》阶段 0 要求。本报告只读盘点,未修改任何代码。
> 完成后停下汇报,等待确认再进入阶段 1。
> 2026-08-03 产出。

---

## 1. 技术栈

- **后端(pipeline/)**:Node.js 原生 ESM(`"type":"module"`),无框架、无 TypeScript、无构建步骤。
  `pipeline/package.json` 依赖仅两项:`@anthropic-ai/sdk`、`better-sqlite3`(WAL 模式)。
  HTTP 服务用 Node 内置 `node:http`,定义在 `pipeline/server.mjs`(4056 行的单体文件)。
- **数据层是双轨制**:
  - UGC 类(评论/投稿/作品/关注/通知/反馈/检索溯源等)→ **SQLite**,`pipeline/lib/db.mjs` 建表,库文件
    `pipeline/state/artportal.db`。`state/` 目录**不入 git、不参与部署同步**(UGC 只在服务器生长)。
  - 机会/资讯/招聘正文 → **纯 JSON 文件**:`site/data/opportunities.json`(326条)/`jobs.json`(50条)/`news.json`(89条)。
    整份读-改-写,不是数据库事务。账号/会话也是 JSON(`pipeline/lib/auth.mjs` 管理)。
- **前端(site/)**:纯静态,无构建产物。`site/index.html` 单文件 3365 行,CSS/JS 全内联,用 D3.js 做地球可视化。
  **前端直接 `d3.json('data/opportunities.json')` 等静态请求拉取数据文件**(`site/index.html:3331/3337/3339`),
  不经过任何 API——这是迁移时的硬约束,见第 9 节。
- `DEPLOY.md` 里"纯静态部署"的描述已过时:线上实际运行的是带常驻 Node 后端的 `server.mjs`(见第 6 节)。

---

## 2. 目录结构(pipeline/)

```
pipeline/
├── run.mjs                每日主管线:固定信源(sources.json)抓取→AI提取→校验→写 opportunities.json
├── run-channels.mjs       资讯/招聘等价管线(sources-news.json / sources-jobs.json)
├── server.mjs             【核心巨文件】静态站托管 + /api/search + 账号/后台API + 全部后台定时抓取任务
├── sync-server.mjs        本地↔服务器双向合并同步(数据+封面)
├── discover-sources.mjs   扩充 sources.json 信源(路线图 30.1 项,与本计划"补源"目标高度重合)
├── sources.json           202 条固定官网/RSS信源清单
├── sources-news.json / sources-jobs.json
├── regions.json           16 位"区域经理"编队调度配置
├── prompts/                extract.txt / extract-jobs.txt / extract-news.txt
├── lib/                    见下表
└── state/                  运行时状态(不入git):artportal.db、hashes.json、review-queue.json、
                             events.jsonl、users.json、regions-report.json 等
```

`pipeline/lib/` 中与采集直接相关的文件:

| 文件 | 用途 |
|---|---|
| `fetch.mjs` | 抓取源页面(HTTP + robots 合规,依赖 `robots.mjs`) |
| `discover.mjs` | 列表页发现详情链接 |
| `extract.mjs` | 调 DeepSeek/GLM 结构化抽取 |
| `verify.mjs` | evidence 逐字校验(字段必须能在原文找到出处) |
| `dedupe.mjs` | 去重(标题指纹) |
| `trust.mjs` | 信任分级(auto/pending/verified) |
| `cover.mjs` | 封面提取 |
| `locate-official.mjs` | 第三方转载源→定位官网 |
| `aggregators.mjs` | 判断是否第三方聚合/转载站 |
| `channels.mjs` | 资讯/招聘频道抓取(`harvestChannel`) |
| `websearch.mjs` | 联网搜索封装(serper 优先/DuckDuckGo 兜底) |
| `leads.mjs` | "探长"社媒线索发现 |
| `regions.mjs` | "区域经理"调度算法 |
| `healthcheck.mjs` / `qc.mjs` | 死链/过期检测、数据质检"校勘" |
| `mailer.mjs` | 邮件**发信**(见第 8 节,无收信能力) |

**关键点**:仓库里没有清晰的"run.mjs + harvest.mjs + verify.mjs"三件套边界——真正驱动"用户检索/自动检索/区域经理/探长"的抓取逻辑并**不在 run.mjs**,而是**全部写死在 server.mjs 这一个文件里**。

---

## 3. 现有数据库 schema

**SQLite**(`pipeline/state/artportal.db`,建表在 `pipeline/lib/db.mjs`),12 张表,实测行数:

| 表 | 行数 | 说明 |
|---|---|---|
| submissions | 0 | 用户投稿队列 |
| recycle | 0 | 后台删除回收站 |
| search_ingest | 102 | **检索入库溯源**(谁/哪次检索带进来的,只记账不做审核) |
| follows | 1 | |
| blocks | 0 | |
| notifications | 14 | |
| comments | 9 | |
| comment_likes | 2 | |
| work_likes | 0 | |
| works | 0 | |
| feedback | 0 | |
| newsletter_sends | 1 | |
| agent_log | 6 | 各 agent 打卡记录 |
| moderation_log | 45 | 审核审计日志 |

**没有 `sources`/`raw_snapshots`/新版 `opportunities` 表——这些是本次要新建的。**

机会/资讯/招聘正文是纯 JSON 文件,`site/data/opportunities.json` 顶层结构:
```json
{ "_meta": {...}, "generated_at": "...", "count": 326, "opportunities": [ {...326条} ] }
```
单条记录关键字段:`id, category, title_zh/en, org_zh, city_zh, country_zh, deadline, deadline_note,
apply_fee{free,amount,currency}, participation_fee{...}, funding{stipend,housing,travel},
eligibility{students_ok,age_limit,nationality}, disciplines[], summary_zh, url, source_url, domain,
org_type, trust(auto/pending/verified), status(open/expired), verified_at, first_seen, last_seen,
updated_at, _via(search由检索写入才有此字段)`。

`jobs.json`/`news.json` 是姊妹文件但**字段命名不统一**:jobs 用 `apply_url`(不是 `url`),
news 用 `url` 但两者都**没有独立的 `source_url` 字段**——这点在写新 schema 的字段映射时要注意,
不是数据缺失,是历史上三个频道各自演化出的命名差异。

---

## 4. 现有采集逻辑(5 条路径收敛到 2 个函数)

| 路径 | 触发方式 | 代码位置 |
|---|---|---|
| (a) 每日固定信源管线 | `run-daily.bat` 调 `run.mjs` | `run.mjs` 全文件,202条固定源 |
| (b) 用户手动检索 | 前端点"AI检索"按钮 | `server.mjs:2247-2277` `/api/search` 路由 |
| (c) 每小时自动检索 | 进程内 `setInterval`,`AUTO_HARVEST=1` | `server.mjs:1702-1808`,固定词池硬编码在文件里 |
| (d) 区域经理编队 | 进程内定时器每10分钟对表,`REGION_HARVEST=1` | `server.mjs:1810-1929` + `lib/regions.mjs` |
| (e) 探长(社媒线索) | 进程内每天一次,`AUTO_DISCOVER=1` | `server.mjs:2119-2152` + `lib/leads.mjs` |

**(b)(c)(d)(e) 四条路径全部复用同一对写库函数**:`searchAndHarvest()`(机会频道,`server.mjs:198-296`)、
`harvestChannel()`(资讯/招聘,`lib/channels.mjs`)。区别只在"查询词从哪来"和溯源标注(`email` 字段标
`"auto-hourly"`/`"region:xx"`/用户邮箱/`null`)。只有 (a) 走的是本计划要保留、要强化的"固定信源"模式。

---

## 5.【重点】"用户检索触发入库"——定位与所有调用点

**结论:确实存在,且没有人工审核环节,直接判定 `trust:"auto"` 公开可见。**

- **前端**:`site/index.html:3274-3293`,`runSearch()` 调 `fetch('/api/search?q=...&channel=...')`,
  返回的 `r.added` 直接 `concat` 进本地渲染列表,同时后端已经把这批数据写死进 JSON 文件。
- **后端路由**:`server.mjs:2247-2277`,`/api/search`。有限流(IP级)、8分钟同词缓存、serper预算闸,
  **但没有写入前的人工审核**。核心写盘代码(`server.mjs:280-294`):
  ```js
  saved = await withWriteLock(async () => {
    const cur = JSON.parse(await readFile(DATA, "utf8"));
    const fresh = added.filter(o => !ids.has(o.id) && !urls.has(o.url));
    if (fresh.length) { cur.opportunities.push(...fresh); await writeFile(DATA, ...); }
    return fresh;
  });
  ```
- **溯源记账**(不是审核闸):`db.ingestInsert()`(`lib/db.mjs:197-203`),写入 `search_ingest` 表,
  仅用于后台标注"哪次检索带进来的",**不影响是否写入 JSON——JSON 写入独立于这条记账**。

**所有调用 `ingestInsert` 的位置**(即全部"检索→入库"触点):

| 位置 | 触发者 | email 标注 |
|---|---|---|
| `server.mjs:2268` | 用户点"AI检索" | 用户邮箱/访客IP |
| `server.mjs:1791` | 每小时自动检索 | `"auto-hourly"` |
| `server.mjs:1829` | 区域经理 | `"region:"+id` |
| `server.mjs:1906` | 编辑部班次(资讯/招聘) | `"desk"` |

**⚠️ 必须在阶段 1 开工前拍板的问题**:计划原文阶段 2 第 5 条只写"移除用户检索触发入库的旧逻辑",
但 `searchAndHarvest`/`harvestChannel` 是 4 条路径共用的同一份代码。如果只砍掉 (b) 用户手动检索这一
个调用点,(c)每小时自动检索、(d)区域经理编队、(e)探长 三套后台定时任务**仍会继续通过同一函数直接
写库**,"停止全网搜索式抓取"这个目标不会真正达成。而 (d) 区域经理编队是最近一个月的重点投入(16人
编队、v0.98.0 上线,路线图第30项仍在推进"信源扩量"),(c)(e) 也各自跑了一段时间。三者要不要保留、
以什么形式保留(比如降级为"给新 sources 表投喂候选线索,而非直接写库"),需要项目负责人明确决定,
不属于阶段0可以自行拍板的范围。

---

## 6. 部署方式

`DEPLOY.md` 文档偏旧(仍在讲"纯静态托管到 Cloudflare Pages"的方案),与实际线上运行方式有出入。
**实际部署流程**(已在本次会话中通过 SSH 验证):
- 服务器:`admin@60.205.212.195`,代码目录 `/home/admin/artportal`。
- 部署:本地 tar 打包相关文件 → `scp` 上传 → 服务器解压覆盖。
- 服务:`systemd` 管理,单元名 `artportal.service`,监听 `PORT=8080`,`TRUST_PROXY=1`(nginx反代传
  `X-Real-IP`)、`COOKIE_SECURE=1`。改了 `pipeline/` 后端代码需 `sudo systemctl restart artportal`;
  纯前端(`site/`)改动不需要重启。
- nginx 做 HTTPS 反代(Let's Encrypt 证书,域名 `artportal123.com`)。
- 数据同步走 `pipeline/sync-server.mjs`(本地↔服务器按条合并,不整文件覆盖,保证服务器独有的
  UGC/检索入库数据不丢)。

---

## 7. 定时任务机制

**两条独立调度体系并存**:
1. **本机(Windows 任务计划)**:`run-daily.bat` 被动等待外部调度触发(仓库里没有 `schtasks` 注册脚本,
   系统层手工配置、不受版本控制)。串行执行:`run.mjs` → 补译/补官网/补封面三个 backfill 脚本 →
   `run-channels.mjs` → 资讯招聘补齐 → `cover-audit.mjs` → `sync-server.mjs` 同步上线。
2. **服务器(server.mjs 进程内定时器)**:`setInterval`/`setTimeout` 自带心跳,不依赖外部调度器——
   每小时自动检索(`server.mjs:1806`)、区域经理每10分钟对表(`:1923`)、探长每天一次(`:2150`)、
   质检/清理/周报等(`:2065/2079/2115`)。

即"本机负责固定信源抓取+打包同步","服务器负责检索类抓取+托管+常驻任务",两边独立调度,靠
`sync-server.mjs` 对齐数据。**部署与定时任务本身缺乏版本控制**(Windows任务计划、systemd unit 配置
均未入库),阶段4"可观测与自优化"可以顺带把调度声明代码化。

---

## 8. 邮件基建(阶段1"邮件采集"的现有基础)

- `pipeline/lib/mailer.mjs`:极简自研 SMTP **发信**客户端,零第三方依赖,手写 `node:tls` SMTP 协议
  对话(TLS 465端口 + AUTH LOGIN)。服务商不绑定,靠 `.env` 的 `SMTP_HOST/PORT/USER/PASS` 配置,
  注释建议用 QQ邮箱/阿里云DirectMail。`MAIL_DEBUG=1` 时只打印不真发。
- 实测服务器 `.env` **未配置 `SMTP_*`**,发信功能当前处于降级/未启用状态。
- **全仓库没有任何 IMAP/POP3/收信解析代码**。`mailer.mjs` 只处理发信(验证码、周报群发)。
  → **阶段1的 IMAP 采集器需要从零搭建**,现有基建只能复用"发信"能力(比如给审核员发通知邮件),
  收信侧是全新工作,Node 生态可选 `imapflow`/`mailparser` 之类的库(目前 `package.json` 里没有)。

---

## 9. 数据统计(实测,2026-08-03)

### opportunities.json(326 条)——计划要求的核心统计项
| 指标 | 数值 |
|---|---|
| 总条数 | 326 |
| `status="expired"` | 179 |
| `deadline` 已过但 `status` 未标 expired(推算,含 rolling 排除) | 222(即比 status 字段实测的179多出约43条"已过期但仍标 open") |
| 缺少 `url`(即计划里的 `application_url`) | 1 |
| 缺少 `source_url` | 1 |
| 疑似重复(标题完全相同,按重复标题组数计) | 7 组 |
| 疑似重复(URL完全相同) | 0(说明现有去重在URL层面做得还行,标题层面有漏网) |

**最值得注意的一项**——`_via` 字段分布:
```
(常规固定信源管线) 122 条(37%)
search(检索类写入,含用户手动+自动检索+区域经理+探长) 203 条(62%)
submit(用户投稿) 1 条
```
**62% 的现有机会数据来自"检索即写库"路径,不是固定信源管线**。这个数字直接印证了计划背景里
"现有全网搜索机制效果差"的诊断在**新增数量上并不算差**(检索类贡献了六成存量),但也印证了
"检索是读操作不该担写库职责"的架构问题——这六成数据完全没有经过人工审核,只有程序化 evidence
校验。阶段1/2 设计审核队列时,建议把这个真实占比考虑进去:一旦砍掉检索写库路径,固定信源管线
需要顶上这 60% 的产出缺口,否则新增量会短期内断崖下跌,这在阶段2上线前应该向负责人说明预期。

### jobs.json(50条)/news.json(89条)——补充参考
- jobs:`_via` 分布 seed 21 / daily 11 / search 18 → 检索占比 36%
- news:`_via` 分布 seed 24 / daily 3 / search 62 → 检索占比 70%,三个频道里依赖检索比例最高
- 两者的"缺少url"统计因字段命名差异(jobs用`apply_url`,news本身有`url`)不适用于直接对比,已在
  第3节说明,不是数据质量问题。

---

## 10. 迁移方案与风险评估

### 10.1 新表放哪里
`sources`、`raw_snapshots` 建议直接加进现有 `pipeline/state/artportal.db`(通过 `pipeline/lib/db.mjs`
的 `getDb()` 加建表语句),理由:
- 零新增依赖,`better-sqlite3` 已在用,WAL 模式已配好。
- 与现有 UGC 表(`search_ingest`/`agent_log` 等)同库,查询/关联方便(比如把 `search_ingest` 的历史
  检索记录接到未来的 `zero_result_queries` 分析上)。
- 风险低:纯新增表,不影响现有 12 张表。

### 10.2 opportunities 表怎么落地——这是本次迁移最大的架构决策点
**硬约束**:前端 `site/index.html` 用 `d3.json('data/opportunities.json')` **直接拉静态文件**,不经过
任何 API(第1节已确认)。计划本身也明确"不要重写网站前端"。

**建议方案**:新 `opportunities` 表进 SQLite 作为**唯一可信源(source of truth)**,`site/data/*.json`
降级为**发布产物(export artifact)**——审核通过时(或定时)从 SQLite 里 `status='published'` 的记录
重新生成 JSON 文件,写盘方式复用现有 `withWriteLock` 原子写逻辑。前端代码一行不用改。

**一次性迁移动作**:把现有 326 条 opportunities.json 记录导入新表,`status='published'`、
`source_id=NULL`(标记"历史数据,无对应源"),避免"重构后网站瞬间清空"的灾难性回退。jobs/news
两个频道字段命名不统一(`apply_url` vs `url`,没有 `source_url`),导入前需要写一层字段映射,
建议阶段2处理机会频道时一并定下 jobs/news 的映射规则,不要三个频道各写一套。

### 10.3 最大的架构冲突点(需要负责人先拍板,见第5节⚠️)
`searchAndHarvest`/`harvestChannel` 被 4 条路径共用,只移除用户手动检索这一个调用点,后台三套定时
任务(每小时自动检索/区域经理/探长)仍会绕过新架构直接写库。建议阶段1开工前明确以下三选一:
1. **全部下线**,后台三套定时任务的"发现"能力改造成"发现候选 → 写入 sources 表当新源候选",
   由人工审核决定要不要转正为长期订阅源(最贴合计划"源清单是核心资产"的理念,但改造工作量最大,
   区域经理编队近一个月的调度算法基本要重写)。
2. **保留但改写入口**:四条路径继续跑发现逻辑,但把最终写库动作统一改成"写进 review_queue 待审",
   而不是直接 `trust:auto` 公开(改动集中在 `searchAndHarvest`/`harvestChannel` 内部,调度逻辑不动,
   工作量适中)。
3. **暂不动,只砍用户手动检索**:按计划原文字面执行,后台三套照旧。最快但没有真正达成"不再全网
   搜索式抓取"的目标,且会让"阶段2验收标准:抽取准确率95%"的统计口径出现两套并存的数据源头。

本报告不替负责人做这个决定,阶段1的具体施工范围建议以此为前提重新确认。

### 10.4 其它迁移风险
- `run.mjs`(本机定时)与 `server.mjs`(服务器常驻)两个独立进程各自写同一份 JSON 文件的并发问题,
  改用 SQLite 作为可信源后,这套 `withWriteLock`/写前重读/`sync-server.mjs` 三层补丁可以逐步简化,
  但过渡期(阶段1-2 并行时)两条写路径都要保持工作,不能中途断档。
- IMAP 收信是全新代码,建议先用小流量测试邮箱跑通阶段1验收标准(拉取解析20封邮件),再接入
  附录A种子清单里标注邮件订阅的真实源,避免一上来大批量订阅导致收件箱噪音难以排查。
- 部署/定时任务本身没有版本控制(第7节),阶段1如果新增 IMAP 定时轮询,建议直接补一份最简单的
  systemd timer 或 Windows 任务计划注册脚本入库,不要再依赖"系统层手工配置、无人记得改了什么"。

---

## 11. 阶段 0 结论

- 现状盘点已完成,四份要求的产出(技术栈+现有采集逻辑定位、用户检索入库定位、数据统计、迁移方案)
  均已给出,具体见第1-10节。
- **本报告不建议直接进入阶段1**,原因见第5节⚠️与第10.3节——计划原文对"检索触发入库"的处理范围
  只覆盖用户手动检索一条路径,但实际代码里这是4条路径共用的同一份逻辑,其中"区域经理编队"是最近
  重点投入、仍在推进中的功能。这个范围认定需要负责人先确认三选一(全下线/改审核入口/暂不动),
  否则阶段1的验收标准和阶段2的"移除旧逻辑"范围会出现执行偏差。
- 其余部分(源注册表建SQLite表、IMAP采集器从零搭建、发布产物导出方案)按计划原文推进无架构性
  障碍,可以在拍板第10.3节问题后直接开始阶段1。
