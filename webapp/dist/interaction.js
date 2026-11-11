// Shared interaction timing and geometry, independent of scenario content.
export const MOTION = Object.freeze({ press: 140, state: 180, enter: 260, exit: 180, ease: 'cubic-bezier(.2,.8,.2,1)' });

// Vibration API is optional. Its return value cannot confirm physical feedback.
export function createHaptics({ win = globalThis.window, doc = globalThis.document, now = () => Date.now() } = {}) {
  const nav = win?.navigator;
  const supported = typeof nav?.vibrate === 'function';
  const signals = {
    dialogue: { pulses: [6], priority: 0 },
    selection: { pulses: [8], priority: 0 },
    paper: { pulses: [10, 18, 5], priority: 0 },
    ready: { pulses: [6, 25, 6], priority: 1 },
    pageTurn: { pulses: [12, 32, 8], priority: 1 },
    success: { pulses: [16, 35, 22], priority: 2 },
    error: { pulses: [24, 40, 24], priority: 2 },
    complete: { pulses: [18, 35, 18, 35, 30], priority: 3 },
  };
  const preferenceKey = 'webbot:haptics-enabled';
  let enabled = true;
  let busyUntil = 0;
  let priority = 0;
  let active = false;
  if (supported) {
    try { enabled = win.localStorage?.getItem(preferenceKey) !== 'false'; } catch { /* Optional device preference. */ }
  }
  function cancel() {
    if (active) { try { nav.vibrate(0); } catch { /* A blocked API must not interrupt play. */ } }
    active = false;
    busyUntil = priority = 0;
  }
  return {
    supported,
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) cancel();
      if (supported) { try { win.localStorage?.setItem(preferenceKey, String(enabled)); } catch { /* Keep the session preference. */ } }
    },
    trigger(kind = 'selection') {
      const signal = signals[kind];
      if (!supported || !enabled || !signal || doc?.visibilityState === 'hidden'
        || win.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        || nav.userActivation && !nav.userActivation.isActive) return false;
      const time = now();
      // Results may replace a selection tick; rapid input cannot truncate a result.
      const { pulses: pattern, priority: nextPriority } = signal;
      if (time < busyUntil && nextPriority <= priority) return false;
      try {
        if (!nav.vibrate([...pattern])) return false;
        active = true;
        busyUntil = time + pattern.reduce((sum, ms) => sum + ms, 0) + 50;
        priority = nextPriority;
        return true;
      } catch { return false; }
    },
    cancel,
  };
}

export function answerReadiness(problem, raw) {
  const values = (Array.isArray(raw) ? raw : [raw]).map(value => String(value ?? '').trim()).filter(Boolean);
  const required = problem.answerSlots ?? (problem.type === 'fields' ? problem.fields.length : problem.type === 'multiple' ? problem.selectionCount ?? 1 : 1);
  if (problem.type === 'fields') {
    const index = problem.fields.findIndex(field => field.kanaChoices);
    if (index >= 0 && String(raw?.[index] ?? '').replace(/\s/g, '').length !== problem.fields[index].length) {
      return { ready: false, message: `共通の言葉をひらがな${problem.fields[index].length}文字で入力してください。` };
    }
  }
  const remaining = Math.max(0, required - values.length);
  if (problem.type === 'multiple' && problem.selectionCount && values.length > required) return { ready: false, message: `${required}つ選んでください。現在${values.length}つ選択しています。` };
  return { ready: remaining === 0, message: remaining === 0 ? '' : problem.type === 'fields' || problem.answerSlots ? `あと${remaining}つの空欄を入力・選択してください。` : problem.type === 'multiple' ? `あと${remaining}つ選んでください。` : problem.type === 'single' || problem.answerChoices || problem.answerControl === 'select' ? '答えを選択してください。' : '答えを入力してください。' };
}

export function isComposingSubmit(event, composing, endedAt, now = Date.now()) {
  return Boolean(composing || event.isComposing || event.keyCode === 229 || (endedAt !== null && now - endedAt < 120));
}

export function constrainImageTransform(view, natural, transform) {
  const scale = Math.max(1, Math.min(4, transform.scale));
  const fit = Math.min(view.width / (natural.width || view.width), view.height / (natural.height || view.height));
  const maxX = Math.max(0, ((natural.width || view.width) * fit * scale - view.width) / 2);
  const maxY = Math.max(0, ((natural.height || view.height) * fit * scale - view.height) / 2);
  return { scale, x: maxX ? Math.max(-maxX, Math.min(maxX, transform.x)) : 0, y: maxY ? Math.max(-maxY, Math.min(maxY, transform.y)) : 0 };
}

export function bindImageViewer(panel, { onPage = () => {}, motion = () => false, onInteract = () => {}, win = globalThis.window } = {}) {
  const stage = panel.querySelector('.image-viewer-stage');
  const image = panel.querySelector('.puzzle-full-image');
  if (!stage?.addEventListener || !image?.style) return null;
  const listeners = [];
  const pointers = new Map();
  let state = { scale: 1, x: 0, y: 0 };
  let gesture = null;
  let hadPinch = false;
  let imageAnimation;
  let lastTap = null;
  let pendingOrigin = null;
  const listen = (node, type, fn, options) => { node.addEventListener(type, fn, options); listeners.push(() => node.removeEventListener(type, fn, options)); };
  const bounds = () => stage.getBoundingClientRect();
  function apply(next) {
    state = constrainImageTransform(bounds(), { width: image.naturalWidth, height: image.naturalHeight }, next);
    image.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
    stage.classList.toggle('is-zoomed', state.scale > 1);
    const label = panel.querySelector('[data-zoom-label]');
    if (label) label.textContent = `${Math.round(state.scale * 100)}%`;
    for (const [action, disabled] of [['image-zoom-out', state.scale === 1], ['image-zoom-in', state.scale === 4]]) {
      const button = panel.querySelector(`[data-action="${action}"]`);
      if (button) button.disabled = disabled;
    }
  }
  function zoom(scale, clientX, clientY) {
    onInteract();
    imageAnimation?.cancel();
    const rect = bounds();
    const x = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
    const y = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
    const factor = Math.max(1, Math.min(4, scale)) / state.scale;
    const before = image.style.transform;
    apply({ scale, x: x + (state.x - x) * factor, y: y + (state.y - y) * factor });
    if (!motion() && image.animate && pointers.size === 0) imageAnimation = image.animate([{ transform: before }, { transform: image.style.transform }], { duration: MOTION.state, easing: MOTION.ease });
  }
  function reset() { imageAnimation?.cancel(); pointers.clear(); gesture = null; hadPinch = false; lastTap = null; apply({ scale: 1, x: 0, y: 0 }); }
  function startGesture() {
    const points = [...pointers.values()];
    const rect = bounds();
    gesture = points.length > 1 ? {
      distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
      cx: (points[0].x + points[1].x) / 2 - rect.left - rect.width / 2,
      cy: (points[0].y + points[1].y) / 2 - rect.top - rect.height / 2, ...state,
    } : points.length ? { start: points[0], ...state } : null;
  }
  listen(stage, 'pointerdown', event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    onInteract();
    imageAnimation?.cancel();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    stage.setPointerCapture?.(event.pointerId);
    if (pointers.size > 1) { hadPinch = true; lastTap = null; }
    startGesture();
  });
  listen(stage, 'pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.values()];
    if (points.length > 1 && gesture?.distance) {
      const rect = bounds();
      const factor = Math.max(1, Math.min(4, gesture.scale * Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / gesture.distance)) / gesture.scale;
      const cx = (points[0].x + points[1].x) / 2 - rect.left - rect.width / 2;
      const cy = (points[0].y + points[1].y) / 2 - rect.top - rect.height / 2;
      apply({ scale: gesture.scale * factor, x: cx + (gesture.x - gesture.cx) * factor, y: cy + (gesture.y - gesture.cy) * factor });
    } else if (gesture?.start && state.scale > 1) apply({ scale: state.scale, x: gesture.x + event.clientX - gesture.start.x, y: gesture.y + event.clientY - gesture.start.y });
  });
  function release(event) {
    if (!pointers.has(event.pointerId)) return;
    const start = gesture?.start;
    const dx = start ? event.clientX - start.x : 0;
    const dy = start ? event.clientY - start.y : 0;
    const tap = event.type === 'pointerup' && !hadPinch && start && Math.hypot(dx, dy) < 10;
    const swipe = event.type === 'pointerup' && !hadPinch && state.scale === 1 && start && Math.abs(dx) >= 44 && Math.abs(dx) > Math.abs(dy) * 1.3;
    pointers.delete(event.pointerId);
    if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    if (tap) {
      const now = Date.now();
      if (lastTap && now - lastTap.time < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 32) { zoom(state.scale > 1 ? 1 : 2, event.clientX, event.clientY); lastTap = null; }
      else lastTap = { time: now, x: event.clientX, y: event.clientY };
    } else lastTap = null;
    startGesture();
    if (!pointers.size) hadPinch = false;
    if (swipe) onPage(dx < 0 ? 1 : -1);
  }
  listen(stage, 'pointerup', release);
  listen(stage, 'pointercancel', release);
  listen(stage, 'lostpointercapture', event => { if (pointers.delete(event.pointerId)) { startGesture(); if (!pointers.size) hadPinch = false; } });
  listen(stage, 'wheel', event => { event.preventDefault(); zoom(state.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX, event.clientY); }, { passive: false });
  listen(stage, 'keydown', event => {
    if (['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); zoom(event.key === '0' ? 1 : state.scale + (event.key === '-' ? -.5 : .5)); }
    else if (state.scale > 1 && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      apply({ ...state, x: state.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0), y: state.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0) });
    }
  });
  listen(image, 'load', () => { reset(); if (pendingOrigin) { const origin = pendingOrigin; pendingOrigin = null; revealFrom(origin); } });
  listen(win, 'resize', () => apply(state));
  reset();
  function revealFrom(rect) {
    if (!rect?.width || !rect.height || motion() || !image.animate) return;
    if (!image.complete) { pendingOrigin = rect; return; }
    const target = image.getBoundingClientRect();
    if (!target.width || !target.height) return;
    imageAnimation = image.animate([{ opacity: .6, transform: `translate(${rect.left + rect.width / 2 - target.left - target.width / 2}px, ${rect.top + rect.height / 2 - target.top - target.height / 2}px) scale(${Math.min(rect.width / target.width, rect.height / target.height)})` }, { opacity: 1, transform: 'translate(0px, 0px) scale(1)' }], { duration: MOTION.enter, easing: MOTION.ease });
  }
  function dismissTo(rect) {
    pendingOrigin = null;
    if (!rect?.width || !rect.height || motion() || !image.animate || !image.getBoundingClientRect) return null;
    const fromTransform = image.style.transform || 'translate(0px, 0px) scale(1)';
    // Measure the fitted image, so closing a zoomed/panned view still lands on its thumbnail.
    reset();
    const target = image.getBoundingClientRect();
    if (!target.width || !target.height) return null;
    imageAnimation?.cancel();
    const animation = imageAnimation = image.animate([
      { opacity: 1, transform: fromTransform },
      { opacity: 0, transform: `translate(${rect.left + rect.width / 2 - target.left - target.width / 2}px, ${rect.top + rect.height / 2 - target.top - target.height / 2}px) scale(${Math.min(rect.width / target.width, rect.height / target.height)})` },
    ], { duration: MOTION.enter, easing: MOTION.ease, fill: 'both' });
    return animation.finished.then(() => true).catch(() => false);
  }
  return {
    reset, zoom: delta => zoom(delta === 0 ? 1 : state.scale + delta), get scale() { return state.scale; },
    revealFrom, dismissTo,
    dispose() { imageAnimation?.cancel(); for (const remove of listeners) remove(); pointers.clear(); },
  };
}

// Drag only the sheet header; scrolling text and image gestures remain independent.
export function bindSheetDismiss(panel, { onDismiss, canDismiss = () => true, motion = () => false, onStart = () => {}, onThreshold = () => {} } = {}) {
  if (!panel.addEventListener) return null;
  const listeners = [];
  let drag = null;
  let rebound;
  let suppressClickUntil = 0;
  const threshold = () => Math.min(120, Math.max(72, panel.getBoundingClientRect().height * .22));
  const markReady = ready => panel.classList?.toggle('dismiss-ready', ready);
  const listen = (name, fn, options) => { panel.addEventListener(name, fn, options); listeners.push(() => panel.removeEventListener(name, fn, options)); };
  function clearTransform() { panel.style.removeProperty('transform'); }
  function reset() {
    markReady(false);
    if (!panel.style) return;
    const from = panel.style.transform || 'translateY(0px)';
    rebound?.cancel();
    clearTransform();
    if (panel.animate && !motion()) {
      const animation = rebound = panel.animate([{ transform: from }, { transform: 'translateY(0px)' }], { duration: MOTION.exit, easing: MOTION.ease });
      animation.finished.then(() => { if (rebound === animation) { rebound = null; animation.cancel(); } }).catch(() => {});
    }
  }
  listen('pointerdown', event => {
    if (event.isPrimary === false) { if (drag) { suppressClickUntil = Date.now() + 350; drag = null; reset(); } return; }
    if (!panel.open || panel.inert || !canDismiss() || panel.scrollTop > 0 || event.pointerType === 'mouse' && event.button !== 0) return;
    if (!event.target.closest?.('.panel-header') || event.target.closest?.('button:not(.sheet-handle), input, select, a, summary')) return;
    rebound?.cancel();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, startedAt: event.timeStamp, distance: 0, moved: false, thresholdNotified: false };
  });
  listen('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const x = event.clientX - drag.x;
    const y = event.clientY - drag.y;
    if (!drag.moved && (Math.abs(x) > 8 && Math.abs(x) > Math.abs(y) || y < -8)) { suppressClickUntil = Date.now() + 350; drag = null; return; }
    if (!drag.moved && y <= 8) return;
    if (!drag.moved) { onStart(); panel.setPointerCapture?.(event.pointerId); drag.moved = true; }
    event.preventDefault();
    drag.distance = Math.max(0, y);
    const ready = canDismiss() && drag.distance >= threshold();
    markReady(ready);
    if (ready && !drag.thresholdNotified) { drag.thresholdNotified = true; onThreshold(); }
    panel.style.transform = `translateY(${drag.distance}px)`;
  }, { passive: false });
  function finish(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const ended = drag;
    drag = null;
    markReady(false);
    if (panel.hasPointerCapture?.(event.pointerId)) panel.releasePointerCapture(event.pointerId);
    if (!ended.moved) return;
    suppressClickUntil = Date.now() + 350;
    const elapsed = Math.max(1, event.timeStamp - ended.startedAt);
    if (event.type === 'pointerup' && canDismiss() && (ended.distance >= threshold() || ended.distance > 32 && ended.distance / elapsed > .6)) onDismiss();
    else reset();
  }
  listen('pointerup', finish);
  listen('pointercancel', finish);
  listen('lostpointercapture', event => { if (drag?.id === event.pointerId) { drag = null; reset(); } });
  listen('click', event => {
    if (Date.now() < suppressClickUntil && event.target.closest?.('.panel-header')) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  return { dispose({ preservePosition = false } = {}) { rebound?.cancel(); drag = null; markReady(false); for (const remove of listeners) remove(); if (!preservePosition) clearTransform(); } };
}
