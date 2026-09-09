# 网站 SEO 维护

网站从 `website/` 直接发布到 `https://whitelonng.github.io/mancode/`。

## 页面约定

- 英文首页的规范网址为 `/mancode/`，其余三个页面保留各自的 HTML 路径。
- 每个页面维护独立的标题、描述、自引用 canonical，以及同类页面中英文互指的 hreflang。`x-default` 指向对应的英文页面。
- Open Graph 和 Twitter 卡片使用绝对网址及现有的 280 × 280 PNG 标志，采用适合方形图片的 `summary` 卡片。
- JSON-LD 描述网站、开源软件和当前页面；不要填写未经证实的评分、下载量或更新日期。
- 增加、移除页面或更换域名时，同步修改页面元数据、JSON-LD 和 `website/sitemap.xml`。站点地图仅列出规范网址。

## 发布后收录

1. 使用现有 GitHub Pages 部署流程发布，然后检查四个页面和 `/mancode/sitemap.xml` 均能正常访问。
2. 在已验证的 Google Search Console 资源中提交 `https://whitelonng.github.io/mancode/sitemap.xml`，使用网址检查确认 Google 读取到的 canonical 和页面内容；其他搜索引擎可在对应站长平台提交。
3. 后续通过站长平台观察收录、搜索词、点击率和网页体验数据。元数据优化不保证收录或排名。

## 网站访问统计

四个页面使用同一个 Umami Cloud Website ID：`3188d270-69ac-460c-b106-49c2887dd873`。此 ID 是公开采集标识，不是后台登录凭据。脚本异步加载，仅在 `whitelonng.github.io` 域名上记录访问，本地预览不计入；目前只在本项目的四个页面部署。查询参数和页内锚点不采集，未启用录屏或自定义事件。官网统计与 mancode CLI 的本地运行、无遥测行为相互独立。

在 [Umami Cloud](https://cloud.umami.is/) 登录后，进入“网站 → mancode”查看访客、浏览量和来源。按天查看时使用 `Asia/Shanghai` 时区。不要开启公开分享，网站不提供统计看板入口，也不存放账号密码或 API 密钥。

发布后用正常浏览器访问官网，确认 Umami 出现对应页面访问记录；广告拦截器可能阻止采集。未发布的本地接入不会产生线上统计，历史访问也无法补回。

如果需要排除自己的日常访问，在正式官网页面的浏览器开发者控制台执行以下官方设置（仅影响当前浏览器、当前域名；清除站点存储后需重设）：

```javascript
localStorage.setItem('umami.disabled', '1');
```

恢复统计时执行 `localStorage.removeItem('umami.disabled')`。不要在 Umami 后台域名下执行，否则不会影响官网访问。此设置尚未替管理员浏览器执行。

参考：[Umami 统计配置](https://docs.umami.is/docs/tracker-configuration)、[排除自己的访问](https://docs.umami.is/docs/exclude-my-own-visits)。

`robots.txt` 必须位于域名根目录 `https://whitelonng.github.io/robots.txt`；当前仓库只控制 `/mancode/`，所以不在 `website/` 放置无效的子路径规则。如可维护域名根站点，可在其现有规则中追加：

```text
Sitemap: https://whitelonng.github.io/mancode/sitemap.xml
```

页面里的 sitemap 链接用于发现和工具读取，不能替代站长平台提交。不要为了规范重复 URL 在 robots.txt 中屏蔽 `index.html`，爬虫需要访问页面才能读取 canonical。

参考：[Google 规范网址指南](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)、[站点地图指南](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)、[robots.txt 规范](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec)。
