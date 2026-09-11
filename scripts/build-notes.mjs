#!/usr/bin/env node
// 把 v2/notes/*.md 渲染成 HTML，写进 v2/index.html 的 notes 标记之间。
//
// 为什么在发版时渲染、而不是让浏览器解析 Markdown：
//   · 站点的原则是「无构建步骤、单个自包含 HTML」——
//     访客拿到的应该是成品，不是一个还要自己组装的半成品。
//   · 解析器只在 Node 里跑一次，不必让每个访客都下载一份。
//   · 没有 fetch 就没有 CORS、没有加载失败、没有空白态。
//
// 用法：node scripts/build-notes.mjs
// 写法：v2/notes/*.md，开头用 --- 包一段 front-matter：
//     ---
//     title: 标题
//     date: 2026-09-11
//     ---
//     正文……

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'v2/notes')
const TARGET = join(ROOT, 'v2/index.html')
const START = '<!-- notes:start -->'
const END = '<!-- notes:end -->'

const esc = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// 中西文之间补空格 —— 中文排版里这一步最能拉开观感，手打容易漏。
const CJK = '\\u4e00-\\u9fff\\u3040-\\u30ff\\u3400-\\u4dbf'
function spacing(s) {
  return s
    .replace(new RegExp('([' + CJK + '])([A-Za-z0-9$@#])', 'g'), '$1 $2')
    .replace(new RegExp('([A-Za-z0-9%$)\\]])([' + CJK + '])', 'g'), '$1 $2')
}

// 行内元素。顺序要紧：先转义，再套标签，否则生成的标签会被转义掉。
// 行内代码先抽成哨兵，避免里面的 * _ [ ] 被当成 Markdown。
function inline(raw) {
  let s = esc(raw)
  const code = []
  s = s.replace(/`([^`]+)`/g, (_, c) => '@@CODE' + (code.push(c) - 1) + '@@')
  s = spacing(s)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
         (_, t, u) => /^https?:\/\//.test(u)
           ? '<a href="' + u + '" target="_blank" rel="noopener">' + t + '</a>'
           : '<a href="' + u + '">' + t + '</a>')
  return s.replace(/@@CODE(\d+)@@/g, (_, i) => '<code>' + code[+i] + '</code>')
}

function render(md) {
  const out = []
  const lines = md.split('\n')
  let i = 0
  const list = (tag, items) =>
    out.push('<' + tag + '>' + items.map(x => '<li>' + inline(x) + '</li>').join('') + '</' + tag + '>')

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    if (line.startsWith('```')) {
      const buf = []; i++
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
      i++
      // 换行写成字符引用，让整个 <pre> 保持在一行里。
      // 否则外层为了美观给每行加的缩进会被 <pre> 原样渲染进代码块。
      out.push('<pre><code>' + esc(buf.join('\n')).replace(/\n/g, '&#10;') + '</code></pre>')
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) { const n = h[1].length + 2; out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>'); i++; continue }
    if (/^(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (line.startsWith('> ')) {
      const buf = []
      while (i < lines.length && lines[i].startsWith('> ')) buf.push(lines[i++].slice(2))
      out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>')
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const buf = []
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) buf.push(lines[i++].replace(/^[-*]\s+/, ''))
      list('ul', buf); continue
    }
    if (/^\d+\.\s+/.test(line)) {
      const buf = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\d+\.\s+/, ''))
      list('ol', buf); continue
    }
    const buf = []
    while (i < lines.length && lines[i].trim()
           && !/^(#{1,3}\s|>\s|[-*]\s|\d+\.\s|```|---)/.test(lines[i])) buf.push(lines[i++])
    out.push('<p>' + inline(buf.join('')) + '</p>')
  }
  return out.join('\n')
}

function frontMatter(text, fallbackTitle) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  const meta = { title: fallbackTitle, date: '' }
  let body = text
  if (m) {
    body = text.slice(m[0].length)
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)$/)
      if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return { meta, body }
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六']
function cnDate(iso) {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d)) return iso
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WEEK[d.getDay()]
}

let files
try {
  files = (await readdir(DIR)).filter(f => f.endsWith('.md'))
} catch {
  console.error('  ⚠ 找不到 ' + DIR + '，跳过'); process.exit(0)
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
if (a < 0 || b < 0) { console.error('  ⚠ ' + TARGET + ' 里找不到 notes 标记，跳过'); process.exit(0) }

const next = page.slice(0, a + START.length) + '\n' + body + '\n        ' + page.slice(b)
if (next === page) { console.log('  · 手记无变化（' + notes.length + ' 篇）'); process.exit(0) }
await writeFile(TARGET, next)
console.log('  ✓ 手记已渲染 ' + notes.length + ' 篇' + (notes.length ? '：' + notes.map(n => n.title).join('、') : ''))
