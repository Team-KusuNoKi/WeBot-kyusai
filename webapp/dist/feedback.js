import { MOTION } from './interaction.js';

const emphases = new WeakMap();
export function animateEmphasis(element, reduced = false) {
  if (!element?.animate || reduced) return;
  emphases.get(element)?.cancel();
  const animation = element.animate([
    { scale: 1 }, { scale: 1.07, offset: .4 }, { scale: 1 },
  ], { duration: 360, easing: MOTION.ease });
  emphases.set(element, animation);
  void animation.finished.catch(() => {}).finally(() => {
    if (emphases.get(element) === animation) { emphases.delete(element); animation.cancel(); }
  });
}

const disclosures = new WeakMap();

function closedDisclosureHeight(details, summary) {
  // Summary height plus the details' own padding/border (the latter excludes body).
  const fallback = summary.getBoundingClientRect().height + details.offsetHeight - details.clientHeight
    + parseFloat(getComputedStyle(details).paddingTop || 0) + parseFloat(getComputedStyle(details).paddingBottom || 0);
  // History cards change padding when they close, so measure the closed box instead of the open one.
  if (!details.classList?.contains('history-entry') || typeof details.cloneNode !== 'function' || !details.parentElement) return fallback;
  const clone = details.cloneNode(false);
  clone.open = false;
  clone.classList.remove('is-closing');
  clone.append(summary.cloneNode(true));
  clone.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;height:auto;overflow:visible;width:${details.offsetWidth}px;margin:0;animation:none;transition:none;`;
  try {
    details.parentElement.append(clone);
    const height = clone.offsetHeight;
    clone.remove();
    return height || fallback;
  } catch {
    clone.remove?.();
    return fallback;
  }
}

function releaseDisclosureStyles(details) {
  if (!details.style) return;
  details.style.height = '';
  details.style.overflow = '';
}

// Keep native details/summary semantics, including keyboard activation.
export function toggleDisclosure(details, reduced = false) {
  const summary = details.querySelector('summary');
  const previous = disclosures.get(details);
  if (!summary || !details.animate || reduced) {
    previous?.animation.cancel();
    disclosures.delete(details);
    details.classList?.remove('is-closing');
    releaseDisclosureStyles(details);
    const content = details.querySelector('.history-messages, .afterword-note-body, p');
    if (content) content.inert = false;
    return false;
  }
  const opening = previous ? !previous.opening : !details.open;
  const from = details.getBoundingClientRect().height;
  previous?.animation.cancel();
  if (opening) {
    details.classList?.remove('is-closing');
    details.open = true;
  } else details.classList?.add('is-closing');
  const content = details.querySelector('.history-messages, .afterword-note-body, p');
  if (content) content.inert = !opening;
  const to = opening ? details.getBoundingClientRect().height : closedDisclosureHeight(details, summary);
  const animation = details.animate([
    { height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' },
  ], { duration: MOTION.enter, easing: MOTION.ease, fill: 'both' });
  disclosures.set(details, { animation, opening });
  void animation.finished.then(() => {
    if (disclosures.get(details)?.animation !== animation) return;
    // Cancelling the fill snaps back to the open height for a frame. Commit the closed box first.
    if (!opening) {
      try { animation.commitStyles?.(); } catch { /* The fill holds the closed height until cancel. */ }
    }
    details.open = opening;
    if (content) content.inert = false;
    if (!opening) details.classList?.remove('is-closing');
    disclosures.delete(details);
    animation.cancel();
    releaseDisclosureStyles(details);
  }).catch(() => {});
  return true;
}

// Return null for the immediate path, avoiding an artificial wait without motion.
export function animateCombination(cards, reduced = false) {
  if (reduced || cards.length !== 2 || cards.some(card => !card.animate)) return null;
  const rects = cards.map(card => card.getBoundingClientRect());
  const center = (rects[0].left + rects[0].width / 2 + rects[1].left + rects[1].width / 2) / 2;
  const animations = cards.map((card, index) => {
    const distance = Math.max(-18, Math.min(18, (center - rects[index].left - rects[index].width / 2) * .2));
    return card.animate([
      { transform: 'translateX(0px) scale(1)' },
      { transform: `translateX(${distance}px) scale(.97)`, offset: .6 },
      { transform: 'translateX(0px) scale(1)' },
    ], { duration: 280, easing: MOTION.ease });
  });
  return Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    animations.forEach(animation => animation.cancel());
  });
}

export async function copyWithFeedback({ code, button, message, writeText, isCurrent, checkIcon, copyIcon, onSuccess, reduced = false }) {
  button.disabled = true;
  try {
    await writeText(code);
    if (!isCurrent()) return;
    button.innerHTML = `${checkIcon}<span>コピー済み</span>`;
    button.setAttribute('aria-label', '再開番号をコピーしました。もう一度コピーする');
    if (message) message.textContent = 'コピーしました';
    animateEmphasis(button.querySelector('svg'), reduced);
    onSuccess();
  } catch {
    if (!isCurrent()) return;
    button.innerHTML = `${copyIcon}<span>コピー</span>`;
    button.setAttribute('aria-label', '再開番号をコピー');
    if (message) message.textContent = 'コピーできませんでした。番号を選択してコピーしてください。';
  } finally {
    if (isCurrent()) button.disabled = false;
  }
}
