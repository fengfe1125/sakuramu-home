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
  notes.push({ file: f, ...meta, html: render(body.trim()) })
}
notes.sort((a, b) => String(b.date).localeCompare(String(a.date)))

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
