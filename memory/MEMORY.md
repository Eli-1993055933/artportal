# Memory Index —— 统一记忆(母系统 ArtPortal + 子系统 画室点评)

> 这是【整个系统】的权威记忆,存在 `D:\claude code\memory\`。ArtPortal 是**母系统**,画室点评是挂在它下面的**子系统**(`/studio`)。每次开工先读这里、也写这里。

## 谁
- [User](user-art-teacher.md) — 张智涵:既是画室老师(成功轨迹画室·南海艺高·三组),也是 **ArtPortal 平台的开发者/运营者**;技术型,直接 SSH 改服务器代码。

## 母系统:ArtPortal「全球艺术机会」
- [ArtPortal 路线图](artportal-roadmap.md) — 平台架构(阿里云 Node `server.mjs`:80、`lib/auth.mjs`、`/studio` 反代)+ 下一步:①调研AI时代信息交互 ②主界面改地球仪 ③优化界面 ④扩充各地区(尤其中国境内)数据。

## 子系统:画室点评工具(ArtPortal 的 /studio)
- [部署与运维](studio-web-server.md) — 阿里云部署、SSH免密、并行提速、鉴权(对所有注册用户开放)、每用户私有花名册与抬头、坑记录。
- [点评工作流](deck-review-workflow.md) — 学生作业拼图 → 每生点评 PPT 的完整流程与固化工具(`D:\画室点评工具\`)。
- [作品图处理](art-scan-image-processing.md) — 温和统一色调、只裁截图UI、绝不毁掉真实画作。
