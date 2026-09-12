// 站点探测与状态机。
//
// 刻意把「纯函数」和「有副作用的部分」分开：
// nextState / isDue / verdict 不碰数据库、不碰网络，可以直接单测；
// probe 只负责发请求，把结果翻译成一个普通对象。
// 监控这类东西最难验的就是状态迁移，而它恰恰是最容易写错的一块。

export const MAX_BODY = 65536      // 关键字校验最多读 64KB，见下面的说明
export const HB_RETAIN_MS = 30 * 86400_000   // 心跳保留 30 天

// ── 纯函数 ────────────────────────────────────────────────

/** 到点了没。从没查过的（last_check_at 为 NULL）算到点。 */
export function isDue(m, now) {
  if (!m.enabled) return false
  if (m.last_check_at == null) return true
  return now - m.last_check_at >= m.interval_s * 1000
}

/**
 * 把一次 HTTP 响应判成成功或失败。
 * expect_status 为空时接受 2xx/3xx —— 3xx 也算活着，重定向不是故障。
 */
export function verdict(m, { status, bodyHead }) {
  if (m.expect_status != null) {
    if (status !== m.expect_status) return { ok: false, err: `期望 ${m.expect_status}，实际 ${status}` }
  } else if (status < 200 || status >= 400) {
    return { ok: false, err: `HTTP ${status}` }
  }
  if (m.expect_keyword) {
    if (!bodyHead || !bodyHead.includes(m.expect_keyword)) {
      return { ok: false, err: `响应里找不到「${m.expect_keyword}」` }
    }
  }
  return { ok: true, err: null }
}

/**
 * 状态机。
 *
 *   up ──失败──▶ pending ──连续失败 retries+1 次──▶ down  ［开事件 + 推送］
 *        ▲          │                                 │
 *        └──成功────┘                                 └──成功──▶ up ［关事件 + 推送恢复］
 *
 * 默认 retries=2，即连续 3 次失败才判 down。5 分钟间隔下约 10 分钟才告警 ——
 * 这是刻意的：单次抖动（CDN 抽风、一次超时）不该半夜把人叫醒。
 *
 * event 只在「真正跨越边界」时非空，所以重复告警不会发生：
 * 已经 down 的继续失败不再报 down，从没 down 过的恢复也不报恢复。
 */
export function nextState(m, ok) {
  const retries = m.retries ?? 2
  if (ok) {
    return { state: 'up', fail_streak: 0, event: m.state === 'down' ? 'recovered' : null }
  }
  const streak = (m.fail_streak || 0) + 1
  if (streak > retries) {
    return { state: 'down', fail_streak: streak, event: m.state === 'down' ? null : 'down' }
  }
  return { state: 'pending', fail_streak: streak, event: null }
}

/** 可用率。没有心跳时返回 null 而不是 100% —— 「没数据」和「全好」是两回事。 */
export function uptime(beats) {
  if (!beats || !beats.length) return null
  return beats.reduce((n, b) => n + (b.ok ? 1 : 0), 0) / beats.length
}

// ── 有副作用的部分 ────────────────────────────────────────

/**
 * 探一次。永远不抛异常 —— 一个目标挂掉不能让整轮 cron 跟着失败，
 * 更不能让 Promise.all 把其余监控的结果一起丢掉。
 */
export async function probe(m, now = Date.now(), impl = fetch) {
  const t0 = Date.now()
  try {
    const res = await impl(m.url, {
      signal: AbortSignal.timeout(m.timeout_ms ?? 8000),
      headers: { 'user-agent': 'sakuramu-admin-monitor/1 (+https://admin.sakuramu.edu.kg)' },
      // 探测要看源站真实状态，不能被边缘缓存糊弄过去
      cf: { cacheTtl: 0, cacheEverything: false },
    })

    let bodyHead = null
    if (m.expect_keyword) {
      bodyHead = await readHead(res)
    } else if (res.body) {
      // 不需要正文就尽早取消，别把连接吊着
      try { await res.body.cancel() } catch { /* 忽略 */ }
    }

    const ms = Date.now() - t0
    const v = verdict(m, { status: res.status, bodyHead })
    return { id: m.id, ok: v.ok, code: res.status, ms, err: v.err, ts: now }
  } catch (e) {
    const ms = Date.now() - t0
    // AbortSignal.timeout 抛的是 TimeoutError
    const err = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `超时（>${m.timeout_ms ?? 8000}ms）`
      : String(e?.message || e).slice(0, 200)
    return { id: m.id, ok: false, code: null, ms, err, ts: now }
  }
}

/**
 * 只读响应体的前 64KB。
 *
 * 不是保守，是必须：cron 调用只有 10ms CPU，而字符串处理是真花 CPU 的那部分。
 * 主页 HTML 有 57KB，全读一遍再 includes() 约 1–2ms；再大的页面或再多的监控
 * 就可能顶到上限。等待网络属于 I/O，不计 CPU，所以卡的从来不是超时而是正文。
 *
 * 代价：关键字如果正好跨在 64KB 边界上会漏判。任何截断方案都有这个问题，
 * 而关键字本来就该放在页面靠前的位置。
 */
async function readHead(res) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = '', n = 0
  try {
    while (n < MAX_BODY) {
      const { done, value } = await reader.read()
      if (done) break
      // 必须先裁块再解码。一次 read() 完全可能一口气给回整个正文，
      // 那样「读够 64KB 就停」的循环条件根本来不及生效 ——
      // 字符串已经建好了，CPU 也已经花掉了。上限要卡在解码之前。
      const room = MAX_BODY - n
      const chunk = value.byteLength > room ? value.subarray(0, room) : value
      n += chunk.byteLength
      out += dec.decode(chunk, { stream: true })
    }
    out += dec.decode()
  } finally {
    try { await reader.cancel() } catch { /* 忽略 */ }
  }
  return out
}

// ── 写入校验 ──────────────────────────────────────────────

/**
 * 校验来自后台表单的监控配置。
 *
 * 接口在 Access 后面、只有自己能调，但校验照写不误：
 * 挡的不是攻击者，是自己手滑把 interval_s 填成 1 —— 那会让
 * 免费档的 D1 写入配额在几小时内烧光，而且现象是「第二天监控静默停摆」。
 *
 * 拒绝未知字段，不做静默忽略：拼错的字段名要当场报错，
 * 而不是保存成功、行为却没变。
 */
const FIELDS = {
  name:           v => typeof v === 'string' && v.trim().length >= 1 && v.length <= 80,
  url:            v => typeof v === 'string' && v.length <= 500 && isHttpUrl(v),
  interval_s:     v => isInt(v, 60, 86400),
  timeout_ms:     v => isInt(v, 1000, 30000),
  expect_status:  v => v === null || isInt(v, 100, 599),
  expect_keyword: v => v === null || (typeof v === 'string' && v.length <= 200),
  retries:        v => isInt(v, 0, 10),
  enabled:        v => v === 0 || v === 1 || v === true || v === false,
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi

function isHttpUrl(s) {
  let u
  try { u = new URL(s) } catch { return false }
  return u.protocol === 'http:' || u.protocol === 'https:'
}

export function validateMonitor(input, { partial = false } = {}) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['载荷必须是对象'] }
  }
  const value = {}
  for (const [k, v] of Object.entries(input)) {
    // __proto__ 之类的键在 Object.entries 里拿不到，但 constructor / prototype 拿得到
    if (!Object.hasOwn(FIELDS, k)) { errors.push(`未知字段：${k}`); continue }
    if (!FIELDS[k](v)) { errors.push(`字段 ${k} 取值不合法`); continue }
    value[k] = k === 'enabled' ? (v ? 1 : 0) : v
  }
  if (!partial) {
    for (const k of ['name', 'url']) {
      if (!(k in value)) errors.push(`缺少必填字段：${k}`)
    }
  }
  if (partial && !Object.keys(value).length && !errors.length) {
    errors.push('没有要修改的字段')
  }
  return errors.length ? { ok: false, errors } : { ok: true, value }
}

/** 新建时的默认值。与 schema.sql 里的 DEFAULT 保持一致。 */
export const MONITOR_DEFAULTS = {
  interval_s: 300, timeout_ms: 8000,
  expect_status: null, expect_keyword: null,
  retries: 2, enabled: 1,
}
