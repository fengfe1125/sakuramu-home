# sakuramu-home

个人主页源码。三个站点，三个独立的 Cloudflare Worker：

| 站点 | 目录 | 配置 | Worker | 形态 |
|---|---|---|---|---|
| [sakuramu.edu.kg](https://sakuramu.edu.kg) | `public/` | `wrangler.jsonc` | `restless-mountain-3c35` | 纯静态 |
| [about.sakuramu.edu.kg](https://about.sakuramu.edu.kg) | `v2/` | `wrangler.v2.jsonc` | `sakuramu-home-v2` | 纯静态 |
| admin.sakuramu.edu.kg | `admin/` | `wrangler.admin.jsonc` | `sakuramu-admin` | Worker + D1 |

前两个是 Cloudflare Workers [Static Assets](https://developers.cloudflare.com/workers/static-assets/)
纯静态托管，**配置里没有 `main`**，文件由边缘节点直接分发，不消耗 Worker 调用次数。
无框架、无构建步骤 —— 每个站点就是一个自包含的 HTML 文件。
千万别给它俩加 `main`：加了就从零调用变成每次访问都计费。

三者互不牵连。后台崩了主页毫发无损。

## 常用命令

```bash
npm test               # 渲染器回归（零依赖）
npm run dev            # 本地预览主站 http://localhost:8787
npm run snapshot       # 只刷新烧录的快照，不部署
npm run notes          # 只渲染手记，不部署
npm run deploy         # 刷新快照 + 部署主站
npm run deploy:about   # 渲染手记 + 部署关于页
npm run deploy:admin   # 部署后台
npm run admin:schema   # 把 admin/src/schema.sql 整份重跑（幂等）
npm run admin:tail     # 看后台实时日志
```

首次使用需要 `npx wrangler login` 授权。

**部署主站请用 `npm run deploy`，不要直接 `npx wrangler deploy`** ——
后者会跳过快照刷新，页面的兜底数据会一直停在上次手动更新的时刻。

## 管理后台

`admin.sakuramu.edu.kg`，鉴权全部交给 **Cloudflare Access**（Zero Trust）——
这个 Worker 自己不存密码、不发会话、不碰 Cookie。没写的代码不会有洞。

### 两行不能动的配置

```jsonc
"workers_dev": false,
"preview_urls": false,
```

Access 是绑在**自定义域**上的，只拦 `admin.sakuramu.edu.kg`。
而一个 Worker 默认还有两个 workers.dev 主机名，**两个都完全绕开 Access**：

| 开关 | 主机名 |
|---|---|
| `workers_dev` | `sakuramu-admin.<子域>.workers.dev` |
| `preview_urls` | `<版本号>-sakuramu-admin.<子域>.workers.dev` |

它们是两个不同的主机名，关掉前者不会关掉后者。CI 里有一步专门盯着这两个值，
改成 `true` 就红。部署后也应当实测两条都返回 404。

> 顺带一提：`workers_dev` 的默认值取决于本文件里有没有写 `routes`。
> 这种隐式耦合太容易在「调试时把 routes 注释掉」的瞬间翻车，
> 所以三份配置里都显式写死了 `false`。

### Worker 侧仍然验签

域名已经挡在 Access 后面了，`admin/src/access.mjs` 还是自己验一遍 JWT。
理由是：**将来任何一次手滑加路由都会重新开一个口子，而那时不会有人想起这件事。**
一百多行，成本一次性付清。

三条关键规则：

- **算法白名单只有 RS256。** 挡的是经典算法混淆 —— `alg:none` 直接免签，
  `alg:HS256` 则诱使把人人可取的 RSA 公钥当成 HMAC 密钥。绝不能「按 header 说的算法来」。
- **必须校验 `aud`。** 它把令牌绑死在这一个 Access 应用上。少了它，
  同一个 team 里任何一个策略更宽松的应用签出来的令牌都能进后台。
- **只认 `Cf-Access-Jwt-Assertion` 请求头，不认 `CF_Authorization` Cookie。**
  两者装着同一个 JWT，但 Cookie 会被浏览器跨站自动带上，请求头不会 ——
  只收请求头，这些接口天然免疫 CSRF。

**配置缺失时失败关闭**：拿不到 `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` 就把
所有 `/v1/*` 一律 503。「配置缺了就跳过校验」是后台裸奔到公网上最常见的死法 ——
因为配置丢了没人会发现，一切看起来都正常工作。

### 配置 Access

已配置好，值在 `wrangler.admin.jsonc` 的 `vars` 里。要重建的话，在
Zero Trust 控制台（中文界面：**访问控制** → **应用程序**）：

1. **新建应用程序** → **自托管和私有** → **公共 DNS** → 继续
2. 目标：子域 `admin`，域 `sakuramu.edu.kg`
3. Access 策略：挂一条 Action **允许**、Include **电子邮件** 的策略
4. 身份验证：选中唯一的 IdP，**应用即时身份验证**会自动打开
5. 把 Team domain 和 AUD 填进 `vars`，重新部署

### 登录用的是哪个身份

这个账号唯一配置的 IdP 是 **Cloudflare 账号登录**（type `cloudflare`，
且 `restrict_to_account_members: true`），**不是** One-time PIN ——
账号里根本没开那个。所以策略里的邮箱必须是 **Cloudflare 账号的邮箱**，
填别的会出现「认证通过但被策略拒绝」，而且这个失败模式很不直观。

这不算让步：Cloudflare 账号本来就是这整套基础设施的信任根，
拿到它的人可以直接删掉 Worker、D1 和 DNS，后台的权限严格小于它。
用它守后台不引入新弱点，代价是后台访问与 Cloudflare 账号绑定。
想要两者独立，就得先在 Zero Trust 里开 One-time PIN，再把策略邮箱改回去。

邮箱白名单是第二道闸，属 PII 不进仓库，用 secret 下发：

```bash
npx wrangler secret put ACCESS_ALLOWED_EMAILS --config wrangler.admin.jsonc
```

它挡的是 Access 策略被改宽（那个 Include 下拉框选错成 Everyone 很容易发生）。
留空则完全依赖 Access 策略。`/healthz` 会报出这道闸开没开 ——
**安全配置不可见就等于不存在**。

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

## 写手记

往 `v2/notes/` 放一个 `.md` 文件，然后 `npm run deploy:about`。

```markdown
---
title: 标题
date: 2026-09-11
---

正文……
```

按 front-matter 里的 `date` 倒序排，最新的在最上面。
支持标题、加粗、强调、行内代码、链接、列表、引用、代码块、分割线。

渲染器本体在 `shared/notes-render.mjs`，**发版脚本与（将来的）后台 Worker 共用同一份** ——
后台预览、后台发布、发版烧录三处输出必须逐字一致，各写一份迟早会分叉，
而分叉的表现是「预览好好的，发出去不一样」。

链接有**协议白名单**：无协议的相对路径、锚点一律放行，有协议则只认
`http` / `https` / `mailto`。不在白名单的**不生成链接，原样输出文本** ——
否则 `[点这里](javascript:...)` 会渲染成一个可点击的 `javascript:` 链接，
等内容来自网页表单时那就是自己域名上的存储型 XSS。

**Markdown 在发版时渲染成 HTML 直接写进页面**，不在浏览器里解析：

- 站点的原则是「无构建步骤、单个自包含 HTML」——
  访客拿到的应该是成品，不是一个还要自己组装的半成品。
- 解析器只在 Node 里跑一次，不必让每个访客都下载一份。
- 没有 fetch 就没有 CORS、没有加载失败、没有空白态。

排版上自动做两件手打容易漏的事：**中西文之间补空格**
（写 `TokenTracker和macOS` 会渲染成 `TokenTracker 和 macOS`），
以及**正文第一段首字下沉**。

## 目录结构

```
public/index.html   主页（唯一页面，CSS 与 JS 全部内联）
public/avatar.jpg   头像
public/status.json  状态气泡，直接编辑即可生效
v2/index.html       关于页（手记渲染进这里）
v2/notes/*.md       手记原稿
admin/src/          后台 Worker（index.mjs 路由、access.mjs 鉴权、schema.sql 建表）
admin/ui/index.html 后台界面（自包含，复用站点的设计令牌）
shared/             发版脚本与 Worker 共用的纯函数
scripts/            发版脚本
tests/              零依赖回归测试
```
