# sakuramu-home

个人主页源码。五个站点，五个独立的 Cloudflare Worker：

| 站点 | 目录 | 配置 | Worker | 形态 |
|---|---|---|---|---|
| [sakuramu.edu.kg](https://sakuramu.edu.kg) | `public/` | `wrangler.jsonc` | `restless-mountain-3c35` | 纯静态 |
| [about.sakuramu.edu.kg](https://about.sakuramu.edu.kg) | `v2/` | `wrangler.v2.jsonc` | `sakuramu-home-v2` | 纯静态 |
| admin.sakuramu.edu.kg | `admin/` | `wrangler.admin.jsonc` | `sakuramu-admin` | Worker + D1 + cron |
| notes.sakuramu.edu.kg | `notes-api/` | `wrangler.notes.jsonc` | `sakuramu-notes` | Worker + D1（只读） |
| hits.sakuramu.edu.kg | `hits-api/` | `wrangler.hits.jsonc` | `sakuramu-hits` | Worker + D1（只写） |

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
npm run shared         # 只注入共用片段（样式 + 埋点），不部署
npm run deploy         # 刷新快照 + 部署主站
npm run deploy:about   # 渲染手记 + 部署关于页
npm run deploy:admin   # 部署后台
npm run deploy:notes   # 部署手记的公开只读接口
npm run deploy:hits    # 部署访客上报接口
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

**One-time PIN**（邮箱验证码），刻意选的：后台访问与 Cloudflare 账号互相独立，
换一台没登录 Cloudflare 的设备也能进。应用的 `allowed_idps` 里只有它一项，
所以「应用即时身份验证」生效，打开就是输验证码，不经过选择页。

> One-time PIN 在 Zero Trust 里是「**一个 IdP 都没配时的兜底**」——
> 只要配了任何一个别的 IdP，它就不再出现，得去
> **集成 → 标识提供程序 → 添加标识提供程序 → One-time PIN** 显式加上。
> 这一条不翻文档基本猜不到。

**策略里的邮箱必须和登录方式断言出来的邮箱一致。** 两者不一致会产生
「认证通过、随后被策略拒绝」的组合，而界面上看不出是哪一步出的问题 ——
这是这套东西最不直观的失败模式。当前是 One-time PIN，所以策略邮箱
就是收验证码的那个邮箱；若改回 Cloudflare 账号登录，就得同步换成
Cloudflare 账号的邮箱。

`ACCESS_ALLOWED_EMAILS` 这道 Worker 侧的闸也要跟着一起改，
否则会出现「Access 放行了、Worker 拒绝」的另一半错配。
好消息是这一半有迹可循：`/healthz` 会报出白名单开没开，
Worker 日志里也会记下 `access denied: email`。

邮箱白名单是第二道闸，属 PII 不进仓库，用 secret 下发：

```bash
npx wrangler secret put ACCESS_ALLOWED_EMAILS --config wrangler.admin.jsonc
```

它挡的是 Access 策略被改宽（那个 Include 下拉框选错成 Everyone 很容易发生）。
留空则完全依赖 Access 策略。`/healthz` 会报出这道闸开没开 ——
**安全配置不可见就等于不存在**。

## 站点监控

后台每 5 分钟探一次三个公开站点，形态参考 uptime-kuma（心跳条、重试去抖、
事件历史），实现完全不同 —— 它是常驻 Node 进程，这里是 Cron + D1。

| 监控 | 地址 | 关键字 |
|---|---|---|
| 主页 | `sakuramu.edu.kg` | `沐枫` |
| 关于页 | `about.sakuramu.edu.kg` | `沐枫` |
| 统计服务 | `tt.sakuramu.edu.kg/healthz` | `"ok":true` |

**关键字校验不是多余的。** 只看状态码抓不到「返回 200 但内容是空的」——
静态资源上传失败、构建产物为空都是这个形状，而那恰恰是最常见的故障。

### 状态机

```
up ──失败──▶ pending ──连续失败 retries+1 次──▶ down  ［开事件 + 推送］
     ▲          │                                 │
     └──成功────┘                                 └──成功──▶ up ［关事件 + 推送恢复］
```

默认 `retries=2`，即**连续 3 次失败**才判定 down，5 分钟间隔下约 10 分钟才告警。
这是刻意的：单次抖动（CDN 抽风、一次超时）不该半夜把人叫醒。

`nextState()` 是纯函数，不碰数据库也不碰网络，`tests/test_monitor.js` 把完整
状态序列跑一遍。监控系统真正的价值在于「该报的报、不该报的不报」，
而重复告警和抖动误报只在特定序列下才出现，**肉眼审不出来**。

### 两条容易踩的

**cron 调用只有 10ms CPU**，所以关键字校验只读响应体**前 64KB**。
等待网络属于 I/O 不计 CPU，真正花 CPU 的是字符串处理 —— 主页 HTML 有 57KB，
全读一遍再 `includes()` 约 1–2ms。写的时候要注意：一次 `read()` 完全可能
一口气给回整个正文，**上限必须卡在解码之前**，否则「读够就停」的循环条件
根本来不及生效，字符串已经建好了。这个 bug 是测试抓出来的。

**新注册的 Cron Trigger 大约 20 分钟后才开始真正触发。** 控制台会立刻显示
「运行 Every minute · 下次 …」，API 也查得到已注册，但那段时间里一次都不会调用。
第一次部署完先去干别的，不要以为是代码写错了。

### 调度器自己的心跳

`meta` 表存 `cron_enter` / `cron_exit`，概览页显示「上次调度是多久前」，
超过 3 分钟标红。

监控系统最糟的失败模式是**自己的调度器悄悄死了，而界面一片绿** ——
心跳停了和「一直很健康」长得几乎一样。没有这一行，那种故障完全看不出来。

### 告警

故障和恢复各推一条 Telegram。`TG_BOT_TOKEN` / `TG_CHAT_ID` 走 secret，不进仓库。

```
🔴 主页 无法访问              🟢 主页 已恢复
https://sakuramu.edu.kg/      中断 12 分钟 · 340ms
超时（>8000ms） · 8012ms       2026-09-12 18:46
2026-09-12 18:46
```

**一律用纯文本发，不带 `parse_mode`。** Markdown/HTML 模式要转义一堆字符，
而监控名和错误信息里恰好什么都可能出现；转义写错的表现是「告警发不出去」——
也就是恰恰在最需要它的时候哑掉。Telegram 会自己把裸 URL 变成可点链接，
纯文本并不损失什么。

**推送跑在 `ctx.waitUntil()` 里，而且 `sendTelegram` 永不抛异常。**
数据在推送之前就已经写完了，所以 Telegram 挂掉只是收不到通知，
监控记录照常完整。告警链路失败绝不能反过来把监控搞挂 ——
那等于「因为报警器坏了所以把消防栓也拆了」。

时间按 `Asia/Shanghai` 渲染。Worker 跑在 UTC，告警里写 UTC 时间没人看得懂。

后台概览页有「发一条测试告警」按钮。没有它，验证告警链路就只能等真出故障，
或者故意把监控指向不存在的域名 —— 而那会污染心跳记录和事件历史。

### 用量

3 个监控 × 5 分钟 = 864 次探测/天，每次写 1 行心跳 + 更新 1 行监控
≈ **1,730 行/天**，占免费档 10 万行写入的 1.7%。心跳保留 30 天，
清理语句塞在每轮的同一个 `batch` 里，不额外多一次往返。

cron 本身 1440 次/天，远低于 10 万次/天的请求配额。

## 访客统计

后台「访客」标签页：访问次数（今日 / 7 天 / 30 天 / 累计）、每日柱状图、
停留时长分位数、来源与国家、最近 50 条访问。

站点上另外还跑着 Cloudflare Web Analytics（beacon 由 Cloudflare 在边缘自动注入），
它**不提供停留时间**，两者互不相干，可以当交叉核对用。

### 隐私边界

| 记录 | 不记录 |
|---|---|
| 服务端时间戳 | **IP —— 一次都不落库，连哈希都不做** |
| 站点 + 路径 | 完整 User-Agent（只用来判断是不是爬虫，判完就丢） |
| 停留毫秒数 | 完整 referrer URL（只取主机名，查询串不出浏览器） |
| referrer 的主机名 | Cookie / localStorage / 任何持久标识 |
| 国家（`request.cf.country`） | 跨站、跨会话的任何关联 |

埋点里那个 id 只为把「离开」事件对上「进入」那一行，**在内存里、刷新即变、不落盘**，
30 天后跟着记录一起消失，不能用来识别人。埋点尊重 `doNotTrack` 和
`globalPrivacyControl`，设了就一个字节都不发。

**后台显示的是访问次数（PV），不是独立访客数（UV）。** 不写 Cookie、不存 IP
就不存在诚实的 UV 口径 —— 这是上面那些「不记录」的直接后果，不是遗漏。

### 为什么上报端点是独立的第五个 Worker

后台整域在 Access 后面，收不了公开上报；`sakuramu-notes` 的设计前提是
「根本没有写入代码」，加一条 POST 就把那句承诺作废了；两个静态站没有 `main`，
加了就从零 Worker 调用变成每次访问都计费。

所以 `sakuramu-hits` 是 `sakuramu-notes` 的镜像：那个没有写入代码，
**这个没有把数据库的行交给响应的代码**。唯一的 GET 是 `/healthz`，它只跑 `SELECT 1`。
`tests/test_hits.js` 里有几条 grep 断言钉着这个性质。

### 配额自保（不能省的那部分）

**D1 的写入配额是账号级的，而且从 2026-09-01 起超限会直接拒绝查询。**
监控的心跳和访客上报共用同一份额度 —— 上报端点公开可写，被刷爆会让**监控静默停摆**，
界面一片绿，其实早就瞎了。免费档只有 1 条限速规则（按 IP、10 秒周期），
挡得住粗暴洪水，挡不住匀速刷。所以必须有一道自设的硬上限：

- 载荷上限 1KB、字段白名单、拒绝未知字段
- `Origin` 必须**完全相等**（不能用 `startsWith` —— `sakuramu.edu.kg.evil.com` 会蒙混过关）
- **写入预算闸做成 SQL 子查询**，和 INSERT 在同一条语句里 ——
  比「先读一次再判断」少一次往返，而且计数精确没有滞后窗口。
  到顶后写 0 行，端点照常返回 204（不告诉攻击者他成功了）
- 过半时推一条 Telegram，同一天不重复
- 概览页显示「今日上报配额 N / 20000」

写入账（D1 的口径：**写入涉及被索引的列时索引也各算一行**）：

```
INSERT visits    表 1 + id 索引 1 + ts 索引 1 = 3
预算表 upsert    day 是 rowid，无二级索引      = 1
UPDATE 停留时长  两列都没索引                 = 1
预算表 upsert                                 = 1
30 天后 DELETE                                = 3
一次完整访问                                  = 9 行
```

闸设在 2 万「摄入行」≈ 3,300 次访问/天。最坏情况含清理约 3.5 万行/天，
加监控的 2,300 行，账号级的 10 万行/天还剩六成。

> 逃生舱：真撞上闸就换 Workers Analytics Engine（独立配额、不占 D1）。
> 代价是读回数据要新建一枚带 Analytics 读权限的账号级 API Token，
> 而且它只保留 3 个月 —— 「累计访问次数」会没。所以现在不用。
> 换的时候只需要改 `hits-api/src/index.mjs` 里 `insertView` / `closeVisit` 两个函数。

### 停留时间是怎么测的

**累计「可见时长」，不是墙上时间。** 标签页丢在后台八小时不该算成停留八小时。

`visibilitychange` → hidden 为主、`pagehide` 兜底。
`beforeunload`/`unload` 一概不用：移动端极不可靠，而且注册它们会让页面无法进 bfcache。
两个都监听、服务端去重 —— 不同平台各有失灵的时候，客户端判断不出自己在哪种情况里。

服务端三重幂等：`ends < 4` 封顶、`dwell_ms` 单调递增（重复或倒退的值写 0 行）、
`site` 必须对得上。close 路径**刻意不做 UPSERT** —— 它一旦能凭空造行，
就成了第二个不受 view 约束的写入入口。宁可少记，不可乱记。

> **没收到离开事件的访问，`dwell_ms` 是 `NULL`，绝不能当成 0 秒。**
> 那会把中位数直接拉垮，而那其实是浏览器崩溃、被系统杀掉、断网。
> 统计只对非 NULL 求分位数，并在界面上显示**样本覆盖率** ——
> 收不到的那批偏向崩溃和秒关，所以这个数字是偏乐观的上界，不是全体中位数。
> 覆盖率突然下滑通常意味着埋点或 CSP 出了问题。

### 一个很难查的坑

`sendBeacon` 的载荷**必须用 `text/plain`**。用 `application/json` 会让它变成
「非简单请求」，浏览器先发 OPTIONS 预检 —— 而 `pagehide` 期间预检往往跑不完，
结果是离开信标整个丢掉，**而且只在移动端丢，桌面上测不出来**。

## 共用样式

首页和关于页有 **132 行逐字相同的 CSS**，存在 `shared/base.css`，
由 `scripts/build-shared.mjs` 注入两个页面的 `base:start` / `base:end` 之间。
（同一个脚本也负责注入 `shared/beacon.js`。）
改样式改那一个文件，两边同时生效。

**为什么不是外链样式表**：站点的原则是「访客拿到的是单个自包含 HTML」——
外链会多一次阻塞渲染的请求，首屏样式也必须内联才不闪。
这里走的是和 `build-notes.mjs` 完全相同的套路：仓库里有工具，产物仍是一个文件。

**为什么只抽这 132 行**：它们是两个文件里**逐字相同的开头**，
不是散落各处的相同规则。原样放回原位，源码顺序丝毫不变 ——
CSS 靠源码顺序层叠，把散落的规则收拢成一块会悄悄改变同优先级规则的胜负。
抽完逐条比对过：两个页面的规则数、顺序、内容完全一致。

CI 里 `build-shared --check` 会盯着：改了源文件却忘了跑 `npm run shared` 就红。

## 安全响应头

`public/_headers` 与 `v2/_headers`（Workers Static Assets 原生支持，
文件本身不会被当成资源发出去）。

CSP 里留着 `'unsafe-inline'` 是没办法的事：页面的样式和脚本全部内联，
而脚本内容每次刷快照都会变，用 hash 会天天失效。即便如此这条策略仍然有价值 ——
它挡住的是「注入一个外部脚本」和「把数据 POST 到任意域名」，
那才是静态站最现实的两种攻击面。`connect-src` 按每个页面实际用到的来源写，多一个都不给。

> 第一版 CSP 把 Cloudflare Web Analytics 的 beacon 挡掉了 ——
> 它是 Cloudflare 在边缘自动注入的，不在 HTML 源码里，所以看源码发现不了。
> 改 CSP 之后一定要开一个**全新标签页**实测：控制台的报错缓冲区不随刷新清空，
> 你会盯着旧指令的报错以为没修好。

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

两种写法，同一套渲染器，产出逐字一致。

### 在网页上写（推荐）

后台 → 手记 → 写一篇新的。左边 Markdown，右边实时预览，写完点「发布」。
关于页最多一分钟后自动更新，不用部署。

预览走服务端的 `/v1/preview`，调的是和发布**完全相同**的 `render()`，
而不是在浏览器里另写一份 —— 「预览好好的，发出去不一样」是这类编辑器
最常见也最难查的问题。

### 在本地写

往 `v2/notes/` 放一个 `.md` 文件，然后 `npm run deploy:about`。

```markdown
---
title: 标题
date: 2026-09-11
---

正文……
```

### 两者怎么合起来

`npm run notes` 会把**本地 `.md`** 和**后台已发布的文章**合并后烧录进
`v2/index.html`，同 slug 以远端为准。关于页加载时再从
`notes.sakuramu.edu.kg/notes.json` 拉一次覆盖。

**为什么两份都要有：** 页面里那份 HTML 是兜底，手记服务不可达时访客看到的就是它。
只存在于运行时的文章一旦服务挂掉就整篇消失 —— 而那恰恰是最需要兜底的时刻。
拉取失败、载荷版本不认识、结构不合法，全部静默回落，访客看不出区别。

CI 里用 `--no-remote` 跑：不该依赖外网，而且远端已发布的文章本来就不在仓库里。

### 为什么公开接口是独立的一个 Worker

Cloudflare Access 按域名整域拦截，`admin.sakuramu.edu.kg` 上开不出公开路径。
唯一的办法是给 Access 配 Bypass —— 而那正是「以后被手滑打开的口子」。

所以换成物理隔离：`sakuramu-notes` 里**根本没有写入代码**，也没有后台的任何逻辑。
它不是靠一个 `if` 拦着不许写，是压根不会写。只认 `GET /notes.json` 一条路径，
其余一律 404。

它刻意**不用 `caches.default`**：这个查询只有几行，边缘缓存省不下什么，
却换来两个很难推理的问题 —— 缓存条目跨部署存活（部署完还在发旧代码的响应），
以及发了文章要等整个 TTL 才可见。保留 ETag + 60 秒 max-age 就够了。

### 手记的 HTML 永远由服务端生成

接口只收 Markdown，`html` 是未知字段会被**明确拒绝**。
存客户端提交的 HTML 等于把转义的责任交给浏览器端，
那条链上任何一环失守都是自己域名上的存储型 XSS。

信任链是「Access 会话 → 服务端 render（转义 + 协议白名单）→ D1 → 公开只读」。
`tests/test_noteapi.js` 有断言钉着这条性质 —— 靠代码审查守不住。


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
admin/src/          后台 Worker（路由、鉴权、探测、告警、手记校验、建表）
admin/ui/index.html 后台界面（自包含，复用站点的设计令牌）
notes-api/src/      手记的公开只读 Worker（只有一条 GET 路径）
hits-api/src/       访客上报的只写 Worker（只有一条 POST 路径）
shared/base.css     首页与关于页共用的那段样式（由 build-shared 注入两边）
shared/beacon.js    访客埋点（同上）
shared/             发版脚本与 Worker 共用的纯函数
scripts/            发版脚本
tests/              零依赖回归测试
```
