/* 访客埋点。由 scripts/build-shared.mjs 注入两个页面的 beacon:start / beacon:end 之间。
 *
 * 两个页面共用这一份，不能各写一份 —— 刚为 CSS 去过一次重，同样的理由：
 * 分叉的表现是「一个站的数字对，另一个站悄悄不对」。
 *
 * 隐私：不写 Cookie、不写 localStorage、不发 IP、不发 User-Agent。
 * referrer 只取主机名，查询串根本不出浏览器。
 * 下面那个 id 只为把「离开」事件对上「进入」那一行，
 * 存在内存里、刷新即变、不落盘，不能用来识别人。
 *
 * 上报全程 fire-and-forget：失败静默，不重试，不打扰页面。
 * 统计服务挂了，访客什么都感觉不到。
 */
(function () {
    var EP = 'https://hits.sakuramu.edu.kg/e';
    var MAX_SENDS = 3;

    /* 尊重 Do Not Track 与 Global Privacy Control。
       既然整套设计都是「能不收就不收」，这两个信号没有理由不听。 */
    try {
        if (navigator.doNotTrack === '1' || window.doNotTrack === '1' ||
            navigator.globalPrivacyControl === true) return;
    } catch (e) { /* 读不到就当没设 */ }

    var id = '';
    try {
        var a = new Uint8Array(12);
        crypto.getRandomValues(a);
        for (var i = 0; i < a.length; i++) id += (a[i] % 36).toString(36);
    } catch (e) {
        id = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    id = id.replace(/[^a-z0-9]/g, '').slice(0, 24);
    if (id.length < 8) return;

    function post(payload) {
        var body = JSON.stringify(payload);
        try {
            /* sendBeacon 在页面被销毁时仍能发出去，这是它存在的全部理由。
               注意它同样受 CSP 的 connect-src 管 —— 漏配就静默失败。 */
            /* 必须用 text/plain。用 application/json 会把这次上报变成「非简单请求」，
               于是浏览器先发一个 OPTIONS 预检 —— 而 pagehide 期间预检往往跑不完，
               结果是离开信标整个丢掉，而且只在移动端丢，桌面上测不出来。
               服务端按 JSON 解析正文，不看 content-type，所以这样发没有损失。 */
            if (navigator.sendBeacon &&
                navigator.sendBeacon(EP, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return;
        } catch (e) { /* 落到下面的 fetch */ }
        try {
            /* 同理：content-type 用 text/plain，且 credentials:'omit' ——
               这个端点不认 Cookie，没有理由让它带上任何凭据。 */
            fetch(EP, { method: 'POST', body: body, keepalive: true, credentials: 'omit',
                        headers: { 'content-type': 'text/plain;charset=UTF-8' } })['catch'](function () {});
        } catch (e) { /* 静默 */ }
    }

    /* referrer 只取主机名。完整 URL 的查询串常常带着隐私，不该离开浏览器。 */
    var ref = '';
    try {
        if (document.referrer) {
            var h = new URL(document.referrer).hostname;
            if (h && h !== location.hostname) ref = h;
        }
    } catch (e) { /* 解析不了就不发 */ }

    post({ t: 'view', id: id, p: location.pathname.slice(0, 200), r: ref });

    /* ── 停留时长：累计「可见时长」，不是墙上时间 ──
       用户切走再切回来，中间那段不算 —— 那才是「看了多久」。 */
    var acc = 0, mark = 0, sends = 0;
    function visible() { return document.visibilityState !== 'hidden'; }
    if (visible()) mark = Date.now();

    var lastSent = -1;
    function flush() {
        if (sends >= MAX_SENDS) return;
        if (mark) { acc += Date.now() - mark; mark = 0; }
        /* visibilitychange 和 pagehide 常常同时触发。第二发在服务端会因为
           「时长没变大」而写 0 行，但没必要白跑一趟网络。 */
        if (acc - lastSent < 1000) return;
        lastSent = acc;
        sends++;
        post({ t: 'end', id: id, d: Math.min(acc, 86400000) });
    }

    /* visibilitychange 是首选：beforeunload / unload 在移动端极不可靠，
       而且带 unload 处理器的页面会被排除在 bfcache 之外。
       pagehide 兜底（它与 bfcache 兼容）。服务端 last-write-wins，重复发不会算重。 */
    document.addEventListener('visibilitychange', function () {
        if (visible()) { if (!mark) mark = Date.now(); }
        else flush();
    });
    window.addEventListener('pagehide', flush);

    /* 从 bfcache 恢复：继续用同一个 id 累计，不算一次新访问。 */
    window.addEventListener('pageshow', function (e) {
        if (e.persisted && visible() && !mark) mark = Date.now();
    });
})();
