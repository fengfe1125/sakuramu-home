/* 两个页面共用的动效。由 scripts/build-shared.mjs 注入两个页面的 motion:start / motion:end 之间。
 *
 * 管三件事：
 *   · 顶栏：离开页首后出现底线；底边一条陶土色细线跟着阅读进度走
 *   · 首屏入场：<head> 里已经按需加上了 .motion（先把首屏藏好），
 *     这里等字体到了、首帧画完再加 .play 开播
 *   · 区块分隔线：滚到时从左往右画出来；区块和页脚里的手写字跟着一起「写」出来
 *
 * 规矩与页面里的揭示动画一致：动画绝不能是内容可见的前提。
 * 减少动态效果、页面在后台标签页里打开时，<head> 根本不会加 .motion，
 * 一切直接是终态；<head> 里还有一个 1.5 秒的兜底，这段脚本出了错，首屏也不会一直藏着。
 */
(function () {
    'use strict';
    var root = document.documentElement;

    var top = document.getElementById('top');
    function onScroll() {
        var y = window.scrollY, max = root.scrollHeight - window.innerHeight;
        top.classList.toggle('stuck', y > 8);
        top.style.setProperty('--progress', max > 0 ? Math.min(1, y / max).toFixed(4) : '0');
    }
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    onScroll();

    if (!root.classList.contains('motion')) return;

    // 两帧：第一帧把「藏好」的起始状态画出来，第二帧再开播，过渡才有起点
    function play() {
        requestAnimationFrame(function () {
            requestAnimationFrame(function () { root.classList.add('play'); });
        });
    }
    // 首页首屏是手写字，边写边出来。字体没到就开写，会先用系统自带的草书写一半、
    // 再突然换成手写体，所以等字体到了再开播；最多等 1 秒，<head> 里还有 1.5 秒的兜底。
    var fonts = document.fonts;
    if (fonts && fonts.ready) {
        Promise.race([fonts.ready, new Promise(function (r) { setTimeout(r, 1000); })]).then(play, play);
    } else {
        play();
    }

    var secs = document.querySelectorAll('.sec, .foot');
    function draw(el) { el.classList.add('drawn'); }
    if (!('IntersectionObserver' in window)) { secs.forEach(draw); return; }
    var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
            if (!e.isIntersecting) return;
            draw(e.target); io.unobserve(e.target);
        });
    }, { rootMargin: '0px 0px -12% 0px' });
    secs.forEach(function (s) { io.observe(s); });
})();
