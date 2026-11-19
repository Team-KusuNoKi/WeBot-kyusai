export function mountLuminol(host, { onDone, canInteract } = {}) {
  host.innerHTML = `<section class="hex-game luminol-game" aria-label="ルミノール検査"><div class="hex-layout"><section class="hex-rules"><div class="luminol-rules-bar"><h2>手順</h2><button type="button" class="hex-reset primary-button">やり直す</button></div><p><span data-rule="mix">①二つの小瓶を一つに混ぜる。</span><br><span data-rule="spray">②トンカチの赤い部分へ吹きかける。</span><br><span data-rule="lights">③電気を消す。</span></p></section><section class="hex-board" aria-label="検査"><div class="luminol-stage" data-phase="mix"><div class="luminol-scene"><div class="luminol-hammer-wrap" data-zoom><div class="luminol-zoom"><div class="luminol-hammer-3d"><img class="luminol-hammer-art" src="../assets/luminol-hammer-solid.png" alt="" aria-hidden="true" draggable="false"></div><div class="luminol-hit luminol-stain" data-drop="stain"></div><span class="luminol-mist" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span></div><button type="button" class="luminol-switch" aria-pressed="false" aria-label="電気を消す"><span class="luminol-switch-plate" aria-hidden="true"><span class="luminol-switch-lever"></span></span><span class="luminol-vial-name">電気</span></button><div class="luminol-zoom-controls"><button type="button" data-zoom-in aria-label="拡大">+</button><button type="button" data-zoom-out aria-label="縮小">−</button></div></div><div class="luminol-foreground"><button type="button" class="luminol-vial" data-vial="base" aria-label="ルミノール。酸化剤の小瓶へドラッグするか、決定で混ぜる"><span class="luminol-vial-neck" aria-hidden="true"></span><span class="luminol-vial-body"><span class="luminol-vial-liquid"></span></span><span class="luminol-vial-name">ルミノール</span></button><button type="button" class="luminol-vial is-reagent" data-vial="reagent" aria-label="酸化剤。ルミノールの小瓶へドラッグするか、決定で混ぜる"><span class="luminol-vial-neck" aria-hidden="true"></span><span class="luminol-vial-body"><span class="luminol-vial-liquid"></span></span><span class="luminol-vial-name">酸化剤</span></button><button type="button" class="luminol-spray" data-drag="spray" aria-label="噴霧器。トンカチの赤い部分へドラッグするか、決定で吹きかける"><span class="luminol-spray-body" aria-hidden="true"><span class="luminol-spray-nozzle"></span><span class="luminol-spray-trigger"></span><span class="luminol-spray-liquid"></span></span><span class="luminol-vial-name">噴霧器</span></button></div><div class="luminol-result" hidden><p>何も光らない。</p><p>この赤い液体は、血ではない。</p><button type="button" class="primary-button" data-done>確認した</button></div></div></div></section></div><p class="hex-status" role="status" aria-live="polite"></p></section>`;

  const root = host.querySelector('.luminol-game');
  const stage = root.querySelector('.luminol-stage');
  const status = root.querySelector('.hex-status');
  const result = root.querySelector('.luminol-result');
  const reagent = root.querySelector('[data-vial="reagent"]');
  const spray = root.querySelector('[data-drag="spray"]');
  const base = root.querySelector('[data-vial="base"]');
  const stainTarget = root.querySelector('[data-drop="stain"]');
  const stain = root.querySelector('.luminol-stain');
  const lightSwitch = root.querySelector('.luminol-switch');
  const resetButton = root.querySelector('.hex-reset');
  const messages = {
    mix: '一方の小瓶をもう一方へドラッグしてください。',
    spray: '噴霧器になりました。画面をタップして煙を吹きかけてください。',
    lights: '吹きかけました。電気を消してください。',
    result: '何も光りません。この赤い液体は血ではありません。',
  };
  let phase = 'mix';
  let busy = false;
  let disposed = false;
  let timer = null;
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const vials = [base, reagent];

  function allowed() { return !disposed && (canInteract?.() ?? true); }
  function enabled() { return allowed() && !busy; }
  function clearTimer() { if (timer !== null) clearTimeout(timer); timer = null; }
  function later(ms, fn) {
    clearTimer();
    if (reduced() || ms <= 0) { if (!disposed) fn(); return; }
    timer = setTimeout(() => { timer = null; if (!disposed) fn(); }, ms);
  }
  function render() {
    stage.dataset.phase = phase;
    const step = phase === 'result' ? 'lights' : phase;
    root.querySelectorAll('[data-rule]').forEach(el => {
      el.setAttribute('aria-current', el.dataset.rule === step ? 'step' : 'false');
    });
    result.hidden = phase !== 'result';
    base.disabled = !enabled();
    reagent.disabled = !enabled();
    spray.disabled = !enabled();
    lightSwitch.disabled = !allowed() || stage.classList.contains('is-dark');
    resetButton.disabled = !allowed() || busy;
    result.querySelector('[data-done]').disabled = !allowed();
  }
  function finishMixFrom(source) {
    return () => {
      if (phase !== 'mix' || busy || !allowed()) return;
      const other = source === reagent ? base : reagent;
      busy = true;
      render();
      source.style.transform = '';
      other.style.transform = '';
      source.classList.add('is-becoming-spray');
      other.classList.add('is-absorbed');
      later(480, () => {
        busy = false;
        source.classList.remove('is-becoming-spray');
        other.classList.remove('is-absorbed');
        phase = 'spray';
        status.textContent = messages.spray;
        render();
      });
    };
  }
  let sprayedRed = false;
  function sprayAt(clientX, clientY) {
    if (phase === 'mix' || !allowed() || talkMode) return;
    const stainRect = stainTarget.getBoundingClientRect();
    const pad = 4;
    if (clientX >= stainRect.left - pad && clientX <= stainRect.right + pad && clientY >= stainRect.top - pad && clientY <= stainRect.bottom + pad) {
      sprayedRed = true;
    }
    const rect = viewport.getBoundingClientRect();
    const burst = document.createElement('span');
    burst.className = 'luminol-burst';
    burst.style.left = `${clientX - rect.left}px`;
    burst.style.top = `${clientY - rect.top}px`;
    for (let i = 0; i < 9; i += 1) burst.append(document.createElement('i'));
    viewport.append(burst);
    stain.classList.add('is-wet');
    setTimeout(() => burst.remove(), 700);
  }
  function finishSpray(clientX, clientY) {
    if (phase === 'mix' || !allowed()) return;
    const rect = stainTarget.getBoundingClientRect();
    sprayAt(clientX ?? rect.left + rect.width / 2, clientY ?? rect.top + rect.height / 2);
  }
  function finishDark() {
    if (!allowed() || talkMode || stage.classList.contains('is-dark')) return;
    stage.classList.add('is-dark');
    lightSwitch.classList.add('is-off');
    lightSwitch.setAttribute('aria-pressed', 'true');
    render();
    showTalk(sprayedRed ? lines.hit : lines.miss, sprayedRed ? 'hit' : 'miss');
  }
  function reset() {
    if (!allowed()) return;
    clearTimer();
    busy = false;
    phase = 'mix';
    stage.classList.remove('is-dark', 'is-spraying');
    viewport?.querySelectorAll('.luminol-burst').forEach(node => node.remove());
    sprayedRed = false;
    closeTalk();
    resetZoom();
    vials.forEach(vial => {
      vial.classList.remove('is-becoming-spray', 'is-absorbed');
      vial.style.transform = '';
    });
    spray.style.transform = '';
    stain.classList.remove('is-wet');
    base.classList.remove('is-armed');
    reagent.classList.remove('is-armed');
    stainTarget.classList.remove('is-armed');
    lightSwitch.classList.remove('is-off');
    lightSwitch.setAttribute('aria-pressed', 'false');
    status.textContent = messages.mix;
    render();
  }
  function overlaps(a, b) {
    const left = a.getBoundingClientRect();
    const right = b.getBoundingClientRect();
    return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
  }
  function bindDrag(handle, target, commit, options = {}) {
    let drag = null;
    const end = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const moved = drag.moved;
      const hit = moved && overlaps(handle, target);
      drag = null;
      handle.classList.remove('is-dragging');
      target.classList.remove('is-armed');
      if (hit || (!moved && !options.requireHit)) commit();
      else handle.style.transform = '';
    };
    handle.addEventListener('pointerdown', event => {
      if (!enabled() || (event.button != null && event.button !== 0)) return;
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      handle.setPointerCapture?.(event.pointerId);
      handle.classList.add('is-dragging');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 8) return;
      drag.moved = true;
      handle.style.transform = `translate(${dx}px, ${dy}px)`;
      target.classList.toggle('is-armed', overlaps(handle, target));
    });
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      commit();
    });
  }

  const zoomMin = 0.45;
  const zoomMax = 2.8;
  const viewport = root.querySelector('[data-zoom]');
  const zoomLayer = root.querySelector('.luminol-zoom');
  const zoom = { scale: 1, x: 0, y: 0, pointers: new Map(), moved: false, pinching: false, pinchDist: 1, pinchScale: 1 };
  function applyZoom() {
    zoomLayer.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
  }
  function clampZoom() {
    const rect = viewport.getBoundingClientRect();
    const limitX = rect.width * Math.abs(zoom.scale - 1) / 2 + rect.width * 0.62;
    const limitY = rect.height * Math.abs(zoom.scale - 1) / 2 + rect.height * 0.48;
    zoom.x = Math.max(-limitX, Math.min(limitX, zoom.x));
    zoom.y = Math.max(-limitY, Math.min(limitY, zoom.y));
  }
  function setZoom(next) {
    zoom.scale = Math.min(zoomMax, Math.max(zoomMin, next));
    clampZoom();
    applyZoom();
  }
  function resetZoom() {
    zoom.scale = 1;
    zoom.x = 0;
    zoom.y = 0;
    zoom.pointers.clear();
    zoom.moved = false;
    zoom.pinching = false;
    applyZoom();
  }
  viewport.addEventListener('dragstart', event => event.preventDefault());
  viewport.addEventListener('pointerdown', event => {
    if (talkMode) return;
    if (event.target.closest('.luminol-switch, .luminol-zoom-controls')) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    zoom.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      ox: event.clientX,
      oy: event.clientY,
      onHammer: tappedHammer(event),
    });
    viewport.setPointerCapture?.(event.pointerId);
    if (zoom.pointers.size === 2) {
      const pts = [...zoom.pointers.values()];
      zoom.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      zoom.pinchScale = zoom.scale;
      zoom.pinching = true;
    }
  });
  viewport.addEventListener('pointermove', event => {
    const point = zoom.pointers.get(event.pointerId);
    if (!point) return;
    const prevX = point.x;
    const prevY = point.y;
    point.x = event.clientX;
    point.y = event.clientY;
    if (zoom.pointers.size >= 2) {
      const pts = [...zoom.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      setZoom(zoom.pinchScale * (dist / zoom.pinchDist));
      zoom.moved = true;
      return;
    }
    const travelX = event.clientX - point.ox;
    const travelY = event.clientY - point.oy;
    const travel = Math.hypot(travelX, travelY);
    if (!point.sliding && travel >= (point.onHammer ? 12 : 6)) point.sliding = true;
    if (point.sliding) {
      zoom.moved = true;
      zoom.x += event.clientX - prevX;
      zoom.y += event.clientY - prevY;
      clampZoom();
      applyZoom();
    }
  });
  const endZoomPointer = event => {
    if (!zoom.pointers.has(event.pointerId)) return;
    const point = zoom.pointers.get(event.pointerId);
    zoom.pointers.delete(event.pointerId);
    const travel = point ? Math.hypot(event.clientX - point.ox, event.clientY - point.oy) : 0;
    const tap = point && !point.sliding && !zoom.pinching && travel < 12;
    if (zoom.pointers.size < 2) zoom.pinchDist = 1;
    if (zoom.pointers.size === 0) {
      if (tap && point.onHammer && phase !== 'mix') sprayAt(event.clientX, event.clientY);
      zoom.moved = false;
      zoom.pinching = false;
    }
  };
  viewport.addEventListener('pointerup', endZoomPointer);
  viewport.addEventListener('pointercancel', endZoomPointer);
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    setZoom(zoom.scale * (event.deltaY < 0 ? 1.08 : 0.92));
  }, { passive: false });
  viewport.querySelector('[data-zoom-in]').addEventListener('click', () => setZoom(zoom.scale + 0.22));
  viewport.querySelector('[data-zoom-out]').addEventListener('click', () => setZoom(zoom.scale - 0.22));

  const portraits = {
    アサヒ: new URL('./assets/asahi-cutout.webp', import.meta.url).href,
    タツ: new URL('./assets/tatsu-cutout.webp', import.meta.url).href,
  };
  const lines = {
    intro: [
      { speaker: 'アサヒ', text: '「タツ先輩、ルミノール検査薬を友達から借りてきました。」' },
      { speaker: 'タツ', text: '「よくやった。これ、どうやるんだ?」' },
      { speaker: 'アサヒ', text: '「ここは僕に任せてください。」' },
    ],
    miss: [
      { speaker: 'アサヒ', text: '「うーん。何も反応しないですね。」' },
      { speaker: 'タツ', text: '「うまく吹きかけられていないんじゃないか?」' },
    ],
    hit: [
      { speaker: 'アサヒ', text: '「…何も反応しない。ってことは」' },
      { speaker: 'タツ', text: '「そうだ。これは血じゃない。多分血糊かなにかだろう。」' },
    ],
  };
  const talk = document.createElement('div');
  talk.className = 'luminol-talk';
  talk.hidden = true;
  talk.innerHTML = '<div class="novel-stage"><button type="button" class="novel-bubble" data-talk-next><span class="novel-line"></span><span class="novel-next"><span aria-hidden="true">▷</span><span class="sr-only">読み進める</span></span></button></div>';
  (host.closest('dialog') ?? stage).append(talk);
  let talkMode = null;
  let talkLines = [];
  let talkIndex = 0;
  function renderTalk() {
    const line = talkLines[talkIndex];
    const talkStage = talk.querySelector('.novel-stage');
    const bubble = talkStage.querySelector('.novel-bubble');
    const motion = getComputedStyle(document.documentElement);
    const ease = motion.getPropertyValue('--motion-ease').trim() || 'ease';
    const stateMs = parseFloat(motion.getPropertyValue('--motion-state')) || 180;
    const enterMs = parseFloat(motion.getPropertyValue('--motion-enter')) || 260;
    const outgoings = [...talkStage.querySelectorAll('.novel-portrait:not(.portrait-leaving)')];
    const outgoingSpeaker = outgoings.map(node => node.querySelector('.novel-speaker').textContent).join('');
    if (outgoingSpeaker !== line.speaker) {
      talkStage.querySelectorAll('.portrait-leaving').forEach(node => node.remove());
      let incomingOpacity = .78;
      for (const outgoing of outgoings) {
        if (reduced()) {
          outgoing.remove();
          continue;
        }
        const opacity = Number(getComputedStyle(outgoing).opacity);
        incomingOpacity = 1 - opacity;
        outgoing.getAnimations().forEach(animation => animation.cancel());
        outgoing.classList.toggle('was-right', outgoing.classList.contains('novel-portrait-right') || talkStage.classList.contains('novel-right'));
        outgoing.classList.add('portrait-leaving');
        outgoing.setAttribute('aria-hidden', 'true');
        const exit = outgoing.animate([{ opacity }, { opacity: 0 }], { duration: stateMs, easing: ease, fill: 'forwards' });
        exit.finished.then(() => outgoing.remove(), () => outgoing.remove());
      }
      talkStage.classList.toggle('novel-right', line.speaker === 'タツ');
      const portrait = document.createElement('div');
      portrait.className = 'novel-portrait';
      const img = document.createElement('img');
      img.src = portraits[line.speaker];
      img.alt = '';
      const name = document.createElement('span');
      name.className = 'novel-speaker';
      name.textContent = line.speaker;
      portrait.append(img, name);
      bubble.before(portrait);
      if (!reduced()) portrait.animate([{ opacity: incomingOpacity }, { opacity: 1 }], { duration: stateMs, easing: ease });
    }
    const previousHeight = bubble.getBoundingClientRect().height;
    bubble.querySelector('.novel-line').textContent = line.text;
    if (reduced()) return;
    const height = bubble.getBoundingClientRect().height;
    if (Math.abs(height - previousHeight) >= 1 && previousHeight) {
      bubble.animate([{ height: `${previousHeight}px` }, { height: `${height}px` }], { duration: enterMs, easing: ease });
    }
    bubble.querySelector('.novel-line').animate([{ opacity: .78, translate: '0 3px' }, { opacity: 1, translate: '0 0' }], { duration: stateMs, easing: ease });
  }
  function showTalk(nextLines, mode) {
    talkLines = nextLines;
    talkIndex = 0;
    talkMode = mode;
    talk.hidden = false;
    renderTalk();
  }
  function closeTalk() {
    talk.hidden = true;
    talkMode = null;
  }
  function advanceTalk() {
    if (!talkMode) return;
    if (talkIndex < talkLines.length - 1) {
      talkIndex += 1;
      renderTalk();
      return;
    }
    const mode = talkMode;
    closeTalk();
    if (mode === 'miss') {
      stage.classList.remove('is-dark');
      lightSwitch.classList.remove('is-off');
      lightSwitch.setAttribute('aria-pressed', 'false');
      render();
    } else if (mode === 'hit') {
      phase = 'result';
      status.textContent = messages.result;
      render();
      result.querySelector('[data-done]')?.focus({ preventScroll: true });
    }
  }
  let hammerSample = null;
  function tappedHammer(event) {
    if (event.target.closest('.luminol-switch, .luminol-zoom-controls')) return false;
    if (event.target.closest('.luminol-hit')) return true;
    const img = viewport.querySelector('.luminol-hammer-art');
    if (!img) return false;
    const rect = img.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return false;
    if (!img.complete || !img.naturalWidth) return event.target.closest('.luminol-hammer-art');
    try {
      if (!hammerSample) {
        hammerSample = document.createElement('canvas');
        hammerSample.width = img.naturalWidth;
        hammerSample.height = img.naturalHeight;
        hammerSample.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
      }
      const x = Math.min(hammerSample.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * hammerSample.width)));
      const y = Math.min(hammerSample.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) / rect.height * hammerSample.height)));
      return hammerSample.getContext('2d').getImageData(x, y, 1, 1).data[3] > 24;
    } catch {
      return Boolean(event.target.closest('.luminol-hammer-art'));
    }
  }

  bindDrag(reagent, base, finishMixFrom(reagent));
  bindDrag(base, reagent, finishMixFrom(base));
  bindDrag(spray, stainTarget, finishSpray, { requireHit: true });
  lightSwitch.addEventListener('click', finishDark);
  resetButton.addEventListener('click', reset);
  result.querySelector('[data-done]').addEventListener('click', () => {
    if (!allowed() || phase !== 'result') return;
    if (onDone) onDone();
    else host.closest('dialog')?.close();
  });
  talk.querySelector('[data-talk-next]').addEventListener('click', advanceTalk);
  status.textContent = messages.mix;
  render();
  showTalk(lines.intro, 'intro');
  return {
    refresh: render,
    destroy() { disposed = true; clearTimer(); talk.remove(); },
  };
}
