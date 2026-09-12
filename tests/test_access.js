// tests/test_access.js —— Access JWT 校验的回归（Node 22，零依赖）。
//
// 这是真签名、真验签的端到端测试：临时生成一对 RSA 密钥，自己签 JWT，
// 把 globalThis.fetch 换成返回对应 JWKS 的桩，然后走完整条 verifyAccess。
// 不是「读一遍代码觉得没问题」。
//
// 每组用例都通过给 import 加查询串拿一个全新的模块实例 ——
// access.js 里有模块级的 JWKS 缓存和回源冷却，共用实例会让用例互相污染。
// 这样做的好处是源码里一行测试专用代码都不用加。

'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const SRC = pathToFileURL(path.join(__dirname, '../admin/src/access.mjs')).href;
const TEAM = 'sakura-test';
const ISS = 'https://' + TEAM + '.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const KID = 'test-kid-1';

let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; return; }
  console.error('❌ ' + name + (detail ? '  → ' + detail : ''));
  process.exitCode = 1;
}

const enc = new TextEncoder();
const b64 = b => Buffer.from(b).toString('base64url');

async function genKeys() {
  const kp = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { priv: kp.privateKey, jwk: { ...jwk, kid: KID, alg: 'RS256' } };
}

async function sign(priv, header, claims) {
  const h = b64(enc.encode(JSON.stringify(header)));
  const p = b64(enc.encode(JSON.stringify(claims)));
  const s = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, enc.encode(h + '.' + p));
  return h + '.' + p + '.' + b64(new Uint8Array(s));
}

const now = () => Math.floor(Date.now() / 1000);
const baseClaims = (o = {}) => ({
  aud: [AUD], iss: ISS, exp: now() + 600, iat: now() - 10, nbf: now() - 10,
  email: 'me@example.com', sub: 'user-123', ...o,
});

const req = token => new Request('https://admin.example/v1/whoami', {
  headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {},
});
const ENV = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

// 每次拿一个干净的模块实例，并装上返回给定 JWKS 的 fetch 桩。
let fetchCount = 0;
async function freshModule(jwks) {
  fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount++;
    if (!String(url).startsWith(ISS)) throw new Error('意外的外部请求: ' + url);
    return new Response(JSON.stringify({ keys: jwks }),
      { headers: { 'content-type': 'application/json' } });
  };
  return import(SRC + '?t=' + Math.random());
}

(async function main() {
  const A = await genKeys();
  const B = await genKeys();   // 另一对密钥，用来伪造签名

  // ── 1. 正常路径 ────────────────────────────────────────────
  {
    const { verifyAccess } = await freshModule([A.jwk]);
    const r = await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims())), ENV);
    ok('有效令牌通过', r.ok === true, JSON.stringify(r));
    ok('返回邮箱', r.email === 'me@example.com', JSON.stringify(r));
    ok('返回 sub', r.sub === 'user-123', JSON.stringify(r));

    // aud 允许是字符串
    const r2 = await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID },
      baseClaims({ aud: AUD }))), ENV);
    ok('aud 为字符串也接受', r2.ok === true, JSON.stringify(r2));

    // JWKS 应该只取一次，后续请求走缓存
    const before = fetchCount;
    await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims())), ENV);
    ok('JWKS 命中缓存不重复回源', fetchCount === before, 'fetch 了 ' + fetchCount + ' 次');
  }

  // ── 2. 算法混淆：这一组最要命 ──────────────────────────────
  {
    const { verifyAccess } = await freshModule([A.jwk]);

    // alg:none —— 完全免签
    const h = b64(enc.encode(JSON.stringify({ alg: 'none', kid: KID })));
    const p = b64(enc.encode(JSON.stringify(baseClaims())));
    const r1 = await verifyAccess(req(h + '.' + p + '.'), ENV);
    ok('拒绝 alg:none', r1.ok === false && r1.why === 'alg', JSON.stringify(r1));

    // alg:HS256 —— 诱使把人人可取的 RSA 公钥当成 HMAC 密钥
    const h2 = b64(enc.encode(JSON.stringify({ alg: 'HS256', kid: KID })));
    const hk = await crypto.subtle.importKey('raw', enc.encode(A.jwk.n),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const s2 = await crypto.subtle.sign('HMAC', hk, enc.encode(h2 + '.' + p));
    const r2 = await verifyAccess(req(h2 + '.' + p + '.' + b64(new Uint8Array(s2))), ENV);
    ok('拒绝 alg:HS256（算法混淆）', r2.ok === false && r2.why === 'alg', JSON.stringify(r2));

    // RS512 也不行 —— 白名单只有 RS256
    const r3 = await verifyAccess(req(await sign(A.priv, { alg: 'RS512', kid: KID }, baseClaims())), ENV);
    ok('拒绝白名单外的 RS512', r3.ok === false && r3.why === 'alg', JSON.stringify(r3));
  }

  // ── 3. 签名本身 ────────────────────────────────────────────
  {
    const { verifyAccess } = await freshModule([A.jwk]);
    // 用另一对密钥签，但声明成 A 的 kid
    const r = await verifyAccess(req(await sign(B.priv, { alg: 'RS256', kid: KID }, baseClaims())), ENV);
    ok('拒绝签名不匹配', r.ok === false && r.why === 'signature', JSON.stringify(r));

    // 篡改 payload（签名还是原来那个）
    const good = await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims());
    const parts = good.split('.');
    const tampered = parts[0] + '.' + b64(enc.encode(JSON.stringify(
      baseClaims({ email: 'attacker@evil.com' })))) + '.' + parts[2];
    const r2 = await verifyAccess(req(tampered), ENV);
    ok('拒绝被篡改的 payload', r2.ok === false && r2.why === 'signature', JSON.stringify(r2));
  }

  // ── 4. 声明校验 ────────────────────────────────────────────
  {
    const { verifyAccess } = await freshModule([A.jwk]);
    const cases = [
      ['aud 不匹配', baseClaims({ aud: ['b'.repeat(64)] }), 'aud'],
      ['aud 为空数组', baseClaims({ aud: [] }), 'aud'],
      ['aud 缺失', baseClaims({ aud: undefined }), 'aud'],
      ['iss 不匹配', baseClaims({ iss: 'https://evil.cloudflareaccess.com' }), 'iss'],
      ['已过期', baseClaims({ exp: now() - 600 }), 'exp'],
      ['exp 缺失', baseClaims({ exp: undefined }), 'exp'],
      ['nbf 在未来', baseClaims({ nbf: now() + 600 }), 'nbf'],
      ['iat 在未来', baseClaims({ iat: now() + 600 }), 'iat'],
    ];
    for (const [name, claims, why] of cases) {
      const r = await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID }, claims)), ENV);
      ok('拒绝 ' + name, r.ok === false && r.why === why, JSON.stringify(r));
    }
    // 刚过期一点点要被时钟偏差宽容掉
    const r = await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID },
      baseClaims({ exp: now() - 30 }))), ENV);
    ok('30 秒内的过期按时钟偏差放行', r.ok === true, JSON.stringify(r));
  }

  // ── 5. 配置缺失必须失败关闭 ────────────────────────────────
  {
    const { verifyAccess, accessConfig } = await freshModule([A.jwk]);
    const token = await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims());
    for (const [name, env] of [
      ['两个都空', {}],
      ['只有 team', { ACCESS_TEAM_DOMAIN: TEAM }],
      ['只有 aud', { ACCESS_AUD: AUD }],
      ['空白字符串', { ACCESS_TEAM_DOMAIN: '  ', ACCESS_AUD: '  ' }],
    ]) {
      const r = await verifyAccess(req(token), env);
      ok('未配置就拒绝：' + name, r.ok === false && r.why === 'not_configured', JSON.stringify(r));
    }
    // team 写全名或写短名都认
    ok('team 短名', accessConfig({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }).iss === ISS);
    ok('team 全名', accessConfig({ ACCESS_TEAM_DOMAIN: TEAM + '.cloudflareaccess.com',
      ACCESS_AUD: AUD }).iss === ISS);
  }

  // ── 6. 令牌形态 ────────────────────────────────────────────
  {
    const { verifyAccess } = await freshModule([A.jwk]);
    ok('没有断言头就拒绝',
      (await verifyAccess(req(null), ENV)).why === 'no_assertion');
    ok('只有两段就拒绝',
      (await verifyAccess(req('a.b'), ENV)).why === 'shape');
    ok('乱码拒绝',
      ['decode', 'alg', 'shape'].includes((await verifyAccess(req('@@.@@.@@'), ENV)).why));
    ok('超长令牌直接拒绝',
      (await verifyAccess(req('x'.repeat(9000)), ENV)).why === 'too_long');

    // Cookie 不算数 —— 只收请求头是这个接口免疫 CSRF 的原因
    const token = await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims());
    const r = await verifyAccess(new Request('https://admin.example/v1/whoami',
      { headers: { cookie: 'CF_Authorization=' + token } }), ENV);
    ok('不接受 CF_Authorization Cookie', r.ok === false && r.why === 'no_assertion', JSON.stringify(r));
  }

  // ── 7. 未知 kid 不能变成 fetch 风暴 ────────────────────────
  {
    const { verifyAccess } = await freshModule([A.jwk]);
    await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims())), ENV);
    const after = fetchCount;
    for (let i = 0; i < 20; i++) {
      const r = await verifyAccess(req(await sign(A.priv,
        { alg: 'RS256', kid: 'unknown-' + i }, baseClaims())), ENV);
      ok('未知 kid 被拒（第 ' + i + ' 次）', r.ok === false && r.why === 'unknown_kid', JSON.stringify(r));
    }
    ok('20 次未知 kid 不会各打一次回源', fetchCount === after,
      '回源了 ' + (fetchCount - after) + ' 次');
  }

  // ── 8. 邮箱白名单（第二道闸） ──────────────────────────────
  {
    const { verifyAccess } = await freshModule([A.jwk]);
    const token = await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims());
    const withList = l => ({ ...ENV, ACCESS_ALLOWED_EMAILS: l });
    ok('白名单内放行', (await verifyAccess(req(token), withList('me@example.com'))).ok === true);
    ok('大小写与空格不敏感',
      (await verifyAccess(req(token), withList(' ME@Example.COM , x@y.z '))).ok === true);
    ok('白名单外拒绝',
      (await verifyAccess(req(token), withList('other@example.com'))).why === 'email');
    ok('白名单留空则不校验', (await verifyAccess(req(token), withList(''))).ok === true);
    // 策略被改宽时，这一道仍然拦得住
    const anon = await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims({ email: undefined }));
    ok('无邮箱的令牌被白名单拦下',
      (await verifyAccess(req(anon), withList('me@example.com'))).why === 'email');
  }

  // ── 9. JWKS 本身畸形 ───────────────────────────────────────
  {
    // 一把坏钥匙不能毁掉整份密钥集
    const { verifyAccess } = await freshModule([{ kty: 'RSA', kid: 'broken', n: '!!', e: 'AQAB' }, A.jwk]);
    const r = await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims())), ENV);
    ok('坏钥匙被跳过，好钥匙仍可用', r.ok === true, JSON.stringify(r));
  }
  {
    const { verifyAccess } = await freshModule([]);   // 空密钥集
    const r = await verifyAccess(req(await sign(A.priv, { alg: 'RS256', kid: KID }, baseClaims())), ENV);
    ok('空密钥集报 certs 失败', r.ok === false && r.why === 'certs', JSON.stringify(r));
  }

  console.log(process.exitCode ? '\n有断言失败（通过 ' + passed + ' 条）'
                               : '✅ Access 校验全部通过，共 ' + passed + ' 条断言');
})().catch(e => { console.error('测试自身崩了：', e); process.exit(1); });
