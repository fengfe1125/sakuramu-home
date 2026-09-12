// tests/test_noteapi.js —— 手记写入路径的校验回归（Node 22，零依赖）。
//
// 最要紧的一条是「拒绝 html 字段」：手记的 HTML 永远由服务端 render(md) 生成。
// 一旦接受客户端提交的 HTML，转义的责任就交给了浏览器端，
// 那条链上任何一环失守都是自己域名上的存储型 XSS。
// 这条性质靠代码审查守不住，必须有断言钉着。

'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; return; }
  console.error('❌ ' + name + (detail ? '  → ' + detail : ''));
  process.exitCode = 1;
}

(async function main() {
  const M = await import(pathToFileURL(path.join(__dirname, '../admin/src/notes.mjs')).href);
  const { validSlug, suggestSlug, validDate, validateNote } = M;

  // ── 1. slug ────────────────────────────────────────────
  for (const s of ['a', 'abc', 'a-b', '2026-09-11-first', 'x1', 'a'.repeat(80)]) {
    ok('接受 slug ' + JSON.stringify(s), validSlug(s), String(validSlug(s)));
  }
  for (const s of ['', '-a', 'a-', 'A', 'a_b', 'a.b', 'a b', 'a/b', '中文', 'a'.repeat(81),
                   '..', '../x', 'a%2Fb', null, undefined, 123, {}]) {
    ok('拒绝 slug ' + JSON.stringify(s), !validSlug(s));
  }

  ok('标题生成 slug', suggestSlug('Hello World!') === 'hello-world', suggestSlug('Hello World!'));
  ok('连续符号折叠', suggestSlug('a---b') === 'a-b', suggestSlug('a---b'));
  ok('首尾符号剥掉', suggestSlug('!!a!!') === 'a', suggestSlug('!!a!!'));
  // 纯中文标题生成不出东西 —— 返回空串，由调用方决定怎么办，不要瞎编
  ok('纯中文返回空串', suggestSlug('把重复的操作变成不用想的操作') === '',
     JSON.stringify(suggestSlug('把重复的操作变成不用想的操作')));
  ok('生成结果本身是合法 slug 或空',
     ['hello-world', ''].every(x => x === '' || validSlug(x)));

  // ── 2. 日期必须是真实存在的那一天 ───────────────────────
  for (const d of ['2026-09-11', '2024-02-29', '2026-01-01', '2026-12-31']) {
    ok('接受日期 ' + d, validDate(d));
  }
  for (const d of ['2026-13-45', '2026-02-30', '2025-02-29', '2026-00-10', '2026-09-00',
                   '2026-9-11', '26-09-11', '2026/09/11', 'today', '', null]) {
    ok('拒绝日期 ' + JSON.stringify(d), !validDate(d));
  }

  // ── 3. 写入载荷 ────────────────────────────────────────
  const base = { title: '标题', date: '2026-09-11', md: '正文' };
  ok('最小合法载荷', validateNote(base).ok, JSON.stringify(validateNote(base)));
  ok('缺 title', !validateNote({ date: '2026-09-11', md: 'x' }).ok);
  ok('缺 date', !validateNote({ title: 't', md: 'x' }).ok);
  ok('缺 md', !validateNote({ title: 't', date: '2026-09-11' }).ok);
  ok('非对象被拒', !validateNote('x').ok && !validateNote(null).ok && !validateNote([]).ok);

  // ★ 这一组是整个文件的核心
  const withHtml = validateNote({ ...base, html: '<img src=x onerror=alert(1)>' });
  ok('拒绝客户端提交的 html', !withHtml.ok && /未知字段/.test(withHtml.errors.join()),
     JSON.stringify(withHtml));
  ok('拒绝 slug 字段（slug 来自路径，不从载荷取）', !validateNote({ ...base, slug: 'x' }).ok);
  ok('拒绝 updated_at', !validateNote({ ...base, updated_at: 1 }).ok);
  ok('拒绝原型污染字段', !validateNote({ ...base, constructor: 1 }).ok
     && !validateNote({ ...base, prototype: 1 }).ok);

  ok('正文全空白被拒', !validateNote({ ...base, md: '   \n  ' }).ok);
  ok('标题全空白被拒', !validateNote({ ...base, title: '   ' }).ok);
  ok('标题过长被拒', !validateNote({ ...base, title: 'x'.repeat(121) }).ok);
  ok('正文过长被拒', !validateNote({ ...base, md: 'x'.repeat(200_001) }).ok);
  ok('正文刚好到上限可以', validateNote({ ...base, md: 'x'.repeat(200_000) }).ok);

  ok('published 布尔归一',
     validateNote({ ...base, published: true }).value.published === 1
     && validateNote({ ...base, published: false }).value.published === 0);
  ok('published 非法值被拒', !validateNote({ ...base, published: 2 }).ok
     && !validateNote({ ...base, published: 'yes' }).ok);

  // 局部更新
  ok('局部更新只改一个字段', validateNote({ published: 1 }, { partial: true }).ok);
  ok('局部更新空对象被拒', !validateNote({}, { partial: true }).ok);
  ok('局部更新仍拒 html', !validateNote({ html: '<b>' }, { partial: true }).ok);
  ok('局部更新只带回给定字段',
     Object.keys(validateNote({ published: 1 }, { partial: true }).value).join() === 'published');

  console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                               : '✅ 手记写入校验全部通过，共 ' + passed + ' 条断言');
})().catch(e => { console.error('测试自身崩了：', e); process.exit(1); });
