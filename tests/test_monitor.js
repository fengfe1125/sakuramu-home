// tests/test_monitor.js —— 监控状态机与探测的回归（Node 22，零依赖）。
//
// 重点在 nextState：监控系统真正的价值在于「该报的报、不该报的不报」，
// 而重复告警和抖动误报都只在特定的状态序列下才出现，肉眼审不出来。
// 这里把完整序列跑一遍。

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
  const M = await import(pathToFileURL(path.join(__dirname, '../admin/src/monitor.mjs')).href);
  const { isDue, verdict, nextState, uptime, probe, MAX_BODY } = M;

  // ── 1. 状态机：完整序列 ─────────────────────────────────
  // 从 up 出发，retries=2，连续失败要到第 3 次才判 down
  {
    let m = { state: 'up', fail_streak: 0, retries: 2 };
    const seq = [];
    for (const ok_ of [false, false, false, false, true, true]) {
      const r = nextState(m, ok_);
      seq.push(r.state + (r.event ? '!' + r.event : ''));
      m = { ...m, state: r.state, fail_streak: r.fail_streak };
    }
    ok('失败序列的状态迁移',
       seq.join(' → ') === 'pending → pending → down!down → down → up!recovered → up',
       seq.join(' → '));
  }

  // 单次抖动绝不告警 —— 这是 retries 存在的全部理由
  {
    let m = { state: 'up', fail_streak: 0, retries: 2 };
    const a = nextState(m, false);
    ok('单次失败不告警', a.event === null && a.state === 'pending', JSON.stringify(a));
    m = { ...m, state: a.state, fail_streak: a.fail_streak };
    const b = nextState(m, true);
    ok('抖动后恢复不发恢复通知', b.event === null && b.state === 'up' && b.fail_streak === 0, JSON.stringify(b));
  }

  // 两次失败也还不够
  {
    let m = { state: 'up', fail_streak: 0, retries: 2 };
    m = { ...m, ...nextState(m, false) };
    const two = nextState(m, false);
    ok('两次失败仍不告警', two.event === null && two.state === 'pending', JSON.stringify(two));
  }

  // 已经 down 了继续失败不能重复告警
  {
    const m = { state: 'down', fail_streak: 9, retries: 2 };
    const r = nextState(m, false);
    ok('持续 down 不重复告警', r.event === null && r.state === 'down', JSON.stringify(r));
    ok('持续 down 仍累加计数', r.fail_streak === 10, JSON.stringify(r));
  }

  // 从没 down 过就恢复，不该发「已恢复」
  {
    ok('pending→up 不发恢复通知', nextState({ state: 'pending', fail_streak: 2, retries: 2 }, true).event === null);
    ok('up→up 不发任何通知', nextState({ state: 'up', fail_streak: 0, retries: 2 }, true).event === null);
    ok('down→up 才发恢复通知',
       nextState({ state: 'down', fail_streak: 5, retries: 2 }, true).event === 'recovered');
  }

  // retries=0 表示一次失败就判定
  {
    const r = nextState({ state: 'up', fail_streak: 0, retries: 0 }, false);
    ok('retries=0 一次失败即 down', r.state === 'down' && r.event === 'down', JSON.stringify(r));
  }
  // retries 缺省时按 2 算
  {
    const r = nextState({ state: 'up', fail_streak: 0 }, false);
    ok('retries 缺省为 2', r.state === 'pending', JSON.stringify(r));
  }

  // ── 2. 到点判断 ────────────────────────────────────────
  const now = 1_700_000_000_000;
  ok('从没查过的算到点', isDue({ enabled: 1, last_check_at: null, interval_s: 300 }, now));
  ok('没到间隔不查', !isDue({ enabled: 1, last_check_at: now - 200_000, interval_s: 300 }, now));
  ok('刚好到间隔要查', isDue({ enabled: 1, last_check_at: now - 300_000, interval_s: 300 }, now));
  ok('超过间隔要查', isDue({ enabled: 1, last_check_at: now - 999_000, interval_s: 300 }, now));
  ok('停用的一律不查', !isDue({ enabled: 0, last_check_at: null, interval_s: 300 }, now));

  // ── 3. 响应判定 ────────────────────────────────────────
  ok('200 算好', verdict({}, { status: 200 }).ok);
  ok('204 算好', verdict({}, { status: 204 }).ok);
  ok('301 算好（重定向不是故障）', verdict({}, { status: 301 }).ok);
  ok('399 算好', verdict({}, { status: 399 }).ok);
  ok('404 算坏', !verdict({}, { status: 404 }).ok);
  ok('500 算坏', !verdict({}, { status: 500 }).ok);
  ok('199 算坏', !verdict({}, { status: 199 }).ok);
  ok('坏的带原因', verdict({}, { status: 503 }).err === 'HTTP 503', verdict({}, { status: 503 }).err);

  ok('指定状态码：匹配', verdict({ expect_status: 404 }, { status: 404 }).ok);
  ok('指定状态码：不匹配', !verdict({ expect_status: 404 }, { status: 200 }).ok);
  ok('指定状态码时 200 也可能算坏',
     !verdict({ expect_status: 503 }, { status: 200 }).ok);

  ok('关键字命中', verdict({ expect_keyword: '沐枫' }, { status: 200, bodyHead: '<h1>沐枫</h1>' }).ok);
  ok('关键字缺失算坏',
     !verdict({ expect_keyword: '沐枫' }, { status: 200, bodyHead: '<h1>空白页</h1>' }).ok);
  ok('正文为空且要求关键字算坏',
     !verdict({ expect_keyword: '沐枫' }, { status: 200, bodyHead: '' }).ok);
  // 200 但内容坏掉 —— 这正是加关键字校验的理由
  ok('状态码好但内容坏仍判坏',
     !verdict({ expect_keyword: '沐枫' }, { status: 200, bodyHead: 'nginx default page' }).ok);

  // ── 4. 可用率 ──────────────────────────────────────────
  ok('可用率 3/4', uptime([{ ok: 1 }, { ok: 1 }, { ok: 0 }, { ok: 1 }]) === 0.75);
  ok('全好是 1', uptime([{ ok: 1 }]) === 1);
  ok('全坏是 0', uptime([{ ok: 0 }, { ok: 0 }]) === 0);
  // 「没数据」不能显示成 100%
  ok('无心跳返回 null 而不是 1', uptime([]) === null);
  ok('undefined 返回 null', uptime(undefined) === null);

  // ── 5. 探测（用桩 fetch，不出网） ───────────────────────
  const mon = { id: 1, url: 'https://example.test/', timeout_ms: 3000 };
  const resp = (body, status = 200) =>
    async () => new Response(body, { status });

  {
    const r = await probe(mon, now, resp('hello'));
    ok('探测成功', r.ok === true && r.code === 200 && r.id === 1, JSON.stringify(r));
    ok('带上耗时', typeof r.ms === 'number' && r.ms >= 0, JSON.stringify(r));
    ok('带上时间戳', r.ts === now, JSON.stringify(r));
  }
  {
    const r = await probe(mon, now, resp('gone', 503));
    ok('探测到 503', r.ok === false && r.code === 503, JSON.stringify(r));
  }
  {
    // 网络层直接抛 —— probe 绝不能把异常漏出去
    const r = await probe(mon, now, async () => { throw new Error('getaddrinfo ENOTFOUND'); });
    ok('网络异常被吞掉并转成结果', r.ok === false && r.code === null, JSON.stringify(r));
    ok('异常带原因', /ENOTFOUND/.test(r.err), r.err);
  }
  {
    const r = await probe(mon, now, async () => {
      const e = new Error('timed out'); e.name = 'TimeoutError'; throw e;
    });
    ok('超时被识别', r.ok === false && /超时/.test(r.err), JSON.stringify(r));
  }
  {
    const km = { ...mon, expect_keyword: '沐枫' };
    ok('关键字命中', (await probe(km, now, resp('<title>沐枫</title>'))).ok === true);
    ok('关键字缺失', (await probe(km, now, resp('<title>x</title>'))).ok === false);
  }
  {
    // 超过 64KB 的正文只读前段：关键字埋在 100KB 处应当读不到
    const km = { ...mon, expect_keyword: 'NEEDLE' };
    const big = 'x'.repeat(100_000) + 'NEEDLE';
    const r = await probe(km, now, resp(big));
    ok('超长正文只读前 64KB（埋在后面的关键字读不到）', r.ok === false, JSON.stringify(r));
    // 而放在前面就读得到
    const r2 = await probe(km, now, resp('NEEDLE' + 'x'.repeat(100_000)));
    ok('关键字在前段能读到', r2.ok === true, JSON.stringify(r2));
  }
  {
    // 一个监控抛异常不能影响同一批里的其他监控
    const results = await Promise.all([
      probe(mon, now, resp('ok')),
      probe({ ...mon, id: 2 }, now, async () => { throw new Error('boom'); }),
      probe({ ...mon, id: 3 }, now, resp('ok')),
    ]);
    ok('一个失败不拖垮整批', results.length === 3 && results[0].ok && !results[1].ok && results[2].ok,
       JSON.stringify(results.map(r => r.ok)));
  }

  // ── 6. 写入校验 ────────────────────────────────────────
  const { validateMonitor } = M;
  const base = { name: '主页', url: 'https://a.test/' };

  ok('最小合法载荷', validateMonitor(base).ok);
  ok('缺 name 被拒', !validateMonitor({ url: 'https://a.test/' }).ok);
  ok('缺 url 被拒', !validateMonitor({ name: 'x' }).ok);
  ok('非对象被拒', !validateMonitor('nope').ok && !validateMonitor(null).ok && !validateMonitor([]).ok);

  // 未知字段必须报错，不能静默忽略 —— 拼错字段名却「保存成功」是最坑的
  const unk = validateMonitor({ ...base, intervals: 60 });
  ok('未知字段被拒', !unk.ok && /未知字段/.test(unk.errors.join()), JSON.stringify(unk));
  ok('原型污染字段被拒', !validateMonitor({ ...base, constructor: 1 }).ok);
  ok('prototype 字段被拒', !validateMonitor({ ...base, prototype: 1 }).ok);

  // URL 协议白名单
  for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x/y', 'not a url', '']) {
    ok('拒绝 URL ' + JSON.stringify(u), !validateMonitor({ name: 'x', url: u }).ok);
  }
  ok('接受 http', validateMonitor({ name: 'x', url: 'http://a.test/' }).ok);
  ok('接受带路径与查询', validateMonitor({ name: 'x', url: 'https://a.test/p?q=1' }).ok);

  // 数值边界 —— interval_s 填太小会几小时烧光 D1 写入配额
  ok('interval_s 下界 60 可以', validateMonitor({ ...base, interval_s: 60 }).ok);
  ok('interval_s = 59 被拒', !validateMonitor({ ...base, interval_s: 59 }).ok);
  ok('interval_s = 1 被拒', !validateMonitor({ ...base, interval_s: 1 }).ok);
  ok('interval_s 超上界被拒', !validateMonitor({ ...base, interval_s: 86401 }).ok);
  ok('interval_s 小数被拒', !validateMonitor({ ...base, interval_s: 60.5 }).ok);
  ok('interval_s 字符串被拒', !validateMonitor({ ...base, interval_s: '300' }).ok);
  ok('timeout_ms 越界被拒', !validateMonitor({ ...base, timeout_ms: 999 }).ok
     && !validateMonitor({ ...base, timeout_ms: 30001 }).ok);
  ok('retries 越界被拒', !validateMonitor({ ...base, retries: -1 }).ok
     && !validateMonitor({ ...base, retries: 11 }).ok);
  ok('retries = 0 可以', validateMonitor({ ...base, retries: 0 }).ok);

  ok('expect_status 可以是 null', validateMonitor({ ...base, expect_status: null }).ok);
  ok('expect_status 越界被拒', !validateMonitor({ ...base, expect_status: 99 }).ok);
  ok('expect_keyword 可以是 null', validateMonitor({ ...base, expect_keyword: null }).ok);
  ok('expect_keyword 过长被拒', !validateMonitor({ ...base, expect_keyword: 'x'.repeat(201) }).ok);
  ok('name 过长被拒', !validateMonitor({ ...base, name: 'x'.repeat(81) }).ok);
  ok('name 全空白被拒', !validateMonitor({ ...base, name: '   ' }).ok);

  ok('enabled 布尔归一成 1/0',
     validateMonitor({ ...base, enabled: true }).value.enabled === 1
     && validateMonitor({ ...base, enabled: false }).value.enabled === 0);

  // 局部更新
  ok('局部更新不要求 name/url', validateMonitor({ interval_s: 600 }, { partial: true }).ok);
  ok('局部更新空对象被拒', !validateMonitor({}, { partial: true }).ok);
  ok('局部更新仍拒未知字段', !validateMonitor({ nope: 1 }, { partial: true }).ok);
  ok('局部更新只带回给定字段',
     Object.keys(validateMonitor({ interval_s: 600 }, { partial: true }).value).join() === 'interval_s');

  console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                               : '✅ 监控状态机全部通过，共 ' + passed + ' 条断言');
})().catch(e => { console.error('测试自身崩了：', e); process.exit(1); });
