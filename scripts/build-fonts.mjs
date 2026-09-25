#!/usr/bin/env node
// 字体自托管：把两个页面用到的字体从 Google Fonts 搬到主站自己的 /fonts/ 下。
//
// 为什么搬：大陆网络连 fonts.googleapis.com 很不稳定，而字体样式表会阻塞渲染 ——
// 连不上时整页都出不来，连得慢时首屏的手写字也迟迟写不出来。
// 现在样式表和字体文件都从 sakuramu.edu.kg 自己发，和页面走同一条连接。
//
// 文件原样来自 Google Fonts，渲染效果不变。中文字体和 Google 一样按字切片：
// 每片声明 unicode-range，浏览器只下载页面上用到的字所在的那几片。
//
// 和 Google 原版只有一处不同：黑体 400/500/700、宋体 400/600 在 Google 那边是
// 同一套可变字体文件、每档各写一遍声明。这里合并成一条「400 700」的范围声明，
// 浏览器要解析的样式表少了一半多。页面只用到这几档字重，合并前后渲染完全一样
// （夹在两档之间的字重才有差别，见 README「字体」）。
//
// 产物：
//   public/fonts/fonts.css              @font-face 声明（生成文件，别手改）
//   public/fonts/<字体>/<版本>/*.woff2   字体文件
//   public/fonts/<字体>/OFL.txt          许可证（SIL OFL，允许自托管和再分发）
//   两个页面 <!-- fonts:start --> 与 <!-- fonts:end --> 之间的 <link>，
//   样式表地址带内容指纹（?v=），字体一换浏览器就会重新下载
//
// 关于页在另一个子域名上，直接引用主站的 /fonts/，靠 public/_headers 给 /fonts/* 开的 CORS。
//
// 用法：
//   npm run fonts                          从 Google 拉最新的样式表和字体（要能访问 Google）
//   node scripts/build-fonts.mjs --check   离线自检，CI 和两个 deploy 命令都会跑

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/fonts')
const CSS_FILE = join(OUT, 'fonts.css')
const HOME = join(ROOT, 'public/index.html')
const ABOUT = join(ROOT, 'v2/index.html')
const SITE = 'https://sakuramu.edu.kg'

// 改版时定下的字体。要换字体只改这里，然后 npm run fonts
export const QUERY = 'family=DM+Sans:opsz,wght@9..40,400..700'
  + '&family=JetBrains+Mono:wght@400'
  + '&family=Noto+Sans+SC:wght@400;500;700'
  + '&family=Noto+Serif+SC:wght@400;600'
  + '&family=Caveat:wght@500..700'
  + '&family=Long+Cang'
  + '&display=swap'
// Google 按浏览器给不同的格式。报一个现代 Chrome，拿到的是 woff2 加 unicode-range 切片
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
// 首页首屏的名字 Rowan 用这一片：和样式表同时开始下载，名字不用排在样式表后面等
const PRELOAD = { family: 'Caveat', subset: 'latin' }

const START = '<!-- fonts:start -->', END = '<!-- fonts:end -->'

// ── 纯函数（tests/test_fonts.js 直接测它们） ─────────────────────

// Google 的样式表：拉丁、西里尔这类分组前面有一行注释写着是哪组（latin、cyrillic……），
// 中文的一百来片没有注释。生成的 fonts.css 保留同样的注释，--check 用同一个函数读回来。
export function parse(css) {
  const faces = []
  for (const m of css.matchAll(/(?:\/\*\s*([^*]*?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
    const d = {}
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':')
      if (i > 0) d[decl.slice(0, i).trim()] = decl.slice(i + 1).trim()
    }
    const url = /url\(([^)]+)\)/.exec(d.src || '')?.[1]
    if (!d['font-family'] || !d['font-weight'] || !url || !d['unicode-range'])
      throw new Error('看不懂的 @font-face：' + m[0].slice(0, 120))
    faces.push({
      subset: m[1] || '', family: d['font-family'].replace(/['"]/g, ''), style: d['font-style'] || 'normal',
      weight: d['font-weight'], display: d['font-display'] || 'swap', url, range: d['unicode-range'],
    })
  }
  // 漏认一条就是漏一片字：那片字会静默退回系统字体，没人会发现
  const total = (css.match(/@font-face/g) || []).length
  if (faces.length !== total) throw new Error(`样式表里有 ${total} 条 @font-face，只认出 ${faces.length} 条`)
  return faces
}

// https://fonts.gstatic.com/s/<字体>/<版本>/<文件>.woff2 → <字体>/<版本>/<文件>.woff2
// 只认这一种形状：地址要拼成本地路径，不能让奇怪的地址写到 public/ 外面去
export function localPath(url) {
  const m = /^https:\/\/fonts\.gstatic\.com\/s\/([a-z0-9]+)\/(v\d+)\/([\w.-]+\.woff2)$/.exec(url)
  if (!m) throw new Error('不认识的字体地址：' + url)
  return `${m[1]}/${m[2]}/${m[3]}`
}

// 同一个文件、同一片字、只差字重的几条声明，合并成一条范围声明
export function merge(faces) {
  const out = new Map()
  for (const f of faces) {
    const w = f.weight.split(/\s+/).map(Number)
    if (!w.length || w.some(Number.isNaN)) throw new Error('看不懂的字重：' + f.weight)
    const key = [f.family, f.style, f.url, f.range].join('|')
    const g = out.get(key)
    if (g) { g.lo = Math.min(g.lo, ...w); g.hi = Math.max(g.hi, ...w) }
    else out.set(key, { ...f, lo: Math.min(...w), hi: Math.max(...w), file: localPath(f.url) })
  }
  return [...out.values()]
}

// 一条声明一行；unicode-range 逗号后的空格去掉，样式表里大半是它
export function render(faces) {
  return '/* 由 scripts/build-fonts.mjs 生成，别手改。字体来自 Google Fonts，许可证见各字体目录下的 OFL.txt。 */\n'
    + faces.map(f => (f.subset ? `/* ${f.subset} */` : '') + `@font-face{font-family:'${f.family}';font-style:${f.style};`
      + `font-weight:${f.lo === f.hi ? f.lo : f.lo + ' ' + f.hi};font-display:${f.display};`
      + `src:url(${f.file}) format('woff2');unicode-range:${f.range.replace(/,\s+/g, ',')}}`).join('\n') + '\n'
}

export const fingerprint = css => createHash('sha256').update(css).digest('hex').slice(0, 10)

// 两个页面里 fonts 标记之间该有的内容
function pageBlocks(css, faces) {
  const v = fingerprint(css)
  const pre = faces.find(f => f.family === PRELOAD.family && f.subset === PRELOAD.subset)
  if (!pre) throw new Error(`样式表里找不到要预载的 ${PRELOAD.family} ${PRELOAD.subset}`)
  return new Map([
    [HOME, [
      `<link rel="preload" href="/fonts/${pre.file || pre.url}" as="font" type="font/woff2" crossorigin>`,
      `<link rel="stylesheet" href="/fonts/fonts.css?v=${v}">`,
    ]],
    [ABOUT, [
      // 字体在主站上：样式表走普通连接，字体文件走匿名的跨域连接，两条都提前连上
      `<link rel="preconnect" href="${SITE}">`,
      `<link rel="preconnect" href="${SITE}" crossorigin>`,
      `<link rel="stylesheet" href="${SITE}/fonts/fonts.css?v=${v}">`,
    ]],
  ])
}

// ── 从 Google 拉 ──────────────────────────────────────────

async function build() {
  const res = await fetch('https://fonts.googleapis.com/css2?' + QUERY, { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error('拉样式表失败：HTTP ' + res.status)
  const raw = await res.text()
  const faces = merge(parse(raw))
  const urls = new Map(faces.map(f => [f.file, f.url]))
  const dirs = new Set([...urls.keys()].map(f => f.split('/')[0]))
  console.log(`  · Google 给了 ${(raw.match(/@font-face/g) || []).length} 条声明，合并成 ${faces.length} 条，${urls.size} 个文件`)

  // 地址里带版本号，同一个地址的内容不会变：已有的不再下
  const todo = [...urls.keys()].filter(f => !existsSync(join(OUT, f)))
  let bytes = 0, done = 0
  await pool(todo, 8, async f => {
    // 先拿到结果再累加：写成 bytes += await …，几路并发会互相覆盖
    const n = await download(urls.get(f), join(OUT, f))
    bytes += n
    if (++done % 50 === 0) console.log(`  … ${done}/${todo.length}`)
  })
  console.log(todo.length ? `  ✓ 新下载 ${todo.length} 个文件，${mb(bytes)}` : '  · 字体文件都已在本地')

  for (const dir of dirs) {
    const r = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${dir}/OFL.txt`)
    if (!r.ok) throw new Error(`${dir} 的许可证拉不到：HTTP ${r.status}`)
    const text = await r.text()
    if (!/SIL OPEN FONT LICENSE/i.test(text)) throw new Error(`${dir} 的许可证不是 OFL，先确认它允不允许自托管`)
    await writeFile(join(OUT, dir, 'OFL.txt'), text)
  }

  const css = render(faces)
  await writeFile(CSS_FILE, css)

  // 字体升级换了版本号之后，旧文件和旧目录清掉
  let removed = 0
  for (const f of await readdir(OUT, { recursive: true })) {
    if (f.endsWith('.woff2') && !urls.has(f)) { await rm(join(OUT, f)); removed++ }
  }
  for (const d of await readdir(OUT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    if (!dirs.has(d.name)) { await rm(join(OUT, d.name), { recursive: true }); continue }
    for (const v of await readdir(join(OUT, d.name), { withFileTypes: true })) {
      if (v.isDirectory() && !(await readdir(join(OUT, d.name, v.name))).length) await rm(join(OUT, d.name, v.name), { recursive: true })
    }
  }
  if (removed) console.log(`  ✓ 清掉 ${removed} 个不再用的旧文件`)

  let changed = 0
  for (const [page, lines] of pageBlocks(css, faces)) {
    const html = await readFile(page, 'utf8')
    const a = html.indexOf(START), z = html.indexOf(END)
    if (a < 0 || z < a) throw new Error(`${rel(page)} 里找不到 ${START} / ${END}`)
    const next = html.slice(0, a + START.length) + '\n' + lines.join('\n') + '\n' + html.slice(z)
    if (next !== html) { await writeFile(page, next); changed++; console.log(`  ✓ 字体引用 → ${rel(page)}`) }
  }
  if (!changed) console.log('  · 页面里的字体引用无变化')
}

async function download(url, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA } })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const buf = Buffer.from(await r.arrayBuffer())
      if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error('下回来的不是 woff2')
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file + '.part', buf)
      await rename(file + '.part', file)
      return buf.length
    } catch (e) {
      if (attempt === 3) throw new Error(`${url} 下载失败：${e.message}`)
      await new Promise(r => setTimeout(r, 800 * attempt))
    }
  }
}

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

// ── 离线自检 ────────────────────────────────────────────

async function check() {
  if (!existsSync(CSS_FILE)) throw new Error('没有 public/fonts/fonts.css，跑一次 npm run fonts')
  const css = await readFile(CSS_FILE, 'utf8')
  const faces = parse(css)
  if (!faces.length) throw new Error('public/fonts/fonts.css 里没有字体声明')
  const bad = []

  // 样式表 ↔ 磁盘：引用的都在，在的都被引用
  const used = new Set(faces.map(f => f.url))
  for (const f of used) if (!existsSync(join(OUT, f))) bad.push(`样式表引用的 ${f} 不在`)
  const onDisk = (await readdir(OUT, { recursive: true })).filter(f => f.endsWith('.woff2'))
  for (const f of onDisk) if (!used.has(f)) bad.push(`${f} 没被样式表引用（npm run fonts 会清掉它）`)
  for (const dir of new Set([...used].map(f => f.split('/')[0])))
    if (!existsSync(join(OUT, dir, 'OFL.txt'))) bad.push(`${dir} 缺许可证 OFL.txt`)

  // 页面：引用和样式表的指纹对得上，不再出现 Google Fonts
  for (const [page, lines] of pageBlocks(css, faces)) {
    const html = await readFile(page, 'utf8')
    if (/fonts\.(googleapis|gstatic)\.com/.test(html)) bad.push(`${rel(page)} 还在引用 Google Fonts`)
    const a = html.indexOf(START), z = html.indexOf(END)
    if (a < 0 || z < a) bad.push(`${rel(page)} 里找不到 ${START} / ${END}`)
    else if (html.slice(a + START.length, z).trim() !== lines.join('\n')) bad.push(`${rel(page)} 的字体引用和样式表对不上，跑一次 npm run fonts`)
  }

  // 响应头：两份 CSP 放行字体的来源；主站给 /fonts/* 开跨域和强缓存
  for (const [f, need] of [['public/_headers', "'self'"], ['v2/_headers', SITE]]) {
    const text = await readFile(join(ROOT, f), 'utf8')
    const line = text.split('\n').find(l => /^\s*Content-Security-Policy:/i.test(l)) || ''
    const dir = name => (line.match(new RegExp(`${name}[^;]*`)) || [''])[0]
    if (/fonts\.(googleapis|gstatic)\.com/.test(line)) bad.push(`${f} 的 CSP 还在放行 Google Fonts`)
    if (!dir('font-src').split(/\s+/).includes(need)) bad.push(`${f} 的 font-src 要放行 ${need}`)
    if (f.startsWith('v2') && !dir('style-src').split(/\s+/).includes(SITE)) bad.push(`${f} 的 style-src 要放行 ${SITE}`)
  }
  const rule = /^\/fonts\/\*\n((?:[ \t]+.*\n?)+)/m.exec(await readFile(join(ROOT, 'public/_headers'), 'utf8'))?.[1] || ''
  if (!/Access-Control-Allow-Origin:/i.test(rule)) bad.push('public/_headers 的 /fonts/* 要带 Access-Control-Allow-Origin，关于页跨域用得到')
  if (!/Cache-Control:.*immutable/i.test(rule)) bad.push('public/_headers 的 /fonts/* 要带一年的强缓存')

  if (bad.length) throw new Error('字体自托管有问题：\n    ' + bad.join('\n    '))
  const zipped = gzipSync(css).length
  console.log(`  ✓ 字体自托管完整：${used.size} 个文件，样式表 ${kb(css.length)}（gzip 后 ${kb(zipped)}）`)
}

const kb = n => (n / 1024).toFixed(0) + ' KB'
const mb = n => (n / 1048576).toFixed(1) + ' MB'
const rel = f => f.replace(ROOT + '/', '')

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.argv.includes('--check')) await build()
    await check()
  } catch (e) {
    console.error('  ✗ ' + e.message)
    process.exit(1)
  }
}
