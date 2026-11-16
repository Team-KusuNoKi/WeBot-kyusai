export function mountLuminol(host, { onDone, canInteract } = {}) {
  host.innerHTML = `<section class="hex-game luminol-game" aria-label="ルミノール検査"><div class="hex-layout"><section class="hex-rules"><h2>手順</h2><p><span data-rule="mix">①二つの小瓶を一つに混ぜる。</span><br><span data-rule="spray">②トンカチの赤い部分へ吹きかける。</span><br><span data-rule="lights">③電気を消す。</span></p></section><section class="hex-board" aria-label="検査"><div class="hex-modes" aria-label="今の手順"><span data-step="mix">混ぜる</span><span data-step="spray">噴霧</span><span data-step="lights">消灯</span></div><div class="luminol-stage" data-phase="mix"><div class="luminol-mix"><div class="luminol-vial" data-drop="base"><span class="luminol-vial-neck" aria-hidden="true"></span><span class="luminol-vial-body"><span class="luminol-vial-liquid"></span></span><span class="luminol-vial-name">ルミノール</span></div><button type="button" class="luminol-vial is-reagent" data-drag="reagent" aria-label="酸化剤。ルミノールの小瓶へドラッグするか、決定で混ぜる"><span class="luminol-vial-neck" aria-hidden="true"></span><span class="luminol-vial-body"><span class="luminol-vial-liquid"></span></span><span class="luminol-vial-name">酸化剤</span></button></div><div class="luminol-inspect"><div class="luminol-hammer-wrap"><svg class="luminol-hammer" viewBox="0 0 180 230" aria-hidden="true"><path class="luminol-line" stroke-width="3" stroke-linejoin="round" d="M34 86c0-18 14-30 32-30h58c20 0 34 12 34 28 0 14-10 24-24 26H86l-18 22-16-18 14-16H66c-18 0-32-8-32-12z"/><path class="luminol-line" fill="none" stroke-width="3" stroke-linecap="round" d="M132 66c20 6 30 18 26 32"/><ellipse class="luminol-stain" cx="78" cy="82" rx="34" ry="15"/><rect class="luminol-line" x="78" y="108" width="24" height="104" rx="12" stroke-width="3"/><circle cx="90" cy="190" r="4.5" fill="none" stroke-width="2.5"/></svg><div class="luminol-hit" data-drop="stain"></div><span class="luminol-mist" aria-hidden="true"><i></i><i></i><i></i></span></div><button type="button" class="luminol-spray" data-drag="spray" aria-label="噴霧器。トンカチの赤い部分へドラッグするか、決定で吹きかける"><span class="luminol-spray-body" aria-hidden="true"><span class="luminol-spray-nozzle"></span></span><span class="luminol-vial-name">噴霧器</span></button><button type="button" class="luminol-switch" aria-pressed="false" aria-label="電気を消す"><span class="luminol-switch-plate" aria-hidden="true"><span class="luminol-switch-lever"></span></span><span class="luminol-vial-name">電気</span></button><div class="luminol-result" hidden><p>何も光らない。</p><p>この赤い液体は、血ではない。</p><button type="button" class="primary-button" data-done>確認した</button></div></div></div><button type="button" class="hex-reset primary-button">やり直す</button></section></div><p class="hex-status" role="status" aria-live="polite"></p></section>`;

  const root = host.querySelector('.luminol-game');
  const stage = root.querySelector('.luminol-stage');
  const status = root.querySelector('.hex-status');
  const result = root.querySelector('.luminol-result');
  const reagent = root.querySelector('[data-drag="reagent"]');
  const spray = root.querySelector('[data-drag="spray"]');
  const base = root.querySelector('[data-drop="base"]');
  const stainTarget = root.querySelector('[data-drop="stain"]');
  const stain = root.querySelector('.luminol-stain');
  const liquid = base.querySelector('.luminol-vial-liquid');
  const lightSwitch = root.querySelector('.luminol-switch');
  const resetButton = root.querySelector('.hex-reset');
  const messages = {
    mix: '酸化剤をルミノールへ混ぜてください。',
    spray: '混ざりました。噴霧器でトンカチの赤い部分へ吹きかけてください。',
    lights: '吹きかけました。電気を消してください。',
    result: '何も光りません。この赤い液体は血ではありません。',
  };
  let phase = 'mix';
  let busy = false;
  let disposed = false;
  let timer = null;
  const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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
    root.querySelectorAll('[data-step]').forEach(el => {
      const on = el.dataset.step === step;
      el.classList.toggle('active', on);
      el.setAttribute('aria-current', String(on));
    });
    root.querySelectorAll('[data-rule]').forEach(el => {
      el.setAttribute('aria-current', el.dataset.rule === step ? 'step' : 'false');
    });
    result.hidden = phase !== 'result';
    reagent.disabled = !enabled();
    spray.disabled = !enabled();
    lightSwitch.disabled = !enabled();
    resetButton.disabled = !allowed() || busy;
    result.querySelector('[data-done]').disabled = !allowed();
  }
  function finishMix() {
    if (phase !== 'mix' || busy || !allowed()) return;
    busy = true;
    render();
    reagent.style.transform = '';
    reagent.classList.add('is-pouring');
    liquid.classList.add('is-mixed');
    later(480, () => {
      busy = false;
      phase = 'spray';
      status.textContent = messages.spray;
      render();
    });
  }
  function finishSpray() {
    if (phase !== 'spray' || busy || !allowed()) return;
    busy = true;
    render();
    spray.style.transform = '';
    stage.classList.add('is-spraying');
    stain.classList.add('is-wet');
    later(560, () => {
      busy = false;
      stage.classList.remove('is-spraying');
      phase = 'lights';
      status.textContent = messages.lights;
      render();
    });
  }
  function finishDark() {
    if (phase !== 'lights' || busy || !allowed()) return;
    busy = true;
    render();
    stage.classList.add('is-dark');
    lightSwitch.classList.add('is-off');
    lightSwitch.setAttribute('aria-pressed', 'true');
    status.textContent = '電気を消しました。';
    later(700, () => {
      busy = false;
      phase = 'result';
      status.textContent = messages.result;
      render();
      result.querySelector('[data-done]')?.focus({ preventScroll: true });
    });
  }
  function reset() {
    if (!allowed()) return;
    clearTimer();
    busy = false;
    phase = 'mix';
    stage.classList.remove('is-dark', 'is-spraying');
    reagent.classList.remove('is-pouring');
    reagent.style.transform = '';
    spray.style.transform = '';
    stain.classList.remove('is-wet');
    liquid.classList.remove('is-mixed');
    base.classList.remove('is-armed');
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
  function bindDrag(handle, target, commit) {
    let drag = null;
    const end = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const moved = drag.moved;
      const hit = moved && overlaps(handle, target);
      drag = null;
      handle.classList.remove('is-dragging');
      target.classList.remove('is-armed');
      if (!moved || hit) commit();
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

  bindDrag(reagent, base, finishMix);
  bindDrag(spray, stainTarget, finishSpray);
  lightSwitch.addEventListener('click', finishDark);
  resetButton.addEventListener('click', reset);
  result.querySelector('[data-done]').addEventListener('click', () => { if (allowed() && phase === 'result') onDone?.(); });
  status.textContent = messages.mix;
  render();
  return {
    refresh: render,
    destroy() { disposed = true; clearTimer(); },
  };
}
