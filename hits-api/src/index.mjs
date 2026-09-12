// 访客上报的只写接口 —— hits.sakuramu.edu.kg/e
//
// 这个文件是 notes-api/src/index.mjs 的镜像：那个「根本没有写入代码」，
// 这个**根本没有把数据库的行交给响应的代码**。唯一的 GET 是 /healthz，
// 它只跑 SELECT 1。不是靠一个 if 拦着不许读，是压根没写查询。
// tests/test_hits.js 里有几条 grep 断言钉着这个性质。
//
// 为什么不能放在别的 Worker 上：
//   · admin  整域在 Cloudflare Access 后面，物理上收不了公开上报
//   · notes  它的设计前提就是「没有写入代码」，加一条 POST 就作废了
//   · 两个静态站  都没有 main，加了就从零 Worker 调用变成每次访问都计费
//
// 它挂了站点毫发无损 —— 页面那边的上报是 fire-and-forget，失败静默。

import {
  MAX_BODY, MAX_ENDS, HIT_CAP, ROWS_PER_VIEW, ROWS_PER_END, SITES,
  siteOf, validateHit, refHost, looksLikeBot, dayNum,
} from '../../admin/src/hits.mjs'

const CORS_BASE = {
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
  vary: 'Origin',
  // 刻意没有 access-control-allow-credentials ——
  // 这个端点不认 Cookie，加上它等于给一个不需要凭据的接口开一扇门。
}

// 回声式 CORS：只对白名单里的 Origin 回显，不用 *。
function cors(origin) {
  return Object.hasOwn(SITES, origin)
    ? { ...CORS_BASE, 'access-control-allow-origin': origin }
    : CORS_BASE
}

// 一律 204 空响应，连「为什么没收」都不说。这是个公开端点，
// 把校验细节告诉调用方只是在帮人调试怎么刷它。
// 配额到顶也返回 204 —— 不告诉攻击者他成功了。页面那边也不看返回值。
const done = (origin) => new Response(null, {
  status: 204, headers: { ...cors(origin), 'x-content-type-options': 'nosniff' },
})

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') || ''

    // 唯一的 GET：存活探测。只跑 SELECT 1，不碰 visits / visit_daily 任何一行。
    // 有了它，上报端点自己也能被后台的监控盯着 —— 否则它静默挂掉没人知道。
    if (url.pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
      let db = 'unknown'
      try { await env.DB.prepare('SELECT 1').first(); db = 'ok' }
      catch (e) { db = 'error'; console.log('healthz db: ' + (e && e.message)) }
      return new Response(JSON.stringify({ ok: db === 'ok', db }) + '\n', {
        status: db === 'ok' ? 200 : 503,
        headers: { 'content-type': 'application/json; charset=utf-8',
                   'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      })
    }

    if (request.method === 'OPTIONS' && url.pathname === '/e') return done(origin)

    // 只认这一条路径、这一种方法。其余一律 404 —— 没有第二条路可走。
    // 特别地：没有 GET /e，所以没法用 <img src> 之类的方式跨站灌数据。
    if (url.pathname !== '/e' || request.method !== 'POST') {
      return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain' } })
    }

    // Origin 必须完全相等。site 由此推导，不从载荷取 ——
    // 浏览器强制带 Origin 且页面 JS 改不了它，这是少数客户端伪造不了的东西。
    const site = siteOf(origin)
    if (!site) return done(origin)

    // 先看头再决定要不要读 body，别为一个 10MB 的垃圾载荷付读取成本
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return done(origin)

    let body
    try {
      const text = await request.text()
      if (text.length > MAX_BODY) return done(origin)
      body = JSON.parse(text)
    } catch { return done(origin) }

    const v = validateHit(body)
    if (!v.ok) { console.log('hit rejected: ' + v.why); return done(origin) }

    // UA 只用来做一个布尔判断，**绝不写进数据库** ——
    // 存 UA 就等于在一个承诺「不存 UA」的表里存了 UA。
    if (looksLikeBot(request.headers.get('user-agent'))) return done(origin)

    const now = Date.now()
    const day = dayNum(now)
    try {
      if (v.value.t === 'view') await insertView(env, v.value, { now, day, site, request })
      else await closeVisit(env, v.value, { day, site })
    } catch (e) {
      console.log('hit write failed: ' + (e && e.message))
    }
    return done(origin)
  },
}

// ── 下面两个函数是唯一碰数据库的地方 ────────────────────────
// 将来若要把 sink 换掉（比如搬去 Analytics Engine），只动这两处。

/**
 * 写一条访问。配额闸做成 SQL 子查询 ——
 * 比「先读一次再判断」少一次往返，而且计数是精确的，没有滞后窗口。
 * 到顶之后两条语句都写 0 行，端点照常返回 204。
 */
async function insertView(env, val, ctx) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO visits (id,ts,site,path,ref,country,dwell_ms,ends)
       SELECT ?1,?2,?3,?4,?5,?6,NULL,0
        WHERE COALESCE((SELECT rows_written FROM visit_budget WHERE day=?7),0) < ?8`
    ).bind(val.id, ctx.now, ctx.site, val.p, refHost(val.r) || null,
           (ctx.request.cf && ctx.request.cf.country) || null, ctx.day, HIT_CAP),
    env.DB.prepare(
      `INSERT INTO visit_budget (day, rows_written) VALUES (?1, ?2)
       ON CONFLICT(day) DO UPDATE SET rows_written = rows_written + ?2
        WHERE rows_written < ?3`
    ).bind(ctx.day, ROWS_PER_VIEW, HIT_CAP),
  ])
}

/**
 * 回填停留时长。
 *
 * 三重幂等：
 *   · ends < MAX_ENDS      —— 反复切标签页不能变成无限次写入
 *   · dwell_ms < 新值       —— 重复上报或倒退的值写 0 行（单调递增）
 *   · site 必须对得上       —— 不能拿 A 站的 id 去改 B 站的记录
 *
 * 刻意**不做 UPSERT**：只更新已存在的行。close 路径一旦能凭空造行，
 * 它就成了第二个不受 view 约束的写入入口。宁可少记，不可乱记。
 * 所以只有真的改到了行才记账（分两次往返）——
 * 乱猜 id 的 close 写 0 行、不占预算、不污染汇总。
 * close 是 sendBeacon 发的、没人读响应，多一次往返没有可感知的代价。
 */
async function closeVisit(env, val, ctx) {
  const r = await env.DB.prepare(
    `UPDATE visits SET dwell_ms=?1, ends=ends+1
      WHERE id=?2 AND site=?3 AND ends<?4
        AND (dwell_ms IS NULL OR dwell_ms < ?1)
        AND COALESCE((SELECT rows_written FROM visit_budget WHERE day=?5),0) < ?6`
  ).bind(val.d, val.id, ctx.site, MAX_ENDS, ctx.day, HIT_CAP).run()

  if (r.meta && r.meta.changes > 0) {
    await env.DB.prepare(
      `INSERT INTO visit_budget (day, rows_written) VALUES (?1, ?2)
       ON CONFLICT(day) DO UPDATE SET rows_written = rows_written + ?2`
    ).bind(ctx.day, ROWS_PER_END).run()
  }
}
