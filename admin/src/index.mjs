// sakuramu-admin —— 管理后台 Worker。
//
// 三个站点各自独立，这个崩了主页毫发无损：
//   sakuramu.edu.kg        restless-mountain-3c35   纯静态，无 main，零 Worker 调用
//   about.sakuramu.edu.kg  sakuramu-home-v2         纯静态，无 main
//   admin.sakuramu.edu.kg  sakuramu-admin           ← 这里，main + D1 + cron
//
// 鉴权全靠 Cloudflare Access（见 access.mjs）。这个 Worker 自己不存密码、
// 不发会话、不碰 Cookie —— 没写的代码不会有洞。

import { verifyAccess, accessConfig } from './access.mjs'
import {
  isDue, nextState, probe, uptime, validateMonitor, MONITOR_DEFAULTS, HB_RETAIN_MS,
} from './monitor.mjs'
import { notifyAll, sendTelegram, formatEvent } from './notify.mjs'
import { validateNote, validSlug, suggestSlug } from './notes.mjs'
import {
  VISIT_RETAIN_MS, HIT_CAP, dayNum, dayToISO, summarizeDwell, fillDays, shouldAlert,
} from './hits.mjs'
// 与发版脚本共用同一份渲染器 —— 后台预览、后台发布、发版烧录
// 三处输出必须逐字一致，各写一份迟早会分叉，
// 而分叉的表现是「预览好好的，发出去不一样」。
import { render } from '../../shared/notes-render.mjs'

// 后台是这个账号上权限最高的一个面，安全响应头在这里最值。
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',   // 后台是按人鉴权的，一律不进缓存
      ...SECURITY_HEADERS, ...extra,
    },
  })

/**
 * 所有 /v1/* 的闸门。
 *
 * 没配 Access 时返回 503 而不是放行 —— 这是整个文件里最要紧的一个选择。
 * 「配置缺失就跳过校验」是后台被一路裸奔到公网上的最常见死法：
 * 配置丢了没人会发现，因为一切看起来都正常工作。
 */
async function gate(request, env) {
  const v = await verifyAccess(request, env)
  if (v.ok) return { identity: v }
  if (v.why === 'not_configured') {
    return { denied: json({ error: 'access_not_configured',
      detail: '这个 Worker 还没拿到 ACCESS_TEAM_DOMAIN / ACCESS_AUD，写接口一律拒绝。' }, 503) }
  }
  console.log('access denied: ' + v.why)     // 对外只说「不行」，不说为什么不行
  return { denied: json({ error: 'forbidden' }, 403) }
}

const MONITOR_COLS = `id,name,url,interval_s,timeout_ms,expect_status,expect_keyword,
                      retries,enabled,last_check_at,state,fail_streak,last_ms,last_code,
                      last_error,created_at`

// ══════════════════════════════════════════════════════════
// 定时探测
// ══════════════════════════════════════════════════════════

/**
 * 跑一轮探测。cron 每分钟触发，但只处理「到点了的」监控 ——
 * 一个触发器服务多种间隔，因为每账号只有 5 个触发器，
 * 不可能一个监控占一个。
 *
 * 到点判断放在 JS 里而不是 SQL 里，是为了让 isDue 只有一份实现、
 * 而且能脱离数据库单测。代价是每分钟把启用的监控行读一遍：
 * 50 个监控也才 7.2 万行读/天，占免费档 500 万的 1.4%。
 */
export async function runCycle(env, now = Date.now()) {
  const { results } = await env.DB
    .prepare(`SELECT ${MONITOR_COLS} FROM monitors WHERE enabled=1`).all()

  const due = (results || []).filter(m => isDue(m, now))
  if (!due.length) return { checked: 0, events: [] }

  // 每个 probe 自带超时且自己 catch，所以 Promise.all 不会因为
  // 单个 reject 把其余监控的结果一起丢掉。
  const probes = await Promise.all(due.map(m => probe(m, now)))
  const byId = new Map(due.map(m => [m.id, m]))
  const decisions = probes.map(p => {
    const m = byId.get(p.id)
    return { p, m, ns: nextState(m, p.ok) }
  })

  // 恢复通知要写「中断了多久」，就得知道故障是什么时候开始的。
  // 只在真的有监控恢复时才查这一次，平时一条额外查询都不会发。
  const recovering = decisions.filter(d => d.ns.event === 'recovered').map(d => d.m.id)
  let downSince = new Map()
  if (recovering.length) {
    const q = await env.DB.prepare(
      `SELECT monitor_id, MIN(started_at) AS started_at FROM incidents
        WHERE resolved_at IS NULL AND monitor_id IN (${recovering.map(() => '?').join(',')})
        GROUP BY monitor_id`
    ).bind(...recovering).all()
    downSince = new Map((q.results || []).map(r => [r.monitor_id, r.started_at]))
  }

  const stmts = []
  const events = []
  for (const { p, m, ns } of decisions) {
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO heartbeats (monitor_id,ts,ok,ms,code,err) VALUES (?,?,?,?,?,?)`
    ).bind(m.id, p.ts, p.ok ? 1 : 0, p.ms, p.code, p.err))

    stmts.push(env.DB.prepare(
      `UPDATE monitors SET last_check_at=?,state=?,fail_streak=?,last_ms=?,last_code=?,last_error=?
        WHERE id=?`
    ).bind(p.ts, ns.state, ns.fail_streak, p.ms, p.code, p.err, m.id))

    if (ns.event === 'down') {
      stmts.push(env.DB.prepare(
        `INSERT INTO incidents (monitor_id,started_at,cause) VALUES (?,?,?)`
      ).bind(m.id, p.ts, p.err))
      events.push({ kind: 'down', monitor: m, probe: p })
    } else if (ns.event === 'recovered') {
      // 关掉这个监控名下所有还开着的事件，顺带收拾历史遗留的孤儿
      stmts.push(env.DB.prepare(
        `UPDATE incidents SET resolved_at=? WHERE monitor_id=? AND resolved_at IS NULL`
      ).bind(p.ts, m.id))
      events.push({ kind: 'recovered', monitor: m, probe: p, downSince: downSince.get(m.id) || null })
    }
  }

  // 心跳保留 30 天。塞进同一个 batch，不额外多一次往返；
  // 没有过期行时它写 0 行，几乎不花配额。
  // 这条必须现在就写进来，不能「以后再说」—— heartbeats 无限增长会吃满 5GB。
  stmts.push(env.DB.prepare(`DELETE FROM heartbeats WHERE ts < ?`).bind(now - HB_RETAIN_MS))
  // 访客原始记录同样 30 天。日汇总表不清 —— 累计访问量不该跟着归零。
  stmts.push(env.DB.prepare(`DELETE FROM visits WHERE ts < ?`).bind(now - VISIT_RETAIN_MS))

  await env.DB.batch(stmts)
  return { checked: due.length, events }
}

/**
 * 把原始访问记录聚合进日汇总表。
 *
 * 今天和昨天各算一遍：离开事件可能迟到（用户切后台很久才回来），
 * 只算今天会让昨天的时长统计永远缺一块。
 * 整段重算而不是增量累加 —— 幂等，跑多少遍结果都一样。
 */
async function rollupVisits(env, now, ctx) {
  const DAY = 86400_000
  const stmts = []
  for (const d of [dayNum(now), dayNum(now) - 1]) {
    // 日序号转回时间窗：day 是按北京时区切的，这里要还原成 UTC 毫秒区间
    const start = d * DAY - 8 * 3600_000
    stmts.push(env.DB.prepare(
      `INSERT INTO visit_daily (day,site,views,ended,dwell_sum,dwell_n)
       SELECT ?1, site, COUNT(*), COUNT(dwell_ms), COALESCE(SUM(dwell_ms),0), COUNT(dwell_ms)
         FROM visits WHERE ts>=?2 AND ts<?3 GROUP BY site
       ON CONFLICT(day,site) DO UPDATE SET
         views=excluded.views, ended=excluded.ended,
         dwell_sum=excluded.dwell_sum, dwell_n=excluded.dwell_n`
    ).bind(d, start, start + DAY))
  }
  await env.DB.batch(stmts)

  // 预算过半时提醒一次。同一天不重复 ——
  // 重复告警在这个仓库里是明确当缺陷处理的（见 monitor.mjs 的 nextState）。
  const today = dayNum(now)
  const [b, mark] = await env.DB.batch([
    env.DB.prepare(`SELECT rows_written FROM visit_budget WHERE day=?`).bind(today),
    env.DB.prepare(`SELECT v FROM meta WHERE k='hits_alert_day'`),
  ])
  const used = (b.results || [])[0]?.rows_written ?? 0
  const last = Number((mark.results || [])[0]?.v ?? NaN)
  if (shouldAlert(used, HIT_CAP, last, today)) {
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k,v,at) VALUES ('hits_alert_day',?,?)`)
      .bind(String(today), now).run()
    // 推送放 waitUntil，且 sendTelegram 永不抛 —— 告警失败不能反过来搞挂 cron
    ctx.waitUntil(sendTelegram(env,
      '⚠️ 访客上报写入量已过半\n'
      + `今日 ${used} / ${HIT_CAP} 行\n`
      + '到顶后上报会停止写库，监控不受影响。'))
  }
}

// ══════════════════════════════════════════════════════════
// 接口
// ══════════════════════════════════════════════════════════

async function listMonitors(env, now) {
  const [mons, beats, day] = await Promise.all([
    env.DB.prepare(`SELECT ${MONITOR_COLS} FROM monitors ORDER BY id`).all(),
    // 每个监控取最近 60 个心跳画心跳条。用窗口函数一次取回，
    // 免得监控数量一多就变成 N+1 次查询。
    env.DB.prepare(`
      SELECT monitor_id, ts, ok, ms, code, err FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY monitor_id ORDER BY ts DESC) rn
          FROM heartbeats
      ) WHERE rn <= 60 ORDER BY monitor_id, ts`).all(),
    env.DB.prepare(
      `SELECT monitor_id, COUNT(*) n, SUM(ok) up FROM heartbeats WHERE ts > ? GROUP BY monitor_id`
    ).bind(now - 86400_000).all(),
  ])

  const byMon = new Map()
  for (const b of beats.results || []) {
    if (!byMon.has(b.monitor_id)) byMon.set(b.monitor_id, [])
    byMon.get(b.monitor_id).push(b)
  }
  const day24 = new Map((day.results || []).map(r => [r.monitor_id, r]))

  return (mons.results || []).map(m => {
    const hb = byMon.get(m.id) || []
    const d = day24.get(m.id)
    return {
      ...m,
      heartbeats: hb,
      uptime_window: uptime(hb),
      uptime_24h: d && d.n ? d.up / d.n : null,
      checks_24h: d ? d.n : 0,
    }
  })
}

async function handleV1(request, env, ctx, url, identity) {
  const path = url.pathname
  const method = request.method
  const now = Date.now()

  if (path === '/v1/whoami' && method === 'GET') {
    return json({ email: identity.email, sub: identity.sub })
  }

  if (path === '/v1/monitors' && method === 'GET') {
    const [monitors, meta] = await Promise.all([
      listMonitors(env, now),
      env.DB.prepare(`SELECT k,v,at FROM meta WHERE k IN ('cron_enter','cron_exit')`).all(),
    ])
    // 把调度器自身的状态一并带出来。心跳停了和「一直很健康」在界面上
    // 长得几乎一样，所以「上次调度是什么时候」必须能看见。
    const m = Object.fromEntries((meta.results || []).map(r => [r.k, r]))
    return json({
      now, monitors,
      cron: {
        last_run_at: m.cron_exit?.at ?? null,
        last_result: m.cron_exit?.v ?? null,
        last_enter_at: m.cron_enter?.at ?? null,
      },
    })
  }

  if (path === '/v1/monitors' && method === 'POST') {
    const body = await readJSON(request)
    if (body === null) return json({ error: 'bad_json' }, 400)
    const v = validateMonitor(body)
    if (!v.ok) return json({ error: 'invalid', detail: v.errors }, 400)
    const m = { ...MONITOR_DEFAULTS, ...v.value }
    const r = await env.DB.prepare(
      `INSERT INTO monitors (name,url,interval_s,timeout_ms,expect_status,expect_keyword,
                             retries,enabled,created_at)
       VALUES (?,?,?,?,?,?,?,?,?) RETURNING ${MONITOR_COLS}`
    ).bind(m.name, m.url, m.interval_s, m.timeout_ms, m.expect_status,
           m.expect_keyword, m.retries, m.enabled, now).first()
    return json(r, 201)
  }

  const one = path.match(/^\/v1\/monitors\/(\d+)$/)
  if (one) {
    const id = Number(one[1])
    if (method === 'PATCH') {
      const body = await readJSON(request)
      if (body === null) return json({ error: 'bad_json' }, 400)
      const v = validateMonitor(body, { partial: true })
      if (!v.ok) return json({ error: 'invalid', detail: v.errors }, 400)
      // 字段名来自 FIELDS 白名单，不可能是用户输入的任意串，拼进 SQL 是安全的；
      // 值仍然全部走绑定参数。
      const sets = Object.keys(v.value).map(k => `${k}=?`).join(',')
      const r = await env.DB.prepare(
        `UPDATE monitors SET ${sets} WHERE id=? RETURNING ${MONITOR_COLS}`
      ).bind(...Object.values(v.value), id).first()
      return r ? json(r) : json({ error: 'not_found' }, 404)
    }
    if (method === 'DELETE') {
      const r = await env.DB.batch([
        env.DB.prepare(`DELETE FROM heartbeats WHERE monitor_id=?`).bind(id),
        env.DB.prepare(`DELETE FROM incidents  WHERE monitor_id=?`).bind(id),
        env.DB.prepare(`DELETE FROM monitors   WHERE id=?`).bind(id),
      ])
      const gone = r[2]?.meta?.changes > 0
      return gone ? json({ deleted: id }) : json({ error: 'not_found' }, 404)
    }
  }

  // 立刻探一次，不等下一个周期 —— 改完配置想马上知道对不对
  const chk = path.match(/^\/v1\/monitors\/(\d+)\/check$/)
  if (chk && method === 'POST') {
    const m = await env.DB.prepare(`SELECT ${MONITOR_COLS} FROM monitors WHERE id=?`)
      .bind(Number(chk[1])).first()
    if (!m) return json({ error: 'not_found' }, 404)
    // 只探不写库：手动点一下不该影响 fail_streak，更不该触发告警
    return json({ dry_run: true, result: await probe(m, Date.now()) })
  }

  if (path === '/v1/visits' && method === 'GET') {
    const today = dayNum(now)
    const from = today - 29
    const winStart = now - 7 * 86400_000      // 来源/国家/时长统计看最近 7 天

    const [daily, total, dwells, recent, refs, countries, budget] = await env.DB.batch([
      // 次数类一律查日汇总（30 行），不扫原始表 —— 后台是会被反复打开的，
      // 每次扫几万行会把 500 万行/天的读配额烧掉。
      env.DB.prepare(`SELECT day,site,views,ended FROM visit_daily WHERE day>=? ORDER BY day`).bind(from),
      env.DB.prepare(`SELECT COALESCE(SUM(views),0) AS all_time FROM visit_daily`),
      // 时长要算分位数，必须拿到原始值。LIMIT 是保险丝。
      env.DB.prepare(
        `SELECT dwell_ms FROM visits WHERE ts>=? AND dwell_ms IS NOT NULL
          ORDER BY dwell_ms LIMIT 5000`).bind(winStart),
      env.DB.prepare(
        `SELECT ts,site,path,ref,country,dwell_ms FROM visits ORDER BY ts DESC LIMIT 50`),
      env.DB.prepare(
        `SELECT COALESCE(NULLIF(ref,''),'(直接访问)') AS src, COUNT(*) AS n
           FROM visits WHERE ts>=? GROUP BY src ORDER BY n DESC LIMIT 12`).bind(winStart),
      env.DB.prepare(
        `SELECT COALESCE(country,'(未知)') AS c, COUNT(*) AS n
           FROM visits WHERE ts>=? GROUP BY c ORDER BY n DESC LIMIT 12`).bind(winStart),
      env.DB.prepare(`SELECT rows_written FROM visit_budget WHERE day=?`).bind(today),
    ])

    const rows = daily.results || []
    const bySite = {}
    for (const r of rows) {
      (bySite[r.site] = bySite[r.site] || []).push({ day: r.day, views: r.views })
    }
    const sum = (f) => rows.filter(f).reduce((a, r) => a + r.views, 0)
    const win = (d) => sum(r => r.day > today - d)
    const views7 = win(7)
    const ended7 = rows.filter(r => r.day > today - 7).reduce((a, r) => a + r.ended, 0)

    return json({
      now,
      today: { day: today, iso: dayToISO(today), views: sum(r => r.day === today) },
      views_7d: views7,
      views_30d: win(30),
      all_time: (total.results || [])[0]?.all_time ?? 0,
      // 每个站一条 30 天的柱子，中间没人来的日子补 0 ——
      // 不补的话柱子会挤在一起，看上去像「天天有人来」
      daily: Object.fromEntries(Object.entries(bySite)
        .map(([site, rs]) => [site, fillDays(rs, from, today)])),
      // 只对收到离开事件的那部分算分位数，同时报出覆盖率。
      // 收不到的那批偏向崩溃和秒关，所以这是个偏乐观的上界，不是全体中位数。
      dwell: summarizeDwell((dwells.results || []).map(r => r.dwell_ms), views7),
      dwell_window_days: 7,
      recent: recent.results || [],
      refs: refs.results || [],
      countries: countries.results || [],
      budget: { used: (budget.results || [])[0]?.rows_written ?? 0, cap: HIT_CAP },
    })
  }

  // ── 手记 ───────────────────────────────────────────────

  // 预览走和发布完全相同的 render()，而不是在浏览器里另写一份。
  // 预览与实际产出不一致是这类编辑器最常见也最难查的问题。
  if (path === '/v1/preview' && method === 'POST') {
    const body = await readJSON(request)
    if (body === null || typeof body.md !== 'string') return json({ error: 'bad_json' }, 400)
    if (body.md.length > 200_000) return json({ error: 'too_long' }, 413)
    return json({ html: render(body.md) })
  }

  if (path === '/v1/notes' && method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT slug,title,date,published,created_at,updated_at,length(md) AS md_len
         FROM notes ORDER BY date DESC, slug`).all()
    return json({ notes: r.results || [] })
  }

  const noteOne = path.match(/^\/v1\/notes\/([^/]+)$/)
  if (noteOne) {
    const slug = decodeURIComponent(noteOne[1])
    if (!validSlug(slug)) return json({ error: 'bad_slug' }, 400)

    if (method === 'GET') {
      const r = await env.DB.prepare(`SELECT * FROM notes WHERE slug=?`).bind(slug).first()
      return r ? json(r) : json({ error: 'not_found' }, 404)
    }

    // PUT 是新建或整篇覆盖。html 永远由服务端生成：
    // 存客户端提交的 HTML 等于把转义的责任交给浏览器端，
    // 那条链上任何一环失守都是自己域名上的存储型 XSS。
    if (method === 'PUT') {
      const body = await readJSON(request)
      if (body === null) return json({ error: 'bad_json' }, 400)
      const v = validateNote(body)
      if (!v.ok) return json({ error: 'invalid', detail: v.errors }, 400)
      const html = render(v.value.md)
      const pub = v.value.published ?? 0
      const r = await env.DB.prepare(
        `INSERT INTO notes (slug,title,date,md,html,published,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?7)
         ON CONFLICT(slug) DO UPDATE SET
           title=?2, date=?3, md=?4, html=?5, published=?6, updated_at=?7
         RETURNING slug,title,date,published,created_at,updated_at`
      ).bind(slug, v.value.title, v.value.date, v.value.md, html, pub, now).first()
      return json(r)
    }

    if (method === 'PATCH') {
      const body = await readJSON(request)
      if (body === null) return json({ error: 'bad_json' }, 400)
      const v = validateNote(body, { partial: true })
      if (!v.ok) return json({ error: 'invalid', detail: v.errors }, 400)
      const cols = { ...v.value }
      if ('md' in cols) cols.html = render(cols.md)   // 改了正文就重渲染，绝不让两者脱节
      cols.updated_at = now
      const sets = Object.keys(cols).map(k => `${k}=?`).join(',')
      const r = await env.DB.prepare(
        `UPDATE notes SET ${sets} WHERE slug=?
         RETURNING slug,title,date,published,created_at,updated_at`
      ).bind(...Object.values(cols), slug).first()
      return r ? json(r) : json({ error: 'not_found' }, 404)
    }

    if (method === 'DELETE') {
      const r = await env.DB.prepare(`DELETE FROM notes WHERE slug=?`).bind(slug).run()
      return r.meta?.changes > 0 ? json({ deleted: slug }) : json({ error: 'not_found' }, 404)
    }
  }

  if (path === '/v1/slug' && method === 'POST') {
    const body = await readJSON(request)
    return json({ slug: suggestSlug(body && body.title) })
  }

  // 发一条测试告警。没有它，验证告警链路就只能等真出故障，
  // 或者故意把监控指向不存在的域名 —— 而那会污染心跳记录和事件历史。
  if (path === '/v1/notify/test' && method === 'POST') {
    const r = await sendTelegram(env,
      '🔧 沐枫站点监控 · 测试消息\n'
      + '看到这条说明告警链路是通的。\n'
      + new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC')
    return r.ok ? json({ sent: true })
                : json({ sent: false, why: r.why }, r.why === 'not_configured' ? 503 : 502)
  }

  if (path === '/v1/incidents' && method === 'GET') {
    const r = await env.DB.prepare(`
      SELECT i.id, i.monitor_id, m.name AS monitor_name, i.started_at, i.resolved_at, i.cause
        FROM incidents i LEFT JOIN monitors m ON m.id = i.monitor_id
       ORDER BY i.started_at DESC LIMIT 100`).all()
    return json({ incidents: r.results || [] })
  }

  return json({ error: 'not_found' }, 404)
}

async function readJSON(request) {
  try { return await request.json() } catch { return null }
}

// ══════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    // ── 公开：存活探测 ──────────────────────────────────
    // 配好 Access 之后这条路也会被 Access 挡在外面（Access 按域名整域拦），
    // 所以它只在部署验证时有用。不要为它开 Access 的 Bypass ——
    // 那正是 access.mjs 顶上说的「将来手滑开的那个口子」。
    if (path === '/healthz') {
      let db = 'unknown'
      try {
        await env.DB.prepare('SELECT 1').first()
        db = 'ok'
      } catch (e) {
        db = 'error'
        console.log('healthz db: ' + (e && e.message))
      }
      return json({
        ok: db === 'ok',
        db,
        access: accessConfig(env) ? 'configured' : 'not_configured',
        // 把第二道闸开没开也报出来 —— 安全配置不可见就等于不存在，
        // 没人会去猜一个静默生效的白名单到底有没有生效。
        email_allowlist: String(env.ACCESS_ALLOWED_EMAILS || '').trim() ? 'on' : 'off',
        now: new Date().toISOString(),
      }, db === 'ok' ? 200 : 503)
    }

    if (path.startsWith('/v1/')) {
      const g = await gate(request, env)
      if (g.denied) return g.denied
      try {
        return await handleV1(request, env, ctx, url, g.identity)
      } catch (e) {
        console.log('v1 error: ' + (e && e.stack || e))
        return json({ error: 'internal' }, 500)
      }
    }

    // ── 其余交给静态资源 ───────────────────────────────
    const res = await env.ASSETS.fetch(request)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
    out.headers.set('cache-control', 'no-store')
    return out
  },

  async scheduled(event, env, ctx) {
    const t0 = Date.now()
    // 先打点，再干活。
    // 监控系统最糟的失败模式是「自己的调度器悄悄死了，界面还一片绿」——
    // 心跳停了看起来和「一直很健康」几乎一样。这一行让「cron 上次跑完是
    // 什么时候」变成可查的事实，同时也把「没触发」和「触发了但挂了」分开。
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO meta (k,v,at) VALUES ('cron_enter',?,?)`)
        .bind(String(event?.cron || '?'), t0).run()
    } catch (e) {
      console.log('cron 打点失败: ' + (e && e.message))
    }

    let note = 'ok'
    try {
      const r = await runCycle(env, t0)
      note = `checked=${r.checked} events=${r.events.length}`
      if (r.checked) console.log('cron: ' + note)

      // 推送放 waitUntil 里，且 notifyAll 自己永不抛异常。
      // 告警链路失败绝不能反过来把监控搞挂 ——
      // 那等于「因为报警器坏了所以把消防栓也拆了」。
      // 数据已经在上面写完了，推送成不成功都不影响记录的完整性。
      if (r.events.length) ctx.waitUntil(notifyAll(env, r.events))
    } catch (e) {
      note = 'error: ' + String(e && e.message || e).slice(0, 300)
      console.log('cron error: ' + (e && e.stack || e))
    }

    // 日汇总 + 预算告警。约每 10 分钟跑一次 ——
    // 每分钟重算会写 5,760 行/天，为了一个几乎不变的数字花掉 6% 的写入配额不值。
    // 重算是幂等的（从原始表整段重新聚合），偶尔跳过一轮没有影响。
    if (new Date(t0).getUTCMinutes() % 10 === 0) {
      try { await rollupVisits(env, t0, ctx) }
      catch (e) { console.log('rollup error: ' + (e && e.message)) }
    }

    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO meta (k,v,at) VALUES ('cron_exit',?,?)`)
        .bind(note + ` (${Date.now() - t0}ms)`, Date.now()).run()
    } catch { /* 打点失败不该影响任何事 */ }
  },
}
