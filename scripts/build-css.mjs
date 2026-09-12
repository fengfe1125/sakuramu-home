#!/usr/bin/env node
// 把 shared/base.css 注入两个页面的 base:start / base:end 之间。
//
// 为什么不是外链样式表：站点的原则是「访客拿到的是单个自包含 HTML」——
// 外链会多一次阻塞渲染的请求，而且首屏样式必须内联才不闪。
// 这里走的是和 build-notes.mjs 完全相同的套路：仓库里有工具，产物仍是一个文件。
//
// 用法：node scripts/build-css.mjs [--check]
//   --check 只校验不写入，给 CI 用。

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'shared/base.css')
const TARGETS = [join(ROOT, 'public/index.html'), join(ROOT, 'v2/index.html')]
const START = '/* base:start */'
const END = '/* base:end */'
const CHECK = process.argv.includes('--check')

const css = (await readFile(SRC, 'utf8')).replace(/\n+$/, '')
let changed = 0

for (const f of TARGETS) {
  const page = await readFile(f, 'utf8')
  const a = page.indexOf(START), b = page.indexOf(END)
  if (a < 0 || b < 0) {
    console.error(`  ✗ ${f} 里找不到 base 标记`)
    process.exit(1)
  }
  const next = page.slice(0, a + START.length) + '\n' + css + '\n' + page.slice(b)
  if (next === page) continue
  changed++
  if (CHECK) {
    console.error(`  ✗ ${f} 与 shared/base.css 不一致，跑一次 npm run css`)
    process.exit(1)
  }
  await writeFile(f, next)
  console.log('  ✓ 已注入 ' + f.replace(ROOT + '/', ''))
}
if (!changed) console.log('  · 样式无变化')
