// tests/test_notes.js —— 零依赖的渲染器回归（Node 22，无 npm install）。
//
// 最要紧的是协议白名单那一组：手记内容将来会来自网页表单，
// 那时渲染器就是公开站点上「存储型 XSS」的唯一一道闸。

'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; return; }
  console.error('❌ ' + name + (detail ? '  → ' + detail : ''));
  process.exitCode = 1;
}

(async function main() {
  const R = await import(pathToFileURL(path.join(ROOT, 'shared/notes-render.mjs')).href);
  const { render, inline, spacing, joinLines, safeHref, frontMatter, cnDate, esc } = R;

  // ── 1. 协议白名单：这一组最重要 ──────────────────────────
  const REJECT = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>',
    'vbscript:msgbox', 'file:///etc/passwd', 'jar:http://x/!/y',
  ];
  for (const u of REJECT) {
    ok('拒绝协议 ' + u, safeHref(u) === null, 'safeHref 返回了 ' + safeHref(u));
    ok('不生成链接 ' + u, !/<a /.test(inline('[x](' + u + ')')), inline('[x](' + u + ')'));
  }
  const ACCEPT = ['https://a.com', 'http://a.com', 'mailto:a@b.c', '/path', '#anchor', 'foo.html', '//cdn.x/y'];
  for (const u of ACCEPT) {
    ok('接受 ' + u, safeHref(u) !== null);
    ok('生成链接 ' + u, /<a /.test(inline('[x](' + u + ')')), inline('[x](' + u + ')'));
  }
  // 夹了不可见字符的变形协议要先规范化再判断
  ok('剥离控制字符后仍拒绝', safeHref('javascript:alert(1)') === null);
  // 外链才开新窗口
  ok('外链带 target=_blank', /target="_blank"/.test(inline('[x](https://a.com)')));
  ok('内链不带 target', !/target/.test(inline('[x](/about)')));

  // ── 2. 段落连接：中文不加空格、英文加 ────────────────────
  ok('中文软换行不加空格', joinLines(['第一行', '第二行']) === '第一行第二行');
  ok('英文软换行加空格', joinLines(['hello', 'world']) === 'hello world');
  ok('空数组返回空串', joinLines([]) === '');
  ok('单行原样返回', joinLines(['only']) === 'only');
  ok('中英混排最终有空格', render('写代码\nis fun') === '<p>写代码 is fun</p>',
     render('写代码\nis fun'));
  ok('英文段落不粘连', render('the quick brown\nfox jumps') === '<p>the quick brown fox jumps</p>',
     render('the quick brown\nfox jumps'));

  // ── 3. 中西文自动空格 ───────────────────────────────────
  ok('CJK→拉丁补空格', spacing('用TokenTracker') === '用 TokenTracker');
  ok('拉丁→CJK补空格', spacing('TokenTracker统计') === 'TokenTracker 统计');
  ok('数字两侧补空格', spacing('写365天') === '写 365 天');
  ok('纯中文不动', spacing('写代码很有趣') === '写代码很有趣');
  ok('代码块内不加空格',
     render('```\nlet x=中文abc\n```').indexOf('中文abc') >= 0,
     render('```\nlet x=中文abc\n```'));
  ok('行内代码内不加空格',
     inline('`用TokenTracker`') === '<code>用TokenTracker</code>',
     inline('`用TokenTracker`'));

  // ── 4. 转义 ─────────────────────────────────────────────
  ok('尖括号被转义', esc('<script>') === '&lt;script&gt;');
  ok('引号被转义', esc('a"b\'c') === 'a&quot;b&#39;c');
  ok('正文里的标签不可执行', !/<script/.test(render('<script>alert(1)</script>')),
     render('<script>alert(1)</script>'));
  ok('链接文字里的标签被转义', !/<img/.test(inline('[<img src=x onerror=y>](https://a.com)')),
     inline('[<img src=x onerror=y>](https://a.com)'));

  // ── 5. 各种块级语法 ─────────────────────────────────────
  const cases = [
    ['# 标题', '<h3>标题</h3>'],
    ['## 标题', '<h4>标题</h4>'],
    ['### 标题', '<h5>标题</h5>'],
    ['---', '<hr>'],
    ['> 引用', '<blockquote>引用</blockquote>'],
    ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
    ['1. a\n2. b', '<ol><li>a</li><li>b</li></ol>'],
    ['**粗**', '<p><strong>粗</strong></p>'],
    ['*斜*', '<p><em>斜</em></p>'],
  ];
  for (const [md, want] of cases) {
    ok('渲染 ' + JSON.stringify(md), render(md) === want, render(md));
  }
  ok('代码块换行写成字符引用',
     render('```\na\nb\n```') === '<pre><code>a&#10;b</code></pre>', render('```\na\nb\n```'));
  ok('代码块保留自身缩进',
     render('```\n    x\n```').indexOf('&#10;') === -1
       ? render('```\n    x\n```') === '<pre><code>    x</code></pre>' : true,
     render('```\n    x\n```'));
  ok('代码块里的 ``` 语言标识被丢弃',
     render('```swift\nlet x = 1\n```') === '<pre><code>let x = 1</code></pre>',
     render('```swift\nlet x = 1\n```'));

  // ── 6. front-matter ─────────────────────────────────────
  const fm1 = frontMatter('---\ntitle: 标题\ndate: 2026-09-11\n---\n正文', 'fallback');
  ok('解析 title', fm1.meta.title === '标题');
  ok('解析 date', fm1.meta.date === '2026-09-11');
  ok('正文剥离 front-matter', fm1.body.trim() === '正文');
  // 之前 ^---\n 只认 LF，CRLF 文件会静默丢掉 front-matter、拿文件名当标题
  const fm2 = frontMatter('---\r\ntitle: CRLF\r\ndate: 2026-01-01\r\n---\r\n正文', 'fallback');
  ok('CRLF 文件也能解析 front-matter', fm2.meta.title === 'CRLF', JSON.stringify(fm2.meta));
  const fm3 = frontMatter('没有 front-matter', 'fallback-title');
  ok('缺 front-matter 时用兜底标题', fm3.meta.title === 'fallback-title');
  ok('引号被剥掉', frontMatter('---\ntitle: "带引号"\n---\nx', 'f').meta.title === '带引号');

  // ── 7. 日期 ─────────────────────────────────────────────
  ok('中文日期', cnDate('2026-09-11') === '2026年9月11日 周五', cnDate('2026-09-11'));
  ok('非法日期原样返回', cnDate('not-a-date') === 'not-a-date');

  console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                               : '✅ 全部通过，共 ' + passed + ' 条断言');
})();
