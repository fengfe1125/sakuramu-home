// 访客统计的纯函数。上报 Worker 和后台共用这一份，可脱离数据库与网络单测。
//
// 贯穿整个文件的一条原则：**客户端只能提供它自己才知道的东西**。
//   · 时间戳 → 服务端 Date.now()，不信客户端时钟
//   · 站点   → 从 Origin 推导，不从载荷取
//   · 国家   → request.cf.country
//   · IP / UA → 根本不进这张表，连列都没有
// 这几样一旦接受客户端提交，统计就变成了「访客想让你看到什么」。
// 它们都在字段白名单之外，夹带会被明确拒绝。

export const MAX_BODY = 1024                   // 上报载荷上限
export const VISIT_RETAIN_MS = 30 * 86400_000  // 原始记录保留 30 天
export const MAX_ENDS = 4                      // 同一次访问最多接受几次「离开」
export const MAX_DWELL_MS = 86_400_000         // 停留时长上限 24 小时
export const CN_OFFSET = 8 * 3600_000

// ── 写入预算 ────────────────────────────────────────────────
// D1 的写入行数要把索引算进去：官方口径是「写入涉及被索引的列时，
// 索引也各算一行」。visits 有 id 主键索引 + idx_visits_ts 两个索引，
// 所以一次 INSERT 实际写 3 行，不是 1 行。
//
//   INSERT visits           表 1 + id 索引 1 + ts 索引 1 = 3
//   visit_budget upsert     rowid 主键无二级索引        = 1
//   UPDATE dwell_ms/ends    两列都没索引                = 1
//   DELETE visits（30 天后） 同 INSERT                   = 3
//   一次完整访问稳态                                     = 9
//
// 闸按「摄入行」算（不含 30 天后的清理）。设 2 万：
// 最坏情况 = 当天摄入 2 万 + 清理 30 天前同量约 1.5 万 ≈ 3.5 万行/天，
// 监控只要 1,800 行，账号级的 10 万行/天还剩六成以上。
export const ROWS_PER_VIEW = 4    // INSERT 3 + 预算表 1
export const ROWS_PER_END = 2     // UPDATE 1 + 预算表 1
export const HIT_CAP = 20_000

/** 站点只认这两个来源。site 由此推导，不从载荷取。 */
export const SITES = {
  'https://sakuramu.edu.kg': 'home',
  'https://about.sakuramu.edu.kg': 'about',
}

/**
 * Origin 校验。必须**完全相等**，不能用 startsWith/includes ——
 * 那样 https://sakuramu.edu.kg.evil.com 会被当成自己人。
 */
export function siteOf(origin) {
  if (typeof origin !== 'string') return null
  return Object.hasOwn(SITES, origin) ? SITES[origin] : null
}

// ── 时间 ────────────────────────────────────────────────────
// 存储一律用北京时区的**整数日序号**，只有显示时才转成 YYYY-MM-DD。
// 两种表示混用是 bug 温床；而且整数能直接当 rowid 主键，
// upsert 只写一行，TEXT 主键还要多写一行索引。
// 时区规则只存在于这两个函数里。

export function dayNum(ts) { return Math.floor((ts + CN_OFFSET) / 86400_000) }
export function dayToISO(n) { return new Date(n * 86400_000).toISOString().slice(0, 10) }

const ID_RE = /^[a-z0-9]{8,32}$/

const FIELDS = {
  view: {
    id: v => typeof v === 'string' && ID_RE.test(v),
    p:  v => typeof v === 'string' && v.length >= 1 && v.length <= 200 && v.startsWith('/'),
    r:  v => v === '' || (typeof v === 'string' && isHostish(v)),
  },
  end: {
    id: v => typeof v === 'string' && ID_RE.test(v),
    d:  v => Number.isInteger(v) && v >= 0 && v <= MAX_DWELL_MS,
  },
}

/**
 * 来源只收主机名。带 / ? # : @ 空格 的一律判非法 ——
 * 「只存 host，不存完整 URL」这条规矩必须在服务端也成立，不能只靠客户端自觉。
 */
function isHostish(s) {
  return typeof s === 'string' && s.length <= 64 && s.includes('.') && /^[a-z0-9.-]+$/i.test(s)
}

/** 校验一条上报。拒绝未知字段，不做静默忽略。 */
export function validateHit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, why: 'not_object' }
  }
  const t = input.t
  if (t !== 'view' && t !== 'end') return { ok: false, why: 'bad_type' }

  const spec = FIELDS[t]
  const value = { t }
  for (const [k, v] of Object.entries(input)) {
    if (k === 't') continue
    if (!Object.hasOwn(spec, k)) return { ok: false, why: 'unknown_field:' + k }
    if (!spec[k](v)) return { ok: false, why: 'bad_field:' + k }
    value[k] = v
  }
  for (const k of Object.keys(spec)) {
    if (k === 'r') continue                       // r 可省略
    if (!(k in value)) return { ok: false, why: 'missing:' + k }
  }
  if (t === 'view' && !('r' in value)) value.r = ''
  return { ok: true, value }
}

/**
 * 从 referrer 里只取主机名。页面侧已经只发主机名，这是服务端的第二道。
 * 解析不了返回空串而不是抛异常。
 */
export function refHost(u) {
  if (!u) return ''
  const s = String(u)
  try {
    const h = new URL(s).hostname.toLowerCase()
    return isHostish(h) ? h : ''
  } catch {
    const h = s.toLowerCase()
    return isHostish(h) ? h : ''
  }
}

/**
 * 粗略的机器人判断。**只返回布尔值，绝不把 UA 写进任何地方** ——
 * 存 UA 就等于在一个承诺「不存 UA」的表里存了 UA。
 */
const BOT_RE = /bot|crawl|spider|slurp|headless|preview|fetch|monitor|curl|wget|python|scrapy|lighthouse/i
export function looksLikeBot(ua) {
  return typeof ua === 'string' && BOT_RE.test(ua)
}

/**
 * 分位数。values 必须是已排序的数字数组，**且不含 null** ——
 * null 代表「不知道」，不是 0。
 */
export function quantile(sorted, q) {
  if (!sorted || !sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))
  return sorted[i]
}

/**
 * 停留时长汇总。
 *
 * 没收到离开事件的访问 dwell 为 null，必须先滤掉再算 ——
 * 当成 0 秒会把中位数直接拉垮，而那其实是浏览器崩溃、强杀 App、断网，
 * 不是「看了 0 秒」。
 *
 * 同时返回覆盖率：突然掉下去就说明信标或 CSP 出问题了。
 * 另外要清楚：收不到离开事件的那批偏向崩溃和秒关，
 * 所以「有样本那部分的中位数」是一个偏乐观的上界，不是全体中位数。
 */
export function summarizeDwell(dwells, totalViews) {
  const xs = (dwells || []).filter(v => typeof v === 'number' && Number.isFinite(v))
                           .sort((a, b) => a - b)
  const n = typeof totalViews === 'number' ? totalViews : xs.length
  return {
    views: n,
    sampled: xs.length,
    coverage: n ? xs.length / n : null,   // 没有访问时是 null 而不是 100%
    p50: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    mean: xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
  }
}

/** 柱状图补洞：中间没有访问的日子补 0，而不是把柱子挤在一起造成「天天有人来」的假象。 */
export function fillDays(rows, fromDay, toDay) {
  const by = new Map((rows || []).map(r => [r.day, r]))
  const out = []
  for (let d = fromDay; d <= toDay; d++) {
    const r = by.get(d)
    out.push({ day: d, iso: dayToISO(d), views: r ? r.views : 0 })
  }
  return out
}

/**
 * 预算告警：越过一半时提醒一次，同一天不重复。
 * 重复告警在这个仓库里是明确当缺陷处理的（见 monitor.mjs 的 nextState）。
 */
export function shouldAlert(rowsWritten, cap, lastAlertDay, today) {
  if (!cap || rowsWritten < cap / 2) return false
  return lastAlertDay !== today
}
