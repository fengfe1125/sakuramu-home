#!/usr/bin/env node
// 发版前把线上载荷烧录进 public/index.html，作为统计服务不可达时的兜底。
//
// 设计上有两条硬规矩：
//   1. 拉取或校验失败**不阻断发版** —— 保留现有快照并大声警告。
//      统计服务偶尔抽风不该让主站发不出去。要在 CI 里当硬失败就加 --strict。
//   2. 写入前做结构校验 —— 宁可留着旧快照，也不把坏数据烧进页面。
//
// 用法：node scripts/refresh-snapshot.mjs [--strict]
// 可用环境变量覆盖：TT_ENDPOINT / TT_HANDLE

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'public/index.html')
const ENDPOINT = process.env.TT_ENDPOINT || 'https://tt.sakuramu.edu.kg'
const HANDLE = process.env.TT_HANDLE || 'sakuramu'
const STRICT = process.argv.includes('--strict')
const MARKER = /var TOKENS_SNAPSHOT = (\{[\s\S]*?\});/

function bail(msg) {
  console.error(`\n  ⚠ 快照未更新：${msg}`)
  if (STRICT) { console.error('  --strict 模式，中止。\n'); process.exit(1) }
  console.error('  保留页面里现有的快照，继续发版。\n')
  process.exit(0)
}

/** 结构校验：够抓住"服务返回了别的东西"和"载荷自相矛盾"这两类问题。 */
function check(d) {
  const need = ['v', 'generated_at', 'tz', 'range', 'totals', 'daily', 'streak', 'agents']
  for (const k of need) if (!(k in d)) return `缺少字段 ${k}`
  if (d.v !== 1) return `格式版本是 ${d.v}，页面只认 1`
  if (!Array.isArray(d.daily?.tokens)) return 'daily.tokens 不是数组'
  if (d.daily.tokens.length !== d.range.days) {
    return `daily.tokens 长度 ${d.daily.tokens.length} 与 range.days ${d.range.days} 不符`
  }
  if (!d.daily.tokens.every(n => Number.isSafeInteger(n) && n >= 0)) return 'daily.tokens 含非法值'
  const sum = d.daily.tokens.reduce((a, b) => a + b, 0)
  if (sum !== d.daily.window_tokens) return `求和 ${sum} 与 window_tokens ${d.daily.window_tokens} 不符`
  if (d.totals.tokens_dated + d.totals.tokens_undated !== d.totals.tokens) {
    return 'totals 恒等式不成立（dated + undated ≠ tokens）'
  }
  if (d.daily.start !== d.range.from) return 'daily.start 与 range.from 不一致'
  return null
}

const url = `${ENDPOINT}/v1/stats/${HANDLE}`
let payload
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) bail(`${url} 返回 HTTP ${res.status}`)
  payload = await res.json()
} catch (e) {
  bail(`拉取 ${url} 失败 —— ${e.message}`)
}

const bad = check(payload)
if (bad) bail(bad)

const html = await readFile(TARGET, 'utf8')
const found = html.match(MARKER)
if (!found) bail(`在 ${TARGET} 里找不到 TOKENS_SNAPSHOT`)

const next = JSON.stringify(payload)
if (found[1] === next) {
  console.log(`  ✓ 快照已是最新（${payload.generated_at}），无需改动`)
  process.exit(0)
}

const prev = JSON.parse(found[1])
await writeFile(TARGET, html.replace(MARKER, () => `var TOKENS_SNAPSHOT = ${next};`))
console.log(`  ✓ 快照已更新  ${prev.streak.current} 天 → ${payload.streak.current} 天`)
console.log(`    ${prev.generated_at} → ${payload.generated_at}  (${next.length} 字节)`)
