// tests/test_placeholders.js —— 发版闸的回归（Node 22，零依赖，不出网）。
//
// 这道闸拦的是「写给作者看的占位跟着发到线上」。它有两种失败方式，都要钉住：
//   1. 漏拦：占位还在，照样发出去了。
//   2. 误拦：页面里只是提到了 data-todo 这个词（共用样式的注释、[data-todo] 选择器），
//      却被当成占位，把本来能发的主站也拦下了。第一版就是这样。
//
// 最后一段直接跑两份真页面：主站必须放行；关于页有没有占位由内容决定，这里不断言。

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '../scripts/check-placeholders.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placeholders-'));

let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; return; }
  console.error('❌ ' + name + (detail ? '  → ' + detail : ''));
  process.exitCode = 1;
}

function check(html) {
  const f = path.join(dir, 'page-' + (passed + Math.random()).toString(36).slice(2) + '.html');
  fs.writeFileSync(f, html);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

try {
  // ── 1. 该拦的 ─────────────────────────────────────────
  for (const [name, html] of [
    ['裸属性', '<p data-todo>写点什么</p>'],
    ['属性在中间', '<div class="prose" data-todo id="x">…</div>'],
    ['带值的属性', '<dl class="kv" data-todo="stack">…</dl>'],
    ['自闭合', '<img alt="" data-todo/>'],
    ['大写标签', '<P DATA-TODO>…</P>'],
  ]) {
    const r = check(html);
    ok('拦下：' + name, r.code === 1, r.out);
  }
  {
    const r = check('<p>好的</p>\n<p data-todo>第二行</p>\n');
    ok('指出行号', r.out.includes(':2 '), r.out);
  }

  // ── 2. 不该拦的 ───────────────────────────────────────
  for (const [name, html] of [
    ['样式里的选择器', '<style>[data-todo] { outline:1px dashed; }</style>'],
    ['注释里提到这个词', '/* 发版脚本见到 data-todo 就拒绝部署 */'],
    ['正文里提到这个词', '<p>删掉 data-todo 再发版</p>'],
    ['相似的属性名', '<p data-todos="3">…</p>'],
    ['没有占位', '<p>一切正常</p>'],
  ]) {
    const r = check(html);
    ok('放行：' + name, r.code === 0, r.out);
  }

  // ── 3. 用法错误不能当成「通过」 ─────────────────────────
  {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    ok('不给文件时非零退出', r.status !== 0, r.stdout + r.stderr);
  }

  // ── 4. 真页面：主站不该有占位 ───────────────────────────
  {
    const r = spawnSync(process.execPath, [SCRIPT, path.join(__dirname, '../public/index.html')], { encoding: 'utf8' });
    ok('主站放行', r.status === 0, r.stdout + r.stderr);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                             : '✅ 发版闸全部通过，共 ' + passed + ' 条断言');
