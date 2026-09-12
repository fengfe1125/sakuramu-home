// Cloudflare Access 的 JWT 校验。
//
// 为什么域名已经挡在 Access 后面了还要自己再验一遍签名：
// Access 拦的是「自定义域」这一条路。把 workers_dev 和 preview_urls 都关掉之后，
// 理论上确实只剩这一条。但将来任何一次手滑加路由、开预览、或是换个域名调试，
// 都会重新开一个绕过 Access 的口子 —— 而那个时候不会有人想起这件事。
// 这一百多行是纵深防御，成本一次性付清。
//
// 只认 Cf-Access-Jwt-Assertion 请求头，不认 CF_Authorization Cookie。
// 两者装的是同一个 JWT，但 Cookie 会被浏览器跨站自动带上，请求头不会 ——
// 只收请求头，这个接口天然免疫 CSRF。

const CERT_TTL_MS = 3600_000   // JWKS 缓存 1 小时
const COOLDOWN_MS = 300_000    // 两次回源取证书的最小间隔，避免未知 kid 变成每请求一次 fetch
const SKEW_S = 60              // 允许的时钟偏差
const MAX_TOKEN = 8192         // 超过这个长度的一律不解析

// 模块级缓存：同一个 isolate 内跨请求复用，连 importKey 的开销也省掉
let cache = null        // { iss, keys: Map<kid, CryptoKey>, at: number }
let lastFetchAt = 0

const dec = new TextDecoder()

function b64urlBytes(s) {
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/')
  const pad = t.length % 4
  if (pad === 1) throw new Error('bad base64url')
  if (pad) t += '='.repeat(4 - pad)
  const bin = atob(t)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const b64urlJSON = s => JSON.parse(dec.decode(b64urlBytes(s)))

/** 读配置。两个都得有，缺一个就当没配 —— 只配一半比没配更危险。 */
export function accessConfig(env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || '').trim()
  const aud = String(env.ACCESS_AUD || '').trim()
  if (!team || !aud) return null
  // team 可以写成 foo 或 foo.cloudflareaccess.com，两种都接受
  const host = team.includes('.') ? team : team + '.cloudflareaccess.com'
  return { iss: 'https://' + host, aud }
}

async function keyFor(kid, iss) {
  const now = Date.now()
  const fresh = cache && cache.iss === iss && now - cache.at < CERT_TTL_MS
  if (fresh) {
    const hit = cache.keys.get(kid)
    if (hit) return hit
  }
  // 走到这里说明：缓存过期，或者 kid 没命中（Access 轮换了签名密钥）。
  // 两种都要回源，但要有冷却 —— 否则一个伪造的随机 kid 就能让每个请求都打一次外部 fetch。
  if (now - lastFetchAt < COOLDOWN_MS) {
    return (cache && cache.iss === iss && cache.keys.get(kid)) || null
  }
  lastFetchAt = now

  const r = await fetch(iss + '/cdn-cgi/access/certs', { cf: { cacheTtl: 300 } })
  if (!r.ok) throw new Error('certs HTTP ' + r.status)
  const body = await r.json()
  if (!body || !Array.isArray(body.keys)) throw new Error('certs shape')

  const keys = new Map()
  for (const k of body.keys) {
    // 只收 RSA 验签公钥。importKey 会自己校验参数，坏的那个跳过就好，
    // 不能让一把畸形的钥匙毁掉整份密钥集。
    if (k?.kty !== 'RSA' || !k.kid || !k.n || !k.e) continue
    try {
      keys.set(k.kid, await crypto.subtle.importKey(
        'jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']))
    } catch { /* 跳过这一把 */ }
  }
  if (!keys.size) throw new Error('certs empty')
  cache = { iss, keys, at: now }
  return keys.get(kid) || null
}

/**
 * 校验请求里的 Access 断言。
 * 返回 { ok:true, email, sub } 或 { ok:false, why }。
 * why 只用来记日志和挑状态码，不回给调用方 —— 别帮攻击者做探测。
 */
export async function verifyAccess(request, env) {
  const cfg = accessConfig(env)
  if (!cfg) return { ok: false, why: 'not_configured' }

  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return { ok: false, why: 'no_assertion' }
  if (token.length > MAX_TOKEN) return { ok: false, why: 'too_long' }

  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, why: 'shape' }

  let head, claims, sig
  try {
    head = b64urlJSON(parts[0])
    claims = b64urlJSON(parts[1])
    sig = b64urlBytes(parts[2])
  } catch { return { ok: false, why: 'decode' } }

  // 算法白名单只有 RS256。这一行挡的是经典的算法混淆攻击：
  // alg:none 直接免签，alg:HS256 则诱使我们把 RSA 公钥当 HMAC 密钥用 ——
  // 而公钥是人人都能取到的。绝不能「按 header 说的算法来」。
  if (head?.alg !== 'RS256') return { ok: false, why: 'alg' }
  if (!head.kid || typeof head.kid !== 'string') return { ok: false, why: 'kid' }

  let key
  try { key = await keyFor(head.kid, cfg.iss) }
  catch { return { ok: false, why: 'certs' } }
  if (!key) return { ok: false, why: 'unknown_kid' }

  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1])
  const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed)
  if (!good) return { ok: false, why: 'signature' }

  // ── 签名对了，再看内容 ──
  // aud 是这里最要紧的一条：它把令牌绑死在「这一个」Access 应用上。
  // 少了它，同一个 team 里任何一个策略更宽松的应用签出来的令牌都能进后台。
  const auds = Array.isArray(claims.aud) ? claims.aud
             : typeof claims.aud === 'string' ? [claims.aud] : []
  if (!auds.includes(cfg.aud)) return { ok: false, why: 'aud' }
  if (claims.iss !== cfg.iss) return { ok: false, why: 'iss' }

  const now = Math.floor(Date.now() / 1000)
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < now) return { ok: false, why: 'exp' }
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > now) return { ok: false, why: 'nbf' }
  if (typeof claims.iat === 'number' && claims.iat - SKEW_S > now) return { ok: false, why: 'iat' }

  const email = String(claims.email || '').toLowerCase()

  // 邮箱白名单。Access 策略本身已经限定了人，这里是第二道 ——
  // 挡的是策略被改宽（那个 Include 下拉框选错成 Everyone 是很容易发生的事）。
  // 留空 = 不校验，完全依赖 Access 策略。
  const allow = String(env.ACCESS_ALLOWED_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (allow.length && !allow.includes(email)) return { ok: false, why: 'email' }

  return { ok: true, email, sub: String(claims.sub || '') }
}
