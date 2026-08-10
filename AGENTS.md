# ArtPortal 项目要求(每次对话必守)

## 沟通与工作方式(用户明确要求)
- **全程简体中文**交流。
- **效率优先**:尽可能优化每次处理的效率,别让用户久等;评审/验证规模与改动风险匹配,小改动用单测+自查,别动辄大规模多智能体评审。
- **少确认、直接办**:不重要的事不要问,直接去办;可逆操作自主执行;确认必须批量,绝不逐个问。
- 每完成一项:提交 git、更新 `路线图.md`/`项目进度.md`、需要上线的直接部署,然后汇报结果。
- **列后续计划时,每项同时标注计划发布的版本号**(如"8.1 主页框架 → v0.50.0"),计划表即发布清单;版本号是计划值,中途插 patch 顺延,以 CHANGELOG 为准。

## 接续工作
- 新对话先读 `项目进度.md` + `路线图.md`(权威的"接下来做什么"清单)。

## 核心红线(不可违反)
1. **反幻觉**:AI 只整理抓来的原文,绝不编造;关键字段逐字 evidence,程序校验是原文子串;值本身也须在原文出现。
2. 只抓机构官网+公开 RSS;**绝不抓微信公众号/小红书/抖音**。
3. 数量"尽力而为、真实优先",找不到就是找不到,绝不凑数。
4. 机翻内容必须如实标注,绝不冒充原文/官方;检索来的标"AI 检索",绝不谎称官网直采。
5. `.env` 的 key 绝不入库/不公开。

## 部署与数据
- 数据同步:`cd pipeline && node sync-server.mjs`(按条合并双向同步,谁的数据都不丢;--dry 先看)。每晚 run-daily.bat 自动跑。
- 代码部署:使用 `node pipeline/deploy.mjs`(自动排除 state/ 和 .env,**部署前强制备份本地 state/**,部署后验证 HTTP 200);纯前端需加 `--frontend-only`。**绝对不要手动 tar 打包 pipeline/**,这会覆盖服务器 state/ 导致用户数据丢失。
- **绝不整文件覆盖服务器的 data/*.json 和 pipeline/state/**(用户/会话/事件数据只在服务器)。部署统一用 `node pipeline/deploy.mjs`(自动排除 state/)。
- **版本号(SemVer)**:改前端 JS/CSS 必须升版——`node pipeline/bump-version.mjs patch|minor|major`(自动同步根 VERSION、index.html 的 ?v=/meta/页脚、pipeline/package.json,并在 CHANGELOG.md 插新段);升完在 CHANGELOG 补一句变更说明,提交后 `git tag v<版本>`。patch=修bug,minor=新功能,major=不兼容大改;**1.0.0 留给备案正式上线**。

## 用户数据红线(不可违反)
1. **用户数据是最高优先级**:所有用户数据(users.json、sessions.json、artportal.db、events.jsonl)必须时刻可恢复。
2. **部署前自动备份**:每次执行 `node pipeline/deploy.mjs` 自动触发本地 state/ 备份到 `backups/predeploy_<timestamp>/`。
3. **服务器自动备份**:服务器每天凌晨 3:00 自动执行 `backup-server.sh`，备份 state/ 到 `deploy_backups/auto/`，保留最近 7 天。
4. **定期远程备份**:每周至少执行一次 `node pipeline/backup.mjs`(远程备份,从服务器拉取 state/ 到本地 `backups/snapshot_<timestamp>/`)。
5. **GitHub 版本控制**:所有代码(包括 backup.mjs、deploy.mjs、cleanup.mjs、backup-server.sh)必须提交到 GitHub,确保任何代码变更可回滚。用户数据通过 backup.mjs 生成快照。
6. **禁止手动操作**:绝对禁止手动 tar 打包 pipeline/ 目录,绝对禁止手动 scp 覆盖 state/ 文件。所有部署只能通过 `deploy.mjs`。
7. **数据恢复流程**:如用户数据丢失,先检查本地 `backups/` 目录下的最近快照,或服务器 `deploy_backups/auto/` 下的最近备份,按 `restore.sh` / `restore.cmd` 恢复。
