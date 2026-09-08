# sakuramu-home

[sakuramu.edu.kg](https://sakuramu.edu.kg) 的个人主页源码。

## 部署方式

Cloudflare Workers（[Static Assets](https://developers.cloudflare.com/workers/static-assets/)）纯静态托管，
`public/` 目录下的文件由 Cloudflare 边缘节点直接分发，不消耗 Worker 调用次数。

## 本地开发

```bash
npx wrangler dev
```

浏览器打开 http://localhost:8787 实时预览。

## 部署

```bash
npx wrangler deploy
```

首次使用需要先 `npx wrangler login` 授权 Cloudflare 账号。

## 目录结构

```
public/
  index.html    首页（唯一页面）
wrangler.jsonc  Workers 配置
```

新增页面只需在 `public/` 下添加 HTML 文件，无需修改任何路由代码：
`public/about.html` 会自动映射到 `/about`。
