// tests/test_hits.js —— 访客统计写入路径的回归（Node 22，零依赖）。
//
// 两组最要紧的断言：
//   1. 「客户端说了不算」的字段（ts / site / country）必须被明确拒绝。
//      一旦能夹带，统计就变成了「访客想让你看到什么」。
//   2. 没收到离开事件的访问，dwell 必须是 null 而不是 0。
//      当成 0 秒会把中位停留时长直接拉垮，而那其实是浏览器崩溃、
//      强杀 App、断网 —— 不是「看了 0 秒」。

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
  const M = await import(pathToFileURL(path.join(__dirname, '../admin/src/hits.mjs')).href);
  const { siteOf, validateHit, refHost, dayNum, dayToISO, quantile, summarizeDwell,
          fillDays, shouldAlert, looksLikeBot,
          MAX_DWELL_MS, HIT_CAP, ROWS_PER_VIEW, ROWS_PER_END, SITES } = M;

  // ── 1. Origin 校验 ─────────────────────────────────────
  ok('主页 Origin', siteOf('https://sakuramu.edu.kg') === 'home');
  ok('关于页 Origin', siteOf('https://about.sakuramu.edu.kg') === 'about');
  // 子串伪装：用 startsWith/includes 写就会在这里翻车
  for (const o of [
    'https://sakuramu.edu.kg.evil.com',
    'https://evil.com/https://sakuramu.edu.kg',
    'https://sakuramu.edu.kg:8443',
    'http://sakuramu.edu.kg',              // 明文不算
    'https://SAKURAMU.EDU.KG',             // 大小写不做归一，严格相等
    'https://notes.sakuramu.edu.kg',       // 别的子域也不行
    'null', '', null, undefined, 123, {},
  ]) {
    ok('拒绝 Origin ' + JSON.stringify(o), siteOf(o) === null, String(siteOf(o)));
  }
  ok('只有两个站点', Object.keys(SITES).length === 2);
  // 原型链上的键不能被当成合法 Origin
  ok('constructor 不是合法 Origin', siteOf('constructor') === null);
  ok('__proto__ 不是合法 Origin', siteOf('__proto__') === null);

  // ── 2. 载荷校验：客户端说了不算的字段 ──────────────────
  const view = { t: 'view', id: 'abc12345', p: '/', r: '' };
  ok('最小 view 合法', validateHit(view).ok, JSON.stringify(validateHit(view)));
  ok('最小 end 合法', validateHit({ t: 'end', id: 'abc12345', d: 1000 }).ok);

  // ★ 这一组是整个文件的核心
  for (const k of ['ts', 'site', 'country', 's', 'ip', 'ua']) {
    const r = validateHit({ ...view, [k]: 'x' });
    ok('拒绝客户端夹带 ' + k, !r.ok && r.why.startsWith('unknown_field'), JSON.stringify(r));
  }
  ok('拒绝原型污染字段', !validateHit({ ...view, constructor: 1 }).ok
     && !validateHit({ ...view, prototype: 1 }).ok);

  ok('非对象被拒', !validateHit('x').ok && !validateHit(null).ok && !validateHit([]).ok);
  ok('未知事件类型被拒', !validateHit({ t: 'hack', id: 'abc12345' }).ok);
  ok('缺 t 被拒', !validateHit({ id: 'abc12345', p: '/' }).ok);
  ok('view 缺 id 被拒', !validateHit({ t: 'view', p: '/' }).ok);
  ok('view 缺 p 被拒', !validateHit({ t: 'view', id: 'abc12345' }).ok);
  ok('end 缺 d 被拒', !validateHit({ t: 'end', id: 'abc12345' }).ok);
  ok('view 的字段不能用在 end 上', !validateHit({ t: 'end', id: 'abc12345', d: 1, p: '/' }).ok);

  // id 形态
  for (const id of ['', 'abc', 'ABC12345', 'abc-1234', 'abc 1234', 'a'.repeat(33), '../../x', 1234]) {
    ok('拒绝 id ' + JSON.stringify(id), !validateHit({ ...view, id: id }).ok);
  }
  ok('接受 32 位 id', validateHit({ ...view, id: 'a'.repeat(32) }).ok);

  // 路径
  ok('路径必须以 / 开头', !validateHit({ ...view, p: 'about' }).ok);
  ok('路径过长被拒', !validateHit({ ...view, p: '/' + 'x'.repeat(200) }).ok);
  ok('接受带子路径', validateHit({ ...view, p: '/notes/2026' }).ok);

  // 停留时长边界
  ok('负数时长被拒', !validateHit({ t: 'end', id: 'abc12345', d: -1 }).ok);
  ok('超 24 小时被拒', !validateHit({ t: 'end', id: 'abc12345', d: MAX_DWELL_MS + 1 }).ok);
  ok('刚好 24 小时可以', validateHit({ t: 'end', id: 'abc12345', d: MAX_DWELL_MS }).ok);
  ok('小数时长被拒', !validateHit({ t: 'end', id: 'abc12345', d: 1.5 }).ok);
  ok('字符串时长被拒', !validateHit({ t: 'end', id: 'abc12345', d: '100' }).ok);
  ok('0 毫秒可以（秒关是真实情况）', validateHit({ t: 'end', id: 'abc12345', d: 0 }).ok);

  // 来源
  ok('r 可省略', validateHit({ t: 'view', id: 'abc12345', p: '/' }).ok);
  ok('r 省略时补空串', validateHit({ t: 'view', id: 'abc12345', p: '/' }).value.r === '');
  ok('接受主机名', validateHit({ ...view, r: 'news.ycombinator.com' }).ok);
  ok('拒绝完整 URL 当 r', !validateHit({ ...view, r: 'https://x.com/a?b=1' }).ok);
  ok('拒绝无点的 r', !validateHit({ ...view, r: 'localhost' }).ok);

  // ── 3. refHost：查询串不许漏出来 ───────────────────────
  ok('完整 URL 只取主机', refHost('https://x.com/path?utm=abc') === 'x.com', refHost('https://x.com/path?utm=abc'));
  ok('不含查询串', refHost('https://x.com/a?token=secret').indexOf('secret') === -1);
  ok('不含路径', refHost('https://x.com/private/page').indexOf('private') === -1);
  ok('裸主机名原样返回', refHost('x.com') === 'x.com');
  ok('空返回空', refHost('') === '' && refHost(null) === '' && refHost(undefined) === '');
  ok('非法输入返回空而不是抛', refHost('!!!') === '', refHost('!!!'));

  // ── 4. 按时区切天（整数日序号） ────────────────────────
  // UTC 15:59:59 与 16:00:00 正好跨北京时间的零点 —— 必须落在相邻两天
  const before = Date.UTC(2026, 8, 12, 15, 59, 59);
  const after  = Date.UTC(2026, 8, 12, 16, 0, 0);
  ok('跨北京零点分成两天', dayNum(after) === dayNum(before) + 1,
     dayNum(before) + ' → ' + dayNum(after));
  ok('同一北京日内是同一天',
     dayNum(Date.UTC(2026, 8, 12, 16, 30)) === dayNum(Date.UTC(2026, 8, 13, 3, 0)));
  ok('日序号转 ISO 往返', dayToISO(dayNum(after)) === '2026-09-13', dayToISO(dayNum(after)));
  ok('日序号是整数', Number.isInteger(dayNum(Date.now())));

  // ── 5. 分位数与停留汇总：null 不能当成 0 ───────────────
  ok('中位数奇数个', quantile([1, 3, 5], 0.5) === 5 || quantile([1, 3, 5], 0.5) === 3,
     String(quantile([1, 3, 5], 0.5)));
  ok('空集返回 null 而不是 0', quantile([], 0.5) === null, String(quantile([], 0.5)));
  ok('undefined 返回 null', quantile(undefined, 0.5) === null);

  {
    // 5 次访问，只有 3 次收到离开事件
    const s1 = summarizeDwell([10000, 20000, 30000], 5);
    ok('样本数', s1.sampled === 3, JSON.stringify(s1));
    ok('访问数用总数而不是样本数', s1.views === 5, JSON.stringify(s1));
    ok('覆盖率 3/5', s1.coverage === 0.6, JSON.stringify(s1));
    ok('中位数来自非空样本', s1.p50 === 20000, JSON.stringify(s1));
    // ★ 如果把两个缺失当成 0，中位数会掉到 10000
    ok('缺失的没被当成 0（反证）', s1.p50 !== 10000, JSON.stringify(s1));
  }
  {
    // ★ 一条离开事件都没收到
    const s2 = summarizeDwell([], 8);
    ok('全缺失时中位数是 null 而不是 0', s2.p50 === null, JSON.stringify(s2));
    ok('全缺失时均值是 null 而不是 0', s2.mean === null, JSON.stringify(s2));
    ok('全缺失时覆盖率是 0', s2.coverage === 0, JSON.stringify(s2));
  }
  {
    // ★ 一次访问都没有 —— 覆盖率不能显示成 100%
    const s3 = summarizeDwell([], 0);
    ok('零访问时覆盖率是 null 而不是 1', s3.coverage === null, JSON.stringify(s3));
  }
  ok('null 混在样本里会被滤掉',
     summarizeDwell([null, 10000, null, 20000, 30000], 5).p50 === 20000,
     JSON.stringify(summarizeDwell([null, 10000, null, 20000, 30000], 5)));
  ok('NaN 被滤掉', summarizeDwell([NaN, 5000], 2).sampled === 1);

  // ── 6. 柱状图补洞 ──────────────────────────────────────
  {
    const f = fillDays([{ day: 100, views: 3 }, { day: 103, views: 1 }], 100, 104);
    ok('长度等于区间', f.length === 5, String(f.length));
    ok('中间的空日补 0', f[1].views === 0 && f[2].views === 0, JSON.stringify(f));
    ok('有数据的日保留', f[0].views === 3 && f[3].views === 1, JSON.stringify(f));
    ok('带上 ISO 日期', /^\d{4}-\d{2}-\d{2}$/.test(f[0].iso), f[0].iso);
    // 不补洞的话柱子会挤在一起，看上去像「天天有人来」
    ok('空区间返回等长全 0', fillDays([], 1, 3).every(function (x) { return x.views === 0; }));
  }

  // ── 7. 预算告警：不重复 ────────────────────────────────
  ok('没过半不告警', shouldAlert(100, 1000, null, 5) === false);
  ok('过半告警', shouldAlert(600, 1000, null, 5) === true);
  // 重复告警在这个仓库里是明确当缺陷处理的
  ok('同一天不重复告警', shouldAlert(600, 1000, 5, 5) === false);
  ok('跨天重新可告警', shouldAlert(600, 1000, 4, 5) === true);
  ok('cap 为 0 时不告警', shouldAlert(10, 0, null, 5) === false);

  // ── 8. 机器人判断：只返回布尔，不回传 UA ───────────────
  for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1)', 'curl/8.1', 'python-requests/2.31',
                    'HeadlessChrome/120', 'Scrapy/2.11']) {
    ok('识别为机器人 ' + ua.slice(0, 20), looksLikeBot(ua) === true, String(looksLikeBot(ua)));
  }
  ok('真实浏览器不算机器人',
     looksLikeBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36') === false);
  ok('返回的是布尔不是 UA', typeof looksLikeBot('curl/8') === 'boolean');
  ok('空 UA 不算机器人', looksLikeBot(null) === false && looksLikeBot(undefined) === false);

  // ── 9. 预算账目 ────────────────────────────────────────
  // D1 的口径：写入涉及被索引的列时索引也各算一行。
  // visits 有 id 主键索引 + idx_visits_ts，所以 INSERT 是 3 行不是 1 行。
  ok('一次 view 记 4 行（INSERT 3 + 预算表 1）', ROWS_PER_VIEW === 4, String(ROWS_PER_VIEW));
  ok('一次 end 记 2 行（UPDATE 1 + 预算表 1）', ROWS_PER_END === 2, String(ROWS_PER_END));
  // 闸 2 万 + 清理约 1.5 万 + 监控 1,800 要远低于账号级的 10 万
  ok('闸门给监控留足余量', HIT_CAP + HIT_CAP * 0.75 + 1800 < 100_000, String(HIT_CAP));

  // ── 10. 只写 Worker 的结构性质（源码级钉子） ───────────
  // 守的是 README 和文件头里那句承诺：这个 Worker 不把数据库的行交给响应。
  // 靠代码审查守不住，必须有断言钉着。
  {
    const fs = require('fs');
    const raw = fs.readFileSync(path.join(__dirname, '../hits-api/src/index.mjs'), 'utf8');
    // 先剥注释再判断 —— 注释里提到某个词不算代码里用了它
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('★ 从不把行集交给响应（无 .all(）', code.indexOf('.all(') === -1);
    ok('★ 不设 Cookie', !/set-cookie/i.test(code));
    ok('★ 不开 allow-credentials', !/allow-credentials/i.test(code));
    ok('★ 没有 GET /e（不能用 <img src> 跨站灌数据）',
       !/pathname\s*===\s*['"]\/e['"][^\n]*GET/i.test(code));
    // SELECT 只允许出现在：健康检查、两处闸子查询、一处 INSERT..SELECT
    const selects = (code.match(/SELECT/g) || []).length;
    ok('SELECT 数量在预期内（' + selects + '）', selects >= 4 && selects <= 8, String(selects));
  }

  console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                               : '✅ 访客统计校验全部通过，共 ' + passed + ' 条断言');
})().catch(e => { console.error('测试自身崩了：', e); process.exit(1); });
