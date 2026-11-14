(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* -------------------------------------------------------
     見出しを1文字ずつに分割する
     テキストノードだけを対象にするので、<br> は壊れない
     ------------------------------------------------------- */
  function splitChars(el, step) {
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    var index = 0;
    textNodes.forEach(function (node) {
      var frag = document.createDocumentFragment();
      node.nodeValue.split('').forEach(function (ch) {
        if (ch.trim() === '') {
          frag.appendChild(document.createTextNode(ch));
          return;
        }
        var span = document.createElement('span');
        span.className = 'char';
        span.textContent = ch;
        span.style.setProperty('--char-delay', (index * step) + 'ms');
        index += 1;
        frag.appendChild(span);
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

  (function initSplit() {
    if (reduceMotion) return;
    document.querySelectorAll('[data-split]').forEach(function (el) {
      var step = parseInt(el.getAttribute('data-split'), 10) || 40;
      splitChars(el, step);
    });
  })();

  /* -------------------------------------------------------
     スクロール・初回表示で要素を出現させる
     ------------------------------------------------------- */
  (function reveal() {
    var targets = document.querySelectorAll('[data-reveal]');
    if (!targets.length) return;

    document.querySelectorAll('[data-stagger]').forEach(function (group) {
      var step = parseInt(group.getAttribute('data-stagger'), 10) || 90;
      group.querySelectorAll('[data-reveal]').forEach(function (child, i) {
        child.style.setProperty('--reveal-delay', (i * step) + 'ms');
      });
    });

    if (reduceMotion || !('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });

    targets.forEach(function (el) { observer.observe(el); });
  })();

})();
