// tests/test_fonts.js —— 字体自托管的回归（Node 22，零依赖，不出网）。
//
// 钉住三件事：
//   1. 解析：Google 的样式表里，中文切片没有注释头，一条都不能漏认 ——
//      漏认一片就是那片字静默退回系统字体。第一版就只认出了 609 条里的 33 条。
//   2. 合并：同一文件、同一片字、只差字重的声明合并成范围；别的都不能合并。
//   3. 地址：只认 fonts.gstatic.com 的 woff2，本地路径保留字体名和版本号，拼不出 public/ 外面的路径。
//
// 最后跑一遍仓库里真实产物的 --check：样式表引用的文件都在、页面指纹对得上、CSP 放行。

'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const SCRIPT = path.join(__dirname, '../scripts/build-fonts.mjs');

let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; return; }
  console.error('❌ ' + name + (detail ? '  → ' + detail : ''));
  process.exitCode = 1;
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

// Google 样式表里的一条声明：拉丁这类分组带注释，中文切片不带
function face({ sub, family, weight, file, range }) {
  return (sub ? '/* ' + sub + ' */\n' : '') + '@font-face {\n'
    + "  font-family: '" + family + "';\n  font-style: normal;\n  font-weight: " + weight + ';\n'
    + '  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/' + file + ") format('woff2');\n"
    + '  unicode-range: ' + range + ';\n}\n';
}

(async () => {
  const m = await import(pathToFileURL(SCRIPT).href);

  // ── 1. 解析 ────────────────────────────────────────────
  const sans = w => face({ family: 'Noto Sans SC', weight: w, file: 'notosanssc/v40/a.0.woff2', range: 'U+4e00-4e01, U+4e03' });
  const css = sans(400) + sans(500) + sans(700)
    + face({ family: 'Noto Sans SC', weight: 400, file: 'notosanssc/v40/a.1.woff2', range: 'U+4e04' })
    + face({ sub: 'latin', family: 'Caveat', weight: '500 700', file: 'caveat/v23/c.woff2', range: 'U+0000-00FF, U+0131' });
  const parsed = m.parse(css);
  ok('没有注释头的中文切片也认得出', parsed.length === 5, parsed.length);
  ok('有注释头的记下分组名', parsed[4].subset === 'latin', JSON.stringify(parsed[4]));
  ok('声明不完整就报错，不静默跳过', throws(() => m.parse('/* x */ @font-face { font-family: X; }')));

  // ── 2. 合并 ────────────────────────────────────────────
  const faces = m.merge(parsed);
  ok('五条声明合并成三条', faces.length === 3, faces.length);
  const a0 = faces.find(f => f.file === 'notosanssc/v40/a.0.woff2');
  ok('同一文件的 400/500/700 合并成 400–700', a0 && a0.lo === 400 && a0.hi === 700, JSON.stringify(a0));
  ok('另一片自己一条', faces.some(f => f.file === 'notosanssc/v40/a.1.woff2' && f.lo === 400 && f.hi === 400));
  ok('本来就是范围的字重原样保留', faces.some(f => f.family === 'Caveat' && f.lo === 500 && f.hi === 700));
  {
    const two = m.merge(m.parse(
      face({ family: 'Noto Sans SC', weight: 400, file: 'notosanssc/v40/a.0.woff2', range: 'U+4e00' })
      + face({ family: 'Noto Sans SC', weight: 700, file: 'notosanssc/v40/b.0.woff2', range: 'U+4e00' })));
    ok('文件不同就不合并', two.length === 2, two.length);
  }

  // ── 生成的样式表 ────────────────────────────────────────
  const out = m.render(faces);
  ok('用相对地址，不再指向 Google', out.includes('src:url(notosanssc/v40/a.0.woff2)') && !/gstatic|googleapis/.test(out), out);
  ok('范围字重写成「400 700」', out.includes('font-weight:400 700;'));
  ok('单档字重写成一个数', out.includes('font-weight:400;'));
  ok('unicode-range 去掉逗号后的空格', out.includes('unicode-range:U+4e00-4e01,U+4e03}'));
  ok('保留分组注释（预载靠它找到 Caveat latin）', out.includes('/* latin */@font-face'));
  ok('读得回来，条数不变（--check 靠它）', m.parse(out).length === 3);
  ok('内容变了指纹就变', m.fingerprint(out) !== m.fingerprint(out + ' ') && /^[0-9a-f]{10}$/.test(m.fingerprint(out)));

  // ── 3. 地址 ────────────────────────────────────────────
  ok('gstatic 地址转成本地路径', m.localPath('https://fonts.gstatic.com/s/longcang/v21/X_y-1.2.woff2') === 'longcang/v21/X_y-1.2.woff2');
  for (const bad of [
    'https://evil.example/s/longcang/v21/x.woff2',
    'https://fonts.gstatic.com/s/longcang/v21/../../../x.woff2',
    'https://fonts.gstatic.com/s/longcang/v21/x.ttf',
    'http://fonts.gstatic.com/s/longcang/v21/x.woff2',
  ]) ok('拒绝：' + bad, throws(() => m.localPath(bad)));
  ok('合并时遇到怪地址直接报错', throws(() => m.merge(m.parse(
    "@font-face { font-family: 'X'; font-weight: 400; src: url(https://evil.example/x.woff2) format('woff2'); unicode-range: U+0; }"))));

  // ── 仓库里的真实产物 ────────────────────────────────────
  const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
  ok('仓库里的字体产物自洽（--check）', r.status === 0, r.stdout + r.stderr);

  console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                               : '✅ 字体自托管全部通过，共 ' + passed + ' 条断言');
})().catch(e => { console.error(e); process.exitCode = 1; });
