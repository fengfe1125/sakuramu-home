#!/usr/bin/env node
// 发版前刷新页面里烧录的两份兜底快照：
//   · TOKENS_SNAPSHOT —— 来自 tt.sakuramu.edu.kg
//   · PROJECTS        —— 来自 GitHub API
// 两者都是"远端不可达时静默回落"的兜底数据，手动维护必然漂。
//
// 三条硬规矩：
//   1. 任何一份失败都**不阻断发版** —— 保留现有快照、大声警告、退出码 0。
//      远端偶尔抽风不该让主站发不出去。CI 里想当硬失败加 --strict。
//   2. 写入前做结构校验 —— 宁可留着旧快照，也不把坏数据烧进页面。
//   3. 两份互不牵连 —— 一份挂了另一份照常更新。
//
// 用法：node scripts/refresh-snapshot.mjs [--strict]
// 环境变量：TT_ENDPOINT / TT_HANDLE / GH_USER

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = join(ROOT, 'public/index.html')
const ENDPOINT = process.env.TT_ENDPOINT || 'https://tt.sakuramu.edu.kg'
const HANDLE = process.env.TT_HANDLE || 'sakuramu'
const GH_USER = process.env.GH_USER || 'fengfe1125'
const STRICT = process.argv.includes('--strict')

const TOKENS_RE = /var TOKENS_SNAPSHOT = (\{[\s\S]*?\});/
const PROJECTS_RE = /var PROJECTS = (\[[\s\S]*?\]);/

async function getJSON(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: { 'user-agent': 'sakuramu-home-snapshot' },
  })
  if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}`)
  return res.json()
}

// ───────────────────────────────────────────────── Token 快照 ────
function checkTokens(d) {
  for (const k of ['v', 'generated_at', 'tz', 'range', 'totals', 'daily', 'streak', 'agents']) {
    if (!(k in d)) return `缺少字段 ${k}`
  }
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

async function refreshTokens(html) {
  const found = html.match(TOKENS_RE)
  if (!found) throw new Error('页面里找不到 TOKENS_SNAPSHOT')
  const fresh = await getJSON(`${ENDPOINT}/v1/stats/${HANDLE}`)
  const bad = checkTokens(fresh)
  if (bad) throw new Error(bad)

  const next = JSON.stringify(fresh)
  if (found[1] === next) return { html, note: `已是最新（${fresh.generated_at}）` }
  const prev = JSON.parse(found[1])
  return {
    html: html.replace(TOKENS_RE, () => `var TOKENS_SNAPSHOT = ${next};`),
    note: `${prev.streak.current} 天 → ${fresh.streak.current} 天`
       + `，${prev.generated_at} → ${fresh.generated_at}`,
    changed: true,
  }
}

// ─────────────────────────────────────────────────── 项目快照 ────
async function refreshProjects(html) {
  const found = html.match(PROJECTS_RE)
  if (!found) throw new Error('页面里找不到 PROJECTS')
  const prev = JSON.parse(found[1])

  const raw = await getJSON(`https://api.github.com/users/${GH_USER}/repos?sort=pushed&per_page=100`)
  if (!Array.isArray(raw)) throw new Error('GitHub 返回的不是数组')
  // 与页面 index.html 里的过滤条件保持一致
  const live = raw
    .filter(x => !x.fork && !x.archived && x.name !== 'sakuramu-home')
    .map(x => ({ n: x.name, d: x.description, l: x.language,
                 s: x.stargazers_count, p: x.pushed_at }))
  if (!live.length) throw new Error('过滤后一个仓库都不剩，八成是拿错了数据')

  const by = Object.fromEntries(live.map(r => [r.n, r]))
  // 合并规则必须与页面里的 merge() 完全一致：
  // t / d / g 是手写的中文内容，GitHub 永不覆盖；只有 l / s / p 跟着远端走。
  const out = prev.map(p => {
    const m = by[p.n]
    return m ? { n: p.n, t: p.t, d: p.d, g: p.g, l: m.l || p.l, s: m.s, p: m.p } : p
  })
  const added = []
  for (const r of live) {
    if (!prev.some(p => p.n === r.n) && r.d) {
      out.push({ n: r.n, t: r.n, d: r.d, g: [], l: r.l, s: r.s, p: r.p })
      added.push(r.n)
    }
  }
  out.sort((a, b) => new Date(b.p) - new Date(a.p))

  const next = JSON.stringify(out, null, 4).split('\n').join('\n    ')
  if (found[1] === next) return { html, note: `已是最新（${out.length} 个仓库）` }

  const moved = out.filter((p, i) => prev[i]?.n !== p.n).length
  const notes = [`${prev.length} → ${out.length} 个`]
  if (added.length) notes.push(`新增 ${added.join('、')}`)
  if (moved) notes.push(`${moved} 个次序或数据有变`)
  return {
    html: html.replace(PROJECTS_RE, () => `var PROJECTS = ${next};`),
    note: notes.join('，'),
    changed: true,
  }
}

// ───────────────────────────────────────────────────────── 主流程 ────
let html = await readFile(TARGET, 'utf8')
let dirty = false
let failed = false

for (const [label, task] of [['Token', refreshTokens], ['项目', refreshProjects]]) {
  try {
    const r = await task(html)
    html = r.html
    if (r.changed) dirty = true
    console.log(`  ${r.changed ? '✓' : '·'} ${label}快照 ${r.note}`)
  } catch (e) {
    failed = true
    console.error(`  ⚠ ${label}快照未更新：${e.message}`)
  }
}

if (dirty) await writeFile(TARGET, html)

if (failed) {
  if (STRICT) { console.error('\n  --strict 模式，中止。\n'); process.exit(1) }
  console.error('  以上失败项保留页面里现有的快照，继续发版。')
}
