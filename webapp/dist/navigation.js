// One temporary entry protects open surfaces without recording puzzle answers in URLs.
export function createOverlayHistory(win, onBack, key = 'november-kyusai') {
  const history = win.history;
  if (!history?.pushState || !history?.back) return { sync() {}, dispose() {} };
  const marker = '__webbotOverlay';
  const own = state => state?.[marker] === key;
  let armed = own(history.state);
  let active = false;
  let pendingBack = false;
  let handling = false;
  let disposed = false;
  function reconcile() {
    if (disposed || pendingBack || handling) return;
    armed = own(history.state);
    try {
      if (active && !armed) {
        const base = history.state && typeof history.state === 'object' ? history.state : {};
        history.pushState({ ...base, [marker]: key }, '');
        armed = true;
      } else if (!active && armed) {
        pendingBack = true;
        history.back();
      }
    } catch { pendingBack = false; /* History restrictions must not block the app. */ }
  }
  function pop(event) {
    if (disposed) return;
    const wasArmed = armed;
    armed = own(event.state);
    if (pendingBack) { pendingBack = false; reconcile(); return; }
    if (wasArmed && !armed && active) {
      handling = true;
      Promise.resolve().then(onBack).finally(() => { handling = false; reconcile(); });
    } else reconcile();
  }
  win.addEventListener('popstate', pop);
  return {
    sync(value) { active = Boolean(value); reconcile(); },
    dispose() { disposed = true; win.removeEventListener('popstate', pop); },
  };
}
