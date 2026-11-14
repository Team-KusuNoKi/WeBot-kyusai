// Keyboard changes can resize only the visual viewport, leaving dvh/layout unchanged.
// https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport
// https://developer.chrome.com/blog/viewport-resize-behavior
export function bindVisualViewport(win = window, doc = document) {
  let queued = false;
  let restingHeight = 0;
  let lastWidth;
  let lastHeight = 0;
  let settleTimer = 0;
  let keyboardHeld = false;
  let sheetMorph;
  const listeners = [];

  const reduced = () => Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  // ドックの形状変化を、切り替え前後の実測値から補間する。
  function morphSheet(composer, before, beforeRadius) {
    if (!composer?.animate || !before?.width || reduced()) return false;
    const after = composer.getBoundingClientRect();
    if (!after.width || !after.height) return false;
    const dx = before.left + before.width / 2 - (after.left + after.width / 2);
    const dy = before.bottom - after.bottom;
    const sx = before.width / after.width;
    if (Math.abs(dx) < .5 && Math.abs(dy) < .5 && Math.abs(sx - 1) < .01) return false;
    sheetMorph?.cancel();
    const animation = sheetMorph = composer.animate([
      { transformOrigin: 'center bottom', transform: `translate(${dx}px, ${dy}px) scaleX(${sx})`, borderRadius: beforeRadius },
      { transformOrigin: 'center bottom', transform: 'translate(0px, 0px) scaleX(1)', borderRadius: win.getComputedStyle?.(composer)?.borderRadius ?? beforeRadius },
    ], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
    animation.finished.then(() => { if (sheetMorph === animation) { sheetMorph.cancel(); sheetMorph = null; } }).catch(() => {});
    return true;
  }

  function scrollSurface(surface, delta, heightDrop) {
    // キーボード移動中でない小さな補正だけ滑らかに追従する。
    if (surface.scrollBy && Math.abs(heightDrop) < 20 && Math.abs(delta) <= 64 && !reduced()) {
      surface.scrollBy({ top: delta, behavior: 'smooth' });
    } else surface.scrollTop += delta;
  }

  function update() {
    const viewport = win.visualViewport;
    // Pinch zoom should magnify the page rather than resize its application frame.
    if (viewport && Math.abs((viewport.scale ?? 1) - 1) > .01) return;
    const height = viewport?.height ?? win.innerHeight;
    if (!Number.isFinite(height) || height <= 0 || !doc.documentElement?.style) return;
    const focused = doc.activeElement;
    const editing = Boolean(focused?.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="hidden"]), textarea, select'));
    const editingAnswer = Boolean(editing && focused?.closest?.('#answer-form'));
    // キーボード保持中に基準高を縮んだ値で上書きしない。
    if (!restingHeight || win.innerWidth !== lastWidth || (!editing && !keyboardHeld)) restingHeight = height;
    lastWidth = win.innerWidth;
    const shrunk = Math.max(restingHeight, win.innerHeight) - height;
    // いったんドックしたら、キーボードが退き切るまで形状を維持する。
    if (editingAnswer && shrunk > 80) keyboardHeld = true;
    else if (shrunk <= 24) keyboardHeld = false;
    const keyboard = keyboardHeld;
    const heightDrop = lastHeight ? lastHeight - height : 0;
    lastHeight = height;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + height;
    const style = doc.documentElement.style;
    style.setProperty('--visual-height', `${height}px`);
    style.setProperty('--visual-offset-top', `${top}px`);
    style.setProperty('--visual-bottom-inset', `${Math.max(0, (win.innerHeight ?? bottom) - bottom)}px`);

    let morphTarget = null;
    const workspace = doc.querySelector('.workspace');
    if (workspace) {
      const wasKeyboard = workspace.hasAttribute?.('data-answer-keyboard');
      const docking = Boolean(keyboard);
      let morph = null;
      if (docking !== wasKeyboard) {
        const composer = workspace.querySelector?.('.composer-area:not([hidden]):not(.answer-page)');
        const before = composer?.getBoundingClientRect?.();
        const beforeRadius = composer ? win.getComputedStyle?.(composer)?.borderRadius : '';
        workspace.toggleAttribute?.('data-answer-keyboard', docking);
        morph = () => { if (morphSheet(composer, before, beforeRadius)) morphTarget = composer; };
        // キーボードを上げたまま送信すると閉じる最後のresizeが来ない端末があるため、収納後にもう一度測り直す。
        if (wasKeyboard) settle();
      } else {
        workspace.toggleAttribute?.('data-answer-keyboard', docking);
      }
      const gap = parseFloat(win.getComputedStyle(workspace).getPropertyValue('--workspace-bottom-gap')) || 0;
      // DOM rects and offsetTop use layout-viewport coordinates, including browser panning.
      workspace.style.setProperty('--workspace-height', `${Math.max(0, bottom - workspace.getBoundingClientRect().top - gap)}px`);
      morph?.();
    }

    // Move only the scrollable answer surface, keeping the conversation's scroll position.
    const surface = focused?.closest?.('.composer-area, dialog');
    if (!surface || surface === focused || surface.hidden || surface.inert) return;
    const focusedBounds = focused.getBoundingClientRect();
    const field = { top: focusedBounds.top, bottom: focusedBounds.bottom };
    const bounds = surface.getBoundingClientRect();
    const visibleTop = Math.max(top, bounds.top) + 12;
    const visibleBottom = Math.min(bottom, bounds.bottom) - 12;
    if (visibleBottom <= visibleTop) return;
    const submit = focused.closest?.('#answer-form')?.querySelector?.('button[type="submit"]');
    if (submit && !submit.disabled) {
      const submitBounds = submit.getBoundingClientRect();
      if (submitBounds.bottom - field.top <= visibleBottom - visibleTop) field.bottom = Math.max(field.bottom, submitBounds.bottom);
    }
    if (field.bottom > visibleBottom) scrollSurface(surface, field.bottom - visibleBottom, heightDrop);
    else if (field.top < visibleTop) scrollSurface(surface, field.top - visibleBottom, heightDrop);
    // Follow gradual native resize events directly. Ease a single large keyboard jump in either direction.
    if (editing && Math.abs(heightDrop) > 80 && !reduced() && surface !== morphTarget) {
      surface.animate?.([{ transform: `translateY(${heightDrop > 0 ? 36 : -36}px)` }, { transform: 'translateY(0px)' }],
        { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }

  function settle() {
    if (!win.setTimeout) return;
    win.clearTimeout?.(settleTimer);
    settleTimer = win.setTimeout(() => { settleTimer = 0; update(); }, 400);
  }

  function schedule() {
    if (queued) return;
    queued = true;
    const frame = win.requestAnimationFrame?.bind(win) ?? (callback => callback());
    frame(() => { queued = false; update(); });
  }

  function listen(target, name) {
    if (!target?.addEventListener) return;
    target.addEventListener(name, schedule, { passive: true });
    listeners.push([target, name]);
  }
  for (const name of ['resize', 'scroll']) listen(win.visualViewport, name);
  for (const name of ['resize', 'scroll', 'orientationchange', 'pageshow']) listen(win, name);
  for (const name of ['focusin', 'focusout']) listen(doc, name);
  update();
  return { update, schedule, dispose() { win.clearTimeout?.(settleTimer); sheetMorph?.cancel(); for (const [target, name] of listeners) target.removeEventListener(name, schedule); } };
}
