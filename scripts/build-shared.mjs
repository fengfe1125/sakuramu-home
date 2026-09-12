#!/usr/bin/env node
// 把 shared/ 下的共用片段注入两个页面的标记之间。
//
// 目前管两块：
//   shared/base.css    两个页面逐字相同的那 132 行样式
//   shared/beacon.js   访客埋点
//
// 为什么不是外链文件：站点的原则是「访客拿到的是单个自包含 HTML」——
// 外链会多一次阻塞渲染的请求，首屏样式必须内联才不闪，
// 埋点也该在页面最早的时刻就跑起来。
// 这里走的是和 build-notes.mjs 完全相同的套路：仓库里有工具，产物仍是一个文件。
//
// 为什么必须共用而不是各写一份：改了一处忘了另一处，表现是
// 「关于页的停留时间莫名其妙全是空的」，而且没人会发现。CSS 那次已经是同样的理由。
//
// 用法：node scripts/build-shared.mjs [--check]
//   --check 只校验不写入，给 CI 用。

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, 'public/index.html')
const ABOUT = join(ROOT, 'v2/index.html')
const CHECK = process.argv.includes('--check')

const BLOCKS = [
  { name: '共用样式', src: 'shared/base.css',  start: '/* base:start */',   end: '/* base:end */',   targets: [HOME, ABOUT] },
  { name: '访客埋点', src: 'shared/beacon.js', start: '/* beacon:start */', end: '/* beacon:end */', targets: [HOME, ABOUT] },
]

let changed = 0

for (const b of BLOCKS) {
  const body = (await readFile(join(ROOT, b.src), 'utf8')).replace(/\n+$/, '')
  for (const f of b.targets) {
    const page = await readFile(f, 'utf8')
    const a = page.indexOf(b.start), z = page.indexOf(b.end)
    if (a < 0 || z < 0) {
      console.error(`  ✗ ${rel(f)} 里找不到 ${b.name} 的标记（${b.start}）`)
      process.exit(1)
    }
    const next = page.slice(0, a + b.start.length) + '\n' + body + '\n' + page.slice(z)
    if (next === page) continue
    changed++
    if (CHECK) {
      console.error(`  ✗ ${rel(f)} 的${b.name}与 ${b.src} 不一致，跑一次 npm run shared`)
      process.exit(1)
    }
    await writeFile(f, next)
    console.log(`  ✓ ${b.name} → ${rel(f)}`)
  }
}

if (!changed) console.log('  · 共用片段无变化')

function rel(f) { return f.replace(ROOT + '/', '') }
