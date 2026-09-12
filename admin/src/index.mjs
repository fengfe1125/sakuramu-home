// sakuramu-admin —— 管理后台 Worker。
//
// 三个站点各自独立，这个崩了主页毫发无损：
//   sakuramu.edu.kg        restless-mountain-3c35   纯静态，无 main，零 Worker 调用
//   about.sakuramu.edu.kg  sakuramu-home-v2         纯静态，无 main
//   admin.sakuramu.edu.kg  sakuramu-admin           ← 这里，main + D1
//
// 鉴权全靠 Cloudflare Access（见 access.js）。这个 Worker 自己不存密码、
// 不发会话、不碰 Cookie —— 没写的代码不会有洞。

import { verifyAccess, accessConfig } from './access.mjs'

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2) + '\n', {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // 后台页面一律不进任何缓存 —— 它是按人鉴权的
      'cache-control': 'no-store',
      ...SECURITY_HEADERS, ...extra,
    },
  })

// 后台是这个账号上权限最高的一个面，安全响应头在这里最值。
// 站点本体的头在 public/_headers 里另外补。
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

/**
 * 所有写接口的闸门。
 *
 * 没配 Access 时返回 503 而不是放行 —— 这是整个文件里最要紧的一个选择。
 * 「配置缺失就跳过校验」是后台被一路裸奔到公网上的最常见死法：
 * 配置丢了没人会发现，因为一切看起来都正常工作。
 * 宁可后台用不了，也不能让它在没鉴权的情况下能用。
 */
async function gate(request, env) {
  const v = await verifyAccess(request, env)
  if (v.ok) return null
  if (v.why === 'not_configured') {
    return json({ error: 'access_not_configured',
      detail: '这个 Worker 还没拿到 ACCESS_TEAM_DOMAIN / ACCESS_AUD，写接口一律拒绝。' }, 503)
  }
  // 对外只说「不行」，不说为什么不行
  console.log('access denied: ' + v.why)
  return json({ error: 'forbidden' }, 403)
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname

    // ── 公开：存活探测 ──────────────────────────────────────
    // 配好 Access 之后这条路也会被 Access 挡在外面（Access 是按域名整域拦的），
    // 所以它只在部署验证时有用。不要为它开 Access 的 Bypass ——
    // 那正是 access.js 顶上说的「将来手滑开的那个口子」。
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

    // ── 受保护：/v1/* ──────────────────────────────────────
    if (path.startsWith('/v1/')) {
      const denied = await gate(request, env)
      if (denied) return denied

      if (path === '/v1/whoami') {
        const v = await verifyAccess(request, env)
        return json({ email: v.email, sub: v.sub })
      }

      // 监控 / 事件 / 手记接口在第 2–4 步补上
      return json({ error: 'not_found' }, 404)
    }

    // ── 其余交给静态资源 ───────────────────────────────────
    const res = await env.ASSETS.fetch(request)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v)
    out.headers.set('cache-control', 'no-store')
    return out
  },
}
