# sakuramu-home

个人主页源码。两个站点，两个独立的 Cloudflare Worker：

| 站点 | 目录 | 配置 | Worker |
|---|---|---|---|
| [sakuramu.edu.kg](https://sakuramu.edu.kg) | `public/` | `wrangler.jsonc` | `restless-mountain-3c35` |
| [about.sakuramu.edu.kg](https://about.sakuramu.edu.kg) | `v2/` | `wrangler.v2.jsonc` | `sakuramu-home-v2` |

都是 Cloudflare Workers [Static Assets](https://developers.cloudflare.com/workers/static-assets/)
纯静态托管，文件由边缘节点直接分发，不消耗 Worker 调用次数。
无框架、无构建步骤 —— 每个站点就是一个自包含的 HTML 文件。

## 常用命令

```bash
npm run dev            # 本地预览主站 http://localhost:8787
npm run snapshot       # 只刷新烧录的 Token 快照，不部署
npm run deploy         # 刷新快照 + 部署主站
npm run deploy:about   # 部署关于页
```

首次使用需要 `npx wrangler login` 授权。

**部署主站请用 `npm run deploy`，不要直接 `npx wrangler deploy`** ——
后者会跳过快照刷新，页面的兜底数据会一直停在上次手动更新的时刻。

## 兜底快照

首页底部的用量数据来自本机 TokenTracker，经
[tt.sakuramu.edu.kg](https://tt.sakuramu.edu.kg/v1/stats/sakuramu) 发布。
页面里同时烧录了一份快照，统计服务不可达时静默回落到它，
不会让首页跟着一起挂。

项目列表（`PROJECTS`）同理，来自 GitHub API。

`scripts/refresh-snapshot.mjs` 在发版前把两份远端数据写进 `public/index.html`。
三条硬规矩：

- **任何一份失败都不阻断发版** —— 保留现有快照、大声警告、退出码 0。
  远端偶尔抽风不该让主站发不出去。要在 CI 里当硬失败就加 `--strict`。
- **写入前做结构校验** —— Token 快照检查格式版本、数组长度与 `range.days`
  是否一致、逐日求和与 `window_tokens` 是否相符、`dated + undated == tokens`
  恒等式；项目快照检查过滤后不为空。宁可留着旧快照，也不把坏数据烧进页面。
- **两份互不牵连** —— 统计服务挂了，项目照常更新，反之亦然。

项目快照的合并规则与页面里的 `merge()` **完全一致**：

```js
{ n:p.n, t:p.t, d:p.d, g:p.g, l:m.l || p.l, s:m.s, p:m.p }
```

`t`（标题）、`d`（中文描述）、`g`（标签）是手写内容，**GitHub 永不覆盖**；
只有语言、星数、最后推送时间跟着远端走。GitHub 上新增的仓库会被追加，
之后它的描述就也成了手写字段，可以放心改。

端点与用户名可用环境变量覆盖：`TT_ENDPOINT` / `TT_HANDLE` / `GH_USER`。

> 页面检查载荷的 `v === 1`。将来 TokenTracker 若升到 v2，
> 页面会**静默回落到烧录快照**而不报错 —— 这是有意的安全失败，
> 但升版时记得同步改页面。

## 目录结构

```
public/index.html   主页（唯一页面，CSS 与 JS 全部内联）
public/avatar.jpg   头像
public/status.json  状态气泡，直接编辑即可生效
v2/index.html       关于页
scripts/            发版脚本
```
