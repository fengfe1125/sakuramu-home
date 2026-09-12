// tests/test_notify.js —— 告警格式与发送的回归（Node 22，零依赖，不出网）。
//
// 重点有两条：
//   1. 告警链路失败绝不能抛异常 —— 它跑在 cron 里，抛出去会把监控本身搞挂，
//      等于「因为报警器坏了所以把消防栓也拆了」。
//   2. probe 里几乎每个字段都可能是 null，而告警恰恰是在出故障时才发的，
//      也就是字段最可能缺失的时候。格式化不能因为少个字段就崩。

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
  const N = await import(pathToFileURL(path.join(__dirname, '../admin/src/notify.mjs')).href);
  const { formatDown, formatUp, formatEvent, humanDuration, localTime, sendTelegram, notifyAll } = N;

  const mon = { name: '主页', url: 'https://sakuramu.edu.kg/' };
  const T = Date.UTC(2026, 8, 12, 6, 32);   // 2026-09-12 06:32 UTC = 14:32 北京

  // ── 1. 故障通知 ────────────────────────────────────────
  {
    const s = formatDown(mon, { ts: T, code: 522, ms: 8012, err: 'HTTP 522' });
    ok('含红灯', s.indexOf('🔴') === 0, s);
    ok('含名称', s.includes('主页'), s);
    ok('含地址', s.includes('https://sakuramu.edu.kg/'), s);
    ok('含状态码', s.includes('HTTP 522'), s);
    ok('含耗时', s.includes('8012ms'), s);
    ok('用本地时间而非 UTC', s.includes('14:32'), s);
  }
  // 故障时字段最可能缺失 —— 少什么都不能崩
  {
    const s = formatDown(mon, { ts: T, code: null, ms: null, err: null });
    ok('全缺字段也能生成', typeof s === 'string' && s.includes('主页'), s);
    ok('无原因时写「未知原因」', s.includes('未知原因'), s);
    ok('不输出 null 字面量', !/null|undefined|NaN/.test(s), s);
  }
  {
    const s = formatDown(mon, { ts: T, code: null, ms: 8012, err: '超时（>8000ms）' });
    ok('只有耗时没有状态码', s.includes('8012ms') && !s.includes('HTTP'), s);
  }

  // ── 2. 恢复通知 ────────────────────────────────────────
  {
    const s = formatUp(mon, { ts: T, ms: 340 }, T - 12 * 60000);
    ok('含绿灯', s.indexOf('🟢') === 0, s);
    ok('含中断时长', s.includes('中断 12 分钟'), s);
    ok('含响应时间', s.includes('340ms'), s);
  }
  // 拿不到故障起点时，宁可不写时长，也不能写个错的
  {
    const s = formatUp(mon, { ts: T, ms: 340 }, null);
    ok('无故障起点时不写时长', !s.includes('中断'), s);
    ok('仍然含响应时间', s.includes('340ms'), s);
    ok('不输出 NaN', !/NaN|null|undefined/.test(s), s);
  }

  // ── 3. 时长措辞 ────────────────────────────────────────
  ok('不足一分钟算 1 分钟', humanDuration(1000) === '1 分钟', humanDuration(1000));
  ok('12 分钟', humanDuration(12 * 60000) === '12 分钟');
  ok('59 分钟', humanDuration(59 * 60000) === '59 分钟');
  ok('整小时不带零分', humanDuration(120 * 60000) === '2 小时', humanDuration(120 * 60000));
  ok('小时加分钟', humanDuration(125 * 60000) === '2 小时 5 分钟', humanDuration(125 * 60000));
  ok('0 也算 1 分钟而不是 0', humanDuration(0) === '1 分钟');

  // ── 4. 时间本地化 ──────────────────────────────────────
  ok('北京时间', localTime(T).includes('14:32'), localTime(T));
  ok('含年月日', /2026-09-12/.test(localTime(T)), localTime(T));
  // 时区数据不可用时要退回 UTC 而不是抛
  ok('非法时区不抛异常', typeof localTime(T, 'Not/AZone') === 'string', String(localTime(T, 'Not/AZone')));

  // ── 5. formatEvent 分发 ────────────────────────────────
  ok('down 事件走故障格式',
     formatEvent({ kind: 'down', monitor: mon, probe: { ts: T, code: 500, ms: 1, err: 'x' } }).indexOf('🔴') === 0);
  ok('recovered 事件走恢复格式',
     formatEvent({ kind: 'recovered', monitor: mon, probe: { ts: T, ms: 1 }, downSince: T - 60000 }).indexOf('🟢') === 0);

  // ── 6. 发送：任何情况都不许抛 ──────────────────────────
  const realFetch = globalThis.fetch;
  const env = { TG_BOT_TOKEN: 't', TG_CHAT_ID: 'c' };

  ok('未配置时安静失败', (await sendTelegram({}, 'x')).why === 'not_configured');
  ok('只有 token 也算未配置', (await sendTelegram({ TG_BOT_TOKEN: 't' }, 'x')).why === 'not_configured');
  ok('空白字符串算未配置',
     (await sendTelegram({ TG_BOT_TOKEN: '  ', TG_CHAT_ID: ' ' }, 'x')).why === 'not_configured');

  globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });
  ok('正常发送', (await sendTelegram(env, 'x')).ok === true);

  globalThis.fetch = async () => new Response('{"ok":false}', { status: 429 });
  const r429 = await sendTelegram(env, 'x');
  ok('429 不抛，返回原因', r429.ok === false && r429.why === 'http_429', JSON.stringify(r429));

  globalThis.fetch = async () => { throw new Error('network down'); };
  ok('网络异常不抛', (await sendTelegram(env, 'x')).ok === false);

  globalThis.fetch = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  ok('超时被识别', (await sendTelegram(env, 'x')).why === 'timeout');

  // 一条失败不能拖垮其余
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 2) throw new Error('boom');
    return new Response('{"ok":true}', { status: 200 });
  };
  const evs = [1, 2, 3].map(i => ({
    kind: 'down', monitor: { name: 'm' + i, url: 'https://x' + i }, probe: { ts: T, code: 500, ms: 1, err: 'e' },
  }));
  const res = await notifyAll(env, evs);
  ok('三条里一条失败，其余照发', res.sent === 2 && res.failed === 1, JSON.stringify(res));
  ok('空事件列表直接返回', JSON.stringify(await notifyAll(env, [])) === '{"sent":0,"failed":0}');

  globalThis.fetch = realFetch;

  console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                               : '✅ 告警全部通过，共 ' + passed + ' 条断言');
})().catch(e => { console.error('测试自身崩了：', e); process.exit(1); });
