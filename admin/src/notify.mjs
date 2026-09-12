// Telegram 告警。
//
// 消息一律用纯文本发，不带 parse_mode ——
// Markdown/HTML 模式要转义一堆字符，而监控名和错误信息里恰好什么都可能出现。
// 转义写错的表现是「告警发不出去」，也就是恰恰在最需要它的时候哑掉。
// Telegram 会自己把裸 URL 变成可点链接，所以纯文本并不损失什么。

const TG_TIMEOUT_MS = 6000
const TZ = 'Asia/Shanghai'

/** 本地时间。Worker 跑在 UTC，告警里写 UTC 时间没人看得懂。 */
export function localTime(ms, tz = TZ) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms)).replace(/\//g, '-')
  } catch {
    // Intl 的时区数据万一不可用，退回 UTC 也比不发强
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  }
}

export function humanDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return m + ' 分钟'
  const h = Math.floor(m / 60), r = m % 60
  return r ? h + ' 小时 ' + r + ' 分钟' : h + ' 小时'
}

/** 故障通知。probe 里的字段都可能是 null，逐个判空。 */
export function formatDown(monitor, probe) {
  const bits = []
  if (probe.code != null) bits.push('HTTP ' + probe.code)
  if (probe.ms != null) bits.push(probe.ms + 'ms')
  return '🔴 ' + monitor.name + ' 无法访问\n'
    + monitor.url + '\n'
    + (probe.err || '未知原因') + (bits.length ? ' · ' + bits.join(' · ') : '') + '\n'
    + localTime(probe.ts)
}

/** 恢复通知。downSince 为空时不写中断时长，而不是写一个错的。 */
export function formatUp(monitor, probe, downSince) {
  const parts = []
  if (downSince) parts.push('中断 ' + humanDuration(probe.ts - downSince))
  if (probe.ms != null) parts.push(probe.ms + 'ms')
  return '🟢 ' + monitor.name + ' 已恢复\n'
    + (parts.length ? parts.join(' · ') + '\n' : '')
    + localTime(probe.ts)
}

export function formatEvent(ev) {
  return ev.kind === 'down'
    ? formatDown(ev.monitor, ev.probe)
    : formatUp(ev.monitor, ev.probe, ev.downSince)
}

/**
 * 发一条。永不抛异常 —— 告警链路失败绝不能反过来把监控本身搞挂，
 * 那等于「因为报警器坏了所以把消防栓也拆了」。
 */
export async function sendTelegram(env, text) {
  const token = String(env.TG_BOT_TOKEN || '').trim()
  const chat = String(env.TG_CHAT_ID || '').trim()
  if (!token || !chat) return { ok: false, why: 'not_configured' }

  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: true,   // 告警里不要塞进整个网页预览
      }),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    })
    if (!r.ok) {
      // 不要把响应体原样记进日志 —— Telegram 的报错里会回显请求内容
      return { ok: false, why: 'http_' + r.status }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, why: e?.name === 'TimeoutError' ? 'timeout' : 'error' }
  }
}

/** 批量推送。一条失败不影响其余。 */
export async function notifyAll(env, events) {
  if (!events || !events.length) return { sent: 0, failed: 0 }
  const rs = await Promise.all(events.map(ev => sendTelegram(env, formatEvent(ev))))
  const failed = rs.filter(r => !r.ok)
  if (failed.length) console.log('告警推送失败 ' + failed.length + ' 条：' + failed.map(f => f.why).join(','))
  return { sent: rs.length - failed.length, failed: failed.length }
}
