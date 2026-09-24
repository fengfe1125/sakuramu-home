#!/usr/bin/env node
// 发版闸：页面里还留着 data-todo 占位就拒绝部署。
//
// 占位是写给作者看的（本地预览时用陶土色虚线框标出来），不该出现在线上。
// 之前关于页的「草稿待改」提示框就是这样跟着一起发出去的。
//
// 只认写在 HTML 标签里的属性。样式表里的 [data-todo] 选择器、
// 注释里提到这个词的句子都不算 —— 第一版只看「前面有空白」，
// 结果把 shared/base.css 里的一行注释当成了占位，主站也被拦下了。
//
// 用法：node scripts/check-placeholders.mjs <页面>...

import { readFile } from 'node:fs/promises'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('  用法：node scripts/check-placeholders.mjs <页面>...')
  process.exit(2)
}

let left = 0
for (const f of files) {
  const lines = (await readFile(f, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    if (!/<[a-z][^<>]*\sdata-todo(?=[\s=>/])/i.test(line)) return
    left++
    console.error(`  ✗ ${f}:${i + 1} 还有占位：${line.trim().slice(0, 72)}`)
  })
}

if (left) {
  console.error(`\n  ${left} 处占位没填完。改好内容、删掉 data-todo 再发版。\n`)
  process.exit(1)
}
console.log('  ✓ 没有占位')
