// 手记的公开只读接口 —— notes.sakuramu.edu.kg/notes.json
//
// 为什么单独一个 Worker，而不是在后台里加一条公开路由：
// Cloudflare Access 是按域名整域拦的，admin.sakuramu.edu.kg 上开不出公开路径。
// 唯一的办法是给 Access 配 Bypass，而那正是「以后被手滑打开的口子」。
//
// 所以换成物理隔离：这个 Worker 里根本没有写入代码，也没有后台的任何逻辑。
// 它不是靠一个 if 拦着不许写，是压根不会写。
//
// 它挂了，关于页会静默回落到烧录进 HTML 的那份手记，访客看不出区别。

// 中文日期用共用渲染器里的那一份。让页面自己再写一个格式化函数，
// 就等于埋下「发版烧录的日期和运行时拉取的日期长得不一样」这种分叉。
import { cnDate } from '../../shared/notes-render.mjs'

// 浏览器缓存 60 秒，之后靠 ETag revalidate（命中就是 304，零字节）。
//
// 刻意不用 caches.default：这个查询只有几行，边缘缓存省不下什么，
// 却换来两个很难推理的问题 —— 缓存条目跨部署存活（部署完还在发旧代码的响应），
// 以及发了文章要等整个 TTL 才可见。手动缓存在这里是净亏。
const MAX_AGE = 60
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-max-age': '86400',
}

const enc = new TextEncoder()
async function etagOf(text) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return '"' + [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('') + '"'
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    // 只认这一条路径，只认这两种方法。其余一律 404 —— 没有第二条路可走。
    if (url.pathname !== '/notes.json' || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return new Response('not found\n', { status: 404, headers: { ...CORS, 'content-type': 'text/plain' } })
    }

    let body
    try {
      const r = await env.DB.prepare(
        `SELECT slug,title,date,html,updated_at FROM notes
          WHERE published=1 ORDER BY date DESC, slug`).all()
      body = JSON.stringify({
        v: 1,
        generated_at: Date.now(),
        notes: (r.results || []).map(n => ({
          slug: n.slug, title: n.title, date: n.date, date_cn: cnDate(n.date),
          html: n.html, updated_at: n.updated_at,
        })),
      })
    } catch (e) {
      console.log('notes db error: ' + (e && e.message))
      // 不缓存错误。关于页拿不到就静默回落到烧录内容，
      // 把一个坏响应缓存 5 分钟只会让故障变长。
      return new Response(JSON.stringify({ error: 'unavailable' }), {
        status: 503,
        headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    const etag = await etagOf(body)
    const headers = {
      ...CORS,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${MAX_AGE}`,
      'x-content-type-options': 'nosniff',
      etag,
    }

    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers })
    }

    return new Response(request.method === 'HEAD' ? null : body, { headers })
  },
}
