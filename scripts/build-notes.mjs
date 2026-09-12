#!/usr/bin/env node
// 把 v2/notes/*.md 渲染成 HTML，写进 v2/index.html 的 notes 标记之间。
//
// 为什么在发版时渲染、而不是让浏览器解析 Markdown：
//   · 站点的原则是「无构建步骤、单个自包含 HTML」——
//     访客拿到的应该是成品，不是一个还要自己组装的半成品。
//   · 解析器只在 Node 里跑一次，不必让每个访客都下载一份。
//   · 没有 fetch 就没有 CORS、没有加载失败、没有空白态。
//
// 渲染器本体在 ../shared/notes-render.mjs，与后台 Worker 共用同一份 ——
// 后台预览、后台发布、发版烧录三处输出必须逐字一致。
//
// 用法：node scripts/build-notes.mjs [--strict]
// 写法：v2/notes/*.md，开头用 --- 包一段 front-matter：
//     ---
//     title: 标题
//     date: 2026-09-11
//     ---
//     正文……

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { render, frontMatter, cnDate, esc } from '../shared/notes-render.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'v2/notes')
const TARGET = join(ROOT, 'v2/index.html')
const START = '<!-- notes:start -->'
const END = '<!-- notes:end -->'
const STRICT = process.argv.includes('--strict')
const ENDPOINT = process.env.NOTES_ENDPOINT || 'https://notes.sakuramu.edu.kg/notes.json'
const OFFLINE = process.argv.includes('--no-remote')

// 失败默认不阻断发版（与 refresh-snapshot.mjs 同一套语义）：
// 手记渲染不出来不该让整个站发不出去。--strict 下才硬失败，留给 CI。
function bail(msg) {
  console.error('  ⚠ 手记未渲染：' + msg)
  if (STRICT) { console.error('  --strict 模式，中止。'); process.exit(1) }
  process.exit(0)
}

let files
try {
  files = (await readdir(DIR)).filter(f => f.endsWith('.md'))
} catch {
  bail('找不到 ' + DIR)
}

const notes = []
for (const f of files) {
  const text = await readFile(join(DIR, f), 'utf8')
  const { meta, body } = frontMatter(text, f.replace(/\.md$/, ''))
  if (!body.trim()) { console.error('  ⚠ ' + f + ' 正文为空，跳过'); continue }
  notes.push({ slug: slugOf(f), file: f, ...meta, html: render(body.trim()) })
}

// 从后台发布的文章拉回来一并烧录。
//
// 为什么必须烧录而不是只靠运行时拉取：页面里那份 HTML 是兜底 ——
// 手记服务不可达时访客看到的就是它。只存在于运行时的文章，
// 一旦服务挂掉就整篇消失，而那恰恰是最需要兜底的时刻。
//
// 失败语义与 refresh-snapshot.mjs 一致：警告、保留本地内容、退出码 0。
// 远端偶尔抽风不该让整站发不出去。
const remote = OFFLINE ? [] : await fetchRemote()
// slice() 不能省：下面要清空 notes 再回填，
// 而 merged 若和 notes 是同一个数组引用，清空就把源数据一起清掉了 ——
// 表现是「远端不可达的那次发版，把页面上的手记全抹了」。
let merged = notes.slice()
if (remote.length) {
  // 同 slug 以远端为准 —— 网页上改过的才是最新的那一版
  const bySlug = new Map(notes.map(n => [n.slug, n]))
  for (const r of remote) bySlug.set(r.slug, r)
  merged = [...bySlug.values()]
}
merged.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.slug.localeCompare(b.slug))
notes.length = 0
notes.push(...merged)

function slugOf(f) {
  return f.replace(/\.md$/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
}

async function fetchRemote() {
  try {
    const r = await fetch(ENDPOINT, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    // 结构校验：宁可留着本地内容，也不把坏数据烧进页面
    if (!d || d.v !== 1 || !Array.isArray(d.notes)) throw new Error('载荷格式不认识')
    const ok = d.notes.filter(n =>
      n && typeof n.slug === 'string' && typeof n.html === 'string' && n.html.trim()
      && typeof n.title === 'string' && n.title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(n.date || ''))
    if (ok.length !== d.notes.length) {
      console.error(`  ⚠ 远端 ${d.notes.length - ok.length} 篇结构不合法，已跳过`)
    }
    if (ok.length) console.log(`  · 远端取回 ${ok.length} 篇`)
    return ok
  } catch (e) {
    const msg = '  ⚠ 远端手记未取回（' + (e && e.message || e) + '），只烧录本地 .md'
    if (STRICT) { console.error(msg); console.error('  --strict 模式，中止。'); process.exit(1) }
    console.error(msg)
    return []
  }
}

const body = notes.length
  ? notes.map(n => '        <article class="note reveal">\n'
      + '            <div class="note-meta">' + esc(cnDate(n.date)) + '</div>\n'
      + '            <h2 class="note-title">' + esc(n.title) + '</h2>\n'
      + '            <div class="note-body">\n'
      + n.html.split('\n').map(l => '                ' + l).join('\n') + '\n'
      + '            </div>\n'
      + '        </article>').join('\n')
  : '        <p class="note-empty">往 v2/notes/ 里放一个 .md 文件，它就会出现在这里。</p>'

const page = await readFile(TARGET, 'utf8')
const a = page.indexOf(START), b = page.indexOf(END)
if (a < 0 || b < 0) bail(TARGET + ' 里找不到 notes 标记')

const next = page.slice(0, a + START.length) + '\n' + body + '\n        ' + page.slice(b)
if (next === page) { console.log('  · 手记无变化（' + notes.length + ' 篇）'); process.exit(0) }
await writeFile(TARGET, next)
console.log('  ✓ 手记已渲染 ' + notes.length + ' 篇' + (notes.length ? '：' + notes.map(n => n.title).join('、') : ''))
