// Keyboard changes can resize only the visual viewport, leaving dvh/layout unchanged.
// https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport
// https://developer.chrome.com/blog/viewport-resize-behavior
export function bindVisualViewport(win = window, doc = document) {
  let queued = false;
  let restingHeight = 0;
  let lastWidth;
  let lastHeight = 0;
  const listeners = [];

  function update() {
    const viewport = win.visualViewport;
    // Pinch zoom should magnify the page rather than resize its application frame.
    if (viewport && Math.abs((viewport.scale ?? 1) - 1) > .01) return;
    const height = viewport?.height ?? win.innerHeight;
    if (!Number.isFinite(height) || height <= 0 || !doc.documentElement?.style) return;
    const focused = doc.activeElement;
    const editingAnswer = focused?.matches?.('#answer-form input[type="text"], #answer-form textarea');
    if (!editingAnswer || !restingHeight || win.innerWidth !== lastWidth) restingHeight = height;
    lastWidth = win.innerWidth;
    // Some browsers resize the layout, others shrink only the visual viewport.
    const keyboard = editingAnswer && Math.max(restingHeight, win.innerHeight) - height > 80;
    const heightDrop = lastHeight - height;
    lastHeight = height;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + height;
    const style = doc.documentElement.style;
    style.setProperty('--visual-height', `${height}px`);
    style.setProperty('--visual-offset-top', `${top}px`);
    style.setProperty('--visual-bottom-inset', `${Math.max(0, (win.innerHeight ?? bottom) - bottom)}px`);

    const workspace = doc.querySelector('.workspace');
    if (workspace) {
      workspace.toggleAttribute?.('data-answer-keyboard', Boolean(keyboard));
      const gap = parseFloat(win.getComputedStyle(workspace).getPropertyValue('--workspace-bottom-gap')) || 0;
      // DOM rects and offsetTop use layout-viewport coordinates, including browser panning.
      workspace.style.setProperty('--workspace-height', `${Math.max(0, bottom - workspace.getBoundingClientRect().top - gap)}px`);
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
    if (field.bottom > visibleBottom) surface.scrollTop += field.bottom - visibleBottom;
    else if (field.top < visibleTop) surface.scrollTop -= visibleTop - field.top;
    // Follow gradual native resize events directly. Ease a single large keyboard jump.
    if (keyboard && heightDrop > 80 && !win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      surface.animate?.([{ translate: '0 36px' }, { translate: '0 0' }],
        { duration: 170, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
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
  return { update, schedule, dispose() { for (const [target, name] of listeners) target.removeEventListener(name, schedule); } };
}
