// 手记的校验与取值规则。纯函数，不碰数据库。
//
// 最要紧的一条在这个文件之外，但必须在这里说清楚：
// **html 永远由服务端 render(md) 生成，绝不接受客户端提交的 HTML。**
// 存 HTML 就等于把转义的责任交给浏览器端，那条链上任何一环被攻破，
// 都是自己域名上的存储型 XSS。这里只收 md。

export const MAX_MD = 200_000     // 20 万字符，够写很长了；再长多半是误粘贴
export const MAX_TITLE = 120

/**
 * slug 直接出现在 URL 和 D1 主键里，规则从严：
 * 小写字母、数字、连字符，长度 1–80，不以连字符开头或结尾。
 * 不接受下划线和点 —— 点会让「slug.json」这类路径产生歧义。
 */
export function validSlug(s) {
  return typeof s === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(s)
}

/** 从标题生成 slug 的建议值。中文标题生成不出东西时返回空串，由调用方决定怎么办。 */
export function suggestSlug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 日期必须是真实存在的那一天。2026-13-45 能通过正则，但它不是一天。 */
export function validDate(s) {
  const m = ISO_DATE.exec(String(s || ''))
  if (!m) return false
  const [, y, mo, d] = m.map(Number)
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

const FIELDS = {
  title:     v => typeof v === 'string' && v.trim().length >= 1 && v.length <= MAX_TITLE,
  date:      v => validDate(v),
  md:        v => typeof v === 'string' && v.length <= MAX_MD,
  published: v => v === 0 || v === 1 || v === true || v === false,
}

/**
 * 校验写入载荷。拒绝未知字段，不做静默忽略 ——
 * 拼错的字段名要当场报错，而不是保存成功、行为却没变。
 *
 * 特别地：html 是未知字段，所以「顺手提交一份 HTML」会被明确拒绝，
 * 而不是悄悄覆盖掉服务端渲染的结果。
 */
export function validateNote(input, { partial = false } = {}) {
  const errors = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['载荷必须是对象'] }
  }
  const value = {}
  for (const [k, v] of Object.entries(input)) {
    if (!Object.hasOwn(FIELDS, k)) { errors.push(`未知字段：${k}`); continue }
    if (!FIELDS[k](v)) { errors.push(`字段 ${k} 取值不合法`); continue }
    value[k] = k === 'published' ? (v ? 1 : 0) : v
  }
  if (!partial) {
    for (const k of ['title', 'date', 'md']) {
      if (!(k in value)) errors.push(`缺少必填字段：${k}`)
    }
  }
  if (partial && !Object.keys(value).length && !errors.length) {
    errors.push('没有要修改的字段')
  }
  if ('md' in value && !value.md.trim()) errors.push('正文不能为空')
  return errors.length ? { ok: false, errors } : { ok: true, value }
}
