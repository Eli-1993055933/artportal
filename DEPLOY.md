# ArtPortal 部署说明

`site/` 是纯静态网站(HTML/CSS/JS + 一个 JSON,约 232KB),**无需构建、无后端、无数据库**。
任何静态托管都能跑,100+ 并发毫无压力(本质是 CDN 分发静态文件)。

打包好的上传包:根目录 `artportal-site.zip`(内含 index.html 等,index.html 在最外层)。
重新打包:PowerShell 里 `Compress-Archive -Path "site\*" -DestinationPath "artportal-site.zip" -Force`。

---

## 今晚:全球公开链接(Cloudflare Pages,从零、免费)

1. 打开 dash.cloudflare.com,注册免费账号(邮箱+密码)。
2. 左栏 **Workers & Pages** → **Create** → 选 **Pages** 标签 → **Upload assets**(不是 Connect to Git)。
3. 项目名填 `artportal`。
4. 把 `site` 文件夹(或 `artportal-site.zip`)拖进上传框 → **Deploy site**。
5. 约 30 秒后得到 `https://artportal-xxxx.pages.dev` —— 这就是你的公开链接。

> 备选(最快拿到链接):app.netlify.com/drop,直接把 `site` 文件夹拖进去,秒出 URL(注册后可保留)。

**更新数据**:每日管道更新的是本机 `site/data/opportunities.json`。当前无 GitHub,
刷新线上版就重新上传一次(Cloudflare Pages → 项目 → Create new deployment → 拖新文件夹)。
以后接了 GitHub 可做「push→自动部署」。

## 现实提醒(大陆 + 微信)

- `*.pages.dev` / `*.netlify.app` 等免费域名在**大陆时通时断**,分享到**微信里常被拦**(非备案域名)。
- 要大陆/微信稳:需 **自有域名 + ICP 备案 + 国内托管/CDN**(见下)。国际访问则不受影响。

## 并行:走中国正规上线(几天~两周)

1. 在**阿里云/腾讯云**买域名(需实名认证)。
2. 用同家云的**静态托管**:阿里云 OSS 静态网站 / 腾讯云 COS 静态网站(把 `site/` 传上去)。
3. 提交 **ICP 备案**(填主体信息、上传证件、拍照核验)——审核约 3~20 天。
4. 备案通过后:把域名绑到托管 + 开 CDN;或在 Cloudflare Pages 里绑该自定义域名。

## 上线前建议补的小事

- **提交机会**按钮当前是占位(点了弹提示)。公开邀约机构投稿前,建议接一个真实表单
  (腾讯问卷 / 金数据 / Google Form),把链接填进 `site/js/app.js` 的 `SUBMIT_FORM_URL`。
- **信息有误** mailto 用的是站长邮箱,公开后有收到垃圾邮件的可能。
- 想要微信分享卡有大图,`og:image` 需换成**绝对地址的 PNG/JPG**(现为 SVG,部分平台不认)。
