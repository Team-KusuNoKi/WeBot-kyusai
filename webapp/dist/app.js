import { scenario } from './scenario.js';
import { mountHexCube } from './hex-cube.js';
import { initialState, restoreState, submitAnswer, chooseBranch, unlockedCards, findCombination, canOpenProblem, investigationComplete, availableNavigationProblems, completeMinigame, readMinigameEntry } from './engine.js';
import { createConversationPlayer, latestSceneStart } from './conversation.js';
import { createPlaySaveController, normalizePlayCode } from './play-save.js';
import { isConversationLine, restorePlayView, pendingConversation, sanitizeAnswerDraft } from './save-view.js';
import { createOverlayHistory } from './navigation.js';
import { bindVisualViewport } from './viewport.js';
import { MOTION, createHaptics, answerReadiness, isComposingSubmit, bindImageViewer, bindSheetDismiss } from './interaction.js';
import { animateEmphasis, toggleDisclosure, animateCombination, copyWithFeedback } from './feedback.js';

const app = document.querySelector('#app');
const panel = document.querySelector('#panel');
const haptics = createHaptics({ win: window, doc: document });
const storageKey = `webbot:${scenario.id}`;
let state = initialState(scenario);
let storageWarning = '';
let playSaves;
let gateVisible = true;
let gateBusy = false;
let gateError = '';
let gateCode = '';
let gateDigits = Array(6).fill('');
let gateInput = false;
let localRecord = null;
let legacyState = null;
let announcedCode = false;
let changingSession = false;
let saveMutationBusy = false;
let feedback = '';
let answerErrorAnimation;
let imageViewer = null;
let sheetDismiss = null;
let answerDrafts = {};
let panelReturnFocus = null;
let panelReturnAction = null;
let composingAnswer = false;
let compositionEndedAt = null;
let submissionLockedUntil = 0;
let composerHeightAnimation;
let questionAdvanceAnimation = null;
let historyView = false;
let clueTab = 'cards';
let miniView=null, miniSaving=false, miniRewardAlready=false;
let playSessionRevision=0;
let requestedMinigame=readMinigameEntry(window.location?.href);
let expandedCharacter = null;
let historyChatScrollTop = 0;
let historyScrollTop = 0;
let historyOpenProblems = new Set();
let selectedPuzzleAnswer = '';
let selectedSymbols = [];
let activeSymbolSlot = 0;
let puzzleImageIndex = 0;
let composerExpanded = false;
let answerOrigin = null;
let menuExpanded = false;
let problemMenuExpanded = false;
let startView = true;
let yoiEndView = false;
let showVenueDirections = false;
let investigationView = false;
let investigationClosing = false;
let investigationScrollTop = 0;
let investigationReturnId = null;
let repeatAnswer = false;
let sceneStart = latestSceneStart(state.messages, state.selected);
let displayedMessages = [];
let isPlaying = false;
let novelPlayback = false;
let followChat = true;
let unreadConversationCount = 0;
let chatPointerDown = false;
let chatTouchDown = false;
let chatWheelActive = false;
let chatWheelTimer;
let panelRevision = 0;
let imageReturnElement = null;
let investigationSnapshot = null;
let seenConclusions = [];
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const viewportLayout = bindVisualViewport(window, document);
const overlayHistory = createOverlayHistory(window, dismissTopSurface, scenario.id);

function syncNavigation() {
  overlayHistory.sync(panel.open && !panel.classList.contains('is-closing') || historyView || !gateVisible && (investigationClosing || composerExpanded || menuExpanded || problemMenuExpanded));
}

function dismissTopSurface() {
  if (panel.open) return closePanel();
  if (historyView) return closeHistoryScreen();
  if (investigationClosing) return showInvestigation();
  if (problemMenuExpanded) { setProblemMenuExpanded(false); document.querySelector('.problem-toggle')?.focus({ preventScroll: true }); }
  else if (menuExpanded) { setMenuExpanded(false); document.querySelector('.menu-button')?.focus({ preventScroll: true }); }
  else if (composerExpanded) closeAnswerArea();
}

const chatIsBeingHandled = () => chatPointerDown || chatTouchDown || chatWheelActive;
const chatIsAtBottom = chat => chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 32;

function updateConversationNotice() {
  const notice = document.querySelector('#conversation-notice');
  if (!notice) return;
  notice.hidden = !unreadConversationCount;
  const label = `↓ 続きの会話（${unreadConversationCount}）`;
  if (notice.textContent !== label) notice.textContent = label;
}

function resumeChatFollowIfAtBottom() {
  const chat = document.querySelector('.chat-area');
  if (chat && !chatIsBeingHandled() && chatIsAtBottom(chat)) {
    followChat = true;
    unreadConversationCount = 0;
    updateConversationNotice();
  }
}

function pauseChatFollow() {
  followChat = false;
  const chat = document.querySelector('.chat-area');
  // 実行中のスムーズスクロールも現在の位置で止める。
  chat?.scrollTo({ top: chat.scrollTop, behavior: 'instant' });
}

function resetChatFollow() {
  clearTimeout(chatWheelTimer);
  chatPointerDown = chatTouchDown = chatWheelActive = false;
  followChat = true;
  unreadConversationCount = 0;
}

function bindChatScroll() {
  const chat = document.querySelector('.chat-area');
  chat.addEventListener('pointerdown', () => { chatPointerDown = true; pauseChatFollow(); }, { passive: true });
  chat.addEventListener('touchstart', () => { chatTouchDown = true; pauseChatFollow(); }, { passive: true });
  chat.addEventListener('wheel', () => {
    chatWheelActive = true;
    pauseChatFollow();
    clearTimeout(chatWheelTimer);
    chatWheelTimer = setTimeout(() => { chatWheelActive = false; resumeChatFollowIfAtBottom(); }, 180);
  }, { passive: true });
  chat.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseChatFollow();
  });
  chat.addEventListener('scroll', () => {
    resumeChatFollowIfAtBottom();
  }, { passive: true });
}

const conversationPlayer = createConversationPlayer({
  onMessage(message) {
    displayedMessages.push(message);
    save();
    const markup = messageMarkup(message);
    if (!markup) return;
    const messages = document.querySelector('#messages');
    messages.insertAdjacentHTML('beforeend', markup);
    messages.lastElementChild.classList.add('message-enter');
    document.querySelector(`.history-screen [data-history-problem="${message.problemId}"] .history-messages`)?.insertAdjacentHTML('beforeend', messageMarkup(message));
    if (followChat && !chatIsBeingHandled()) scrollConversationToEnd();
    else {
      const chat = document.querySelector('.chat-area');
      if (!chatIsAtBottom(chat)) unreadConversationCount++;
      updateConversationNotice();
    }
  },
  onComplete: finishConversation,
});

function finishConversation({ scroll = true } = {}) {
  isPlaying = false;
  save();
  render({ scroll });
  const pageTurnOpened = openFinishedPageTurn();
  if (yoiEndView) document.querySelector('#yoi-completion-title')?.focus({ preventScroll: true });
  revealItems('.chat-area .instruction-card, .travel-guide-photo, .branch-options button');
  for (const selector of ['.answer-fab', '.chapter-end', '.yoi-completion']) animateSurface(document.querySelector(selector), true, 8);
  return pageTurnOpened;
}

function scrollConversationToEnd(force = false) {
  requestAnimationFrame(() => {
    if (historyView || composerExpanded) return;
    if (!force && (!followChat || chatIsBeingHandled())) return;
    const chat = document.querySelector('.chat-area');
    if (chat && chat.scrollHeight > chat.clientHeight) {
      chat.scrollTo({ top: chat.scrollHeight - chat.clientHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  });
}

function conversationMessages(messages) {
  return messages.filter(isConversationLine);
}

const preloadedSceneSources = new Set();

function preloadSceneImages(scene = []) {
  if (typeof Image === 'undefined' || !scene.length) return;
  const sources = new Set(scene.map(line => scenario.portraits[line.speaker]).filter(Boolean));
  const preview = current().travelGuide?.steps[0]?.preview;
  if (preview) sources.add(preview);
  for (const src of sources) {
    if (preloadedSceneSources.has(src)) continue;
    preloadedSceneSources.add(src);
    const image = new Image();
    image.src = src;
    image.decode().catch(() => preloadedSceneSources.delete(src));
  }
}

function playConversation(start, { fromCorrectAnswer = false } = {}) {
  answerOrigin = null;
  startView = false;
  yoiEndView = false;
  resetChatFollow();
  sceneStart = start;
  displayedMessages = [];
  isPlaying = true;
  composerExpanded = false;
  menuExpanded = false;
  problemMenuExpanded = false;
  const scene = conversationMessages(state.messages.slice(sceneStart).filter(m => m.problemId === state.selected));
  preloadSceneImages(scene);
  novelPlayback = usesNovelBubbles(scene);
  if (novelPlayback) {
    advanceNovel(scene);
    if (fromCorrectAnswer && !reducedMotion()) {
      document.querySelector('.novel-bubble')?.animate?.([
        { boxShadow: '0 4px 18px #31261635, 0 0 0 2px #eaaa6c70', translate: '0 5px' },
        { boxShadow: '0 4px 18px #31261635, 0 0 0 8px #eaaa6c00', translate: '0 0' },
      ], { duration: 340, easing: MOTION.ease });
    }
  } else {
    render();
    document.querySelector('.chat-area').scrollTop = 0;
    conversationPlayer.play(scene, { immediate: fromCorrectAnswer });
  }
}

function isSceneNotice(message) {
  if (message.speaker) return false;
  if (/^(?:指示[：:]|伝達[：:]|※会場でプレイされている方へ|追加カード\d+を取得)/.test(message.text)
    || normalizePageTurnText(message.text) === '冊子の次のページをめくろう') return true;
  const problem = scenario.problems.find(p => p.id === message.problemId);
  return Boolean(problem?.dialogue.some(line => line.travelGuidePart && line.text === message.text));
}

function usesNovelBubbles(scene) {
  return scene.some(line => line.speaker || (isInvestigation() || current().completionScreen === 'booklet') && line.kind === 'dialogue' && !isSceneNotice(line));
}

function advanceNovel(remaining = pendingConversation(state, { isPlaying, sceneStart, displayedMessages })) {
  // Q3では次の台詞がなければ、最後の一言と一覧・再回答への操作を一緒に表示する。
  const lastInvestigationLine = isInvestigation() && current().autoOpenContinuation !== 'after-dialogue'
    && remaining.length === 1 && !isSceneNotice(remaining[0])
    && !current().instruction && !displayedMessages.some(isSceneNotice);
  if (remaining.every(isSceneNotice) || lastInvestigationLine) {
    displayedMessages.push(...remaining);
    const pageTurnOpened = finishConversation({ scroll: false });
    document.querySelector('.chat-area').scrollTop = 0;
    if (pageTurnOpened || openAutomaticContinuation()) return;
    const continuation = document.querySelector('.novel-bubble[data-action="investigation-closing"]') ?? document.querySelector('.branch-options button, .answer-fab:not([aria-expanded="true"]):not([hidden]), .investigation-return');
    continuation?.focus({ preventScroll: true });
    return;
  }
  const previous = displayedMessages.at(-1);
  const line = remaining[0];
  displayedMessages.push(line);
  const bubble = previous && document.querySelector('[data-action="novel-next"]');
  if (bubble) {
    updateNovelBubble(bubble, line);
    save();
  } else {
    render();
    revealNovelContent(document.querySelector('.novel-line'));
    if (historyView) document.querySelector('#history-heading')?.focus({ preventScroll: true });
    else if (!panel.open) document.querySelector('[data-action="novel-next"]')?.focus({ preventScroll: true });
  }
  document.querySelector('.chat-area').scrollTop = 0;
}

function novelPortraitMarkup(speaker) {
  if (!speaker) return '';
  const portrait = scenario.portraits[speaker];
  return `<div class="novel-portrait">${portrait ? `<img src="${esc(portrait)}" alt="">` : ''}<span class="novel-speaker">${esc(speaker)}</span></div>`;
}

// 保存済みの台詞も表示時に直し、再生位置の照合には元の本文を使う。
function dialogueDisplayText(line) {
  if (line.problemId === 'Q8') return line.text.replace(/^▶\s*/u, '');
  if (['Q3', 'Q3.3'].includes(line.problemId) && line.kind === 'dialogue') {
    const dialogue = scenario.problems.find(p => p.id === line.problemId).dialogue;
    return dialogue.find(currentLine => currentLine.previousText === line.text)?.text ?? line.text;
  }
  if (line.problemId !== 'N5.5' || line.kind !== 'dialogue') return line.text;
  return line.text.replace('子供からもらった', '子供から貰った')
    .replace('一本の線でつながり', '1本の線でつながり').replace('1つの恐ろしい仮説', '恐ろしい仮説');
}

function novelBubbleContent(line, canAdvance = isPlaying) {
  const remaining = isPlaying ? pendingConversation(state, { isPlaying, sceneStart, displayedMessages }) : [];
  const travelNext = current().travelGuide && remaining.length && remaining.every(isSceneNotice);
  return `${canAdvance && line.speaker ? `<span class="sr-only">${esc(line.speaker)}</span>` : ''}
      <span class="novel-line">${esc(dialogueDisplayText(line))}</span>
      ${canAdvance ? `<span class="novel-next">${travelNext ? '移動案内へ' : '<span aria-hidden="true">▷</span><span class="sr-only">読み進める</span>'}</span>` : ''}`;
}

// Keep the bubble opaque while its new text settles into place.
function revealNovelContent(element) {
  if (!element || reducedMotion()) return;
  element.animate?.([{ opacity: .78, translate: '0 3px' }, { opacity: 1, translate: '0 0' }], {
    duration: MOTION.state, easing: MOTION.ease,
  });
}

function updateNovelBubble(bubble, line) {
  const stage = bubble.parentElement;
  const outgoing = stage.querySelector('.novel-portrait:not(.portrait-leaving)');
  const speaker = line.speaker || '';
  if ((outgoing?.querySelector('.novel-speaker').textContent || '') !== speaker) {
    stage.querySelector('.portrait-leaving')?.remove();
    let incomingOpacity = .78;
    if (outgoing && !reducedMotion()) {
      const opacity = Number(getComputedStyle(outgoing).opacity);
      incomingOpacity = 1 - opacity;
      outgoing.getAnimations().forEach(animation => animation.cancel());
      outgoing.classList.toggle('was-right', stage.classList.contains('novel-right'));
      outgoing.classList.add('portrait-leaving');
      outgoing.setAttribute('aria-hidden', 'true');
      const exit = outgoing.animate([{ opacity }, { opacity: 0 }], {
        duration: MOTION.state, easing: MOTION.ease, fill: 'forwards',
      });
      exit.finished.then(() => outgoing.remove(), () => outgoing.remove());
    } else outgoing?.remove();
    stage.classList.toggle('novel-right', speaker === 'タツ');
    if (speaker) {
      bubble.insertAdjacentHTML('beforebegin', novelPortraitMarkup(speaker));
      if (!reducedMotion()) bubble.previousElementSibling.animate([
        { opacity: incomingOpacity }, { opacity: 1 },
      ], { duration: MOTION.state, easing: MOTION.ease });
    }
  }
  const previousHeight = bubble.getBoundingClientRect().height;
  bubble.getAnimations().find(animation => animation.id === 'novel-height')?.cancel();
  bubble.innerHTML = novelBubbleContent(line);
  if (reducedMotion()) return;
  const height = bubble.getBoundingClientRect().height;
  if (Math.abs(height - previousHeight) >= 1) {
    bubble.animate([{ height: `${previousHeight}px` }, { height: `${height}px` }], {
      id: 'novel-height', duration: MOTION.enter, easing: MOTION.ease,
    });
  }
  revealNovelContent(bubble.querySelector('.novel-line'));
}

function awaitingYoiPageTurn() {
  return current().completionScreen === 'yoi' && state.solved.includes(current().id)
    && !isPlaying && !startView && !repeatAnswer && !yoiEndView;
}

function novelSceneMarkup(line) {
  const action = isPlaying ? 'novel-next' : canReadInvestigationClosing() ? 'investigation-closing' : awaitingYoiPageTurn() ? 'yoi-page-turn'
    : current().completionScreen === 'booklet' && showsGuideStop(current()) ? 'travel-next' : '';
  const tag = action ? 'button' : 'article';
  return `<div class="novel-stage${line.speaker === 'タツ' ? ' novel-right' : ''}">
    ${novelPortraitMarkup(line.speaker)}
    <${tag} class="novel-bubble"${action ? ` type="button" data-action="${action}" aria-live="polite" aria-atomic="true"` : ''}>${novelBubbleContent(line, Boolean(action))}</${tag}>
  </div>`;
}

const icons = {
  menu: '<path class="menu-line menu-line-top" d="M4 6h16"/><path class="menu-line menu-line-middle" d="M4 12h16"/><path class="menu-line menu-line-bottom" d="M4 18h16"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5H8l-5 2 1.8-5A8.5 8.5 0 1 1 21 11.5Z"/>',
  hint: '<path d="M9 18h6m-5 4h4M8 14a6 6 0 1 1 8 0l-1 2H9Z"/>',
  cards: '<rect x="3" y="3" width="13" height="16" rx="2" transform="rotate(-12 9.5 11)"/><rect x="9" y="6" width="13" height="16" rx="2" fill="var(--white)"/><path d="M12 11h7m-7 4h5"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8m1-5v6l4 2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15"/>',
  send: '<path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>',
  edit: '<path d="m16 5 3 3M4 20l4.2-.8L20 7.4 16.6 4 4.8 15.8 4 20Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  reset: '<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8"/>',
  numberTicket: '<path d="M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V6Z"/><path d="m10 8-1 8m6-8-1 8m-6-5h9m-9 3h9"/>',
  warning: '<path d="m12 3 10 17H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  home: '<path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  'question-circle': '<circle cx="12" cy="12" r="8"/>',
  'question-cross': '<path d="m6 6 12 12M18 6 6 18"/>',
  'question-triangle': '<path d="M12 4 21 20H3Z"/>',
  'question-square': '<rect x="4" y="4" width="16" height="16"/>',

};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] ?? ''}</svg>`;
const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const current = () => scenario.problems.find(p => p.id === state.selected);
const followingProblem = p => {
  if (p.standalone) return undefined;
  if (isInvestigation(p.id)) return scenario.problems.find(item => item.id === p.continueTo);
  const next = scenario.problems[scenario.problems.indexOf(p) + 1];
  return next?.standalone ? undefined : next;
};
const isInvestigation = (id = state.selected) => scenario.investigation.problemIds.includes(id);
const problemLabel = problem => problem.displayId ?? (isInvestigation(problem.id) && problem.listSymbol ? `${scenario.investigation.id} ${problem.listSymbol}` : problem.id);
const problemTitle = problem => isInvestigation(problem.id) && problem.title === problem.id ? problem.listPrompt ?? problem.prompt : problem.title;

function canReadInvestigationClosing() {
  return !investigationView && !startView && !isPlaying && !composerExpanded && !repeatAnswer
    && isInvestigation() && !current().continueTo && state.solved.includes(state.selected)
    && displayedMessages.at(-1)?.problemId === state.selected;
}

function investigationClosingMarkup() {
  const lastSolved = state.solved.filter(isInvestigation).at(-1);
  const last = investigationComplete(scenario, state) && lastSolved === state.selected;
  return `<section class="investigation-closing" aria-label="捜査の振り返り">
    <button type="button" data-action="investigation-back">
      <span class="investigation-closing-text">${esc(scenario.investigation.closing[last ? 'last' : 'more'])}</span>
      <span class="investigation-closing-back">問題一覧へ戻る</span>
    </button>
  </section>`;
}

function showInvestigation() {
  investigationClosing = false;
  answerOrigin = null;
  const previousSolved = investigationSnapshot;
  rememberAnswerDraft();
  conversationPlayer.stop(); isPlaying = false;
  startView = yoiEndView = repeatAnswer = composerExpanded = menuExpanded = problemMenuExpanded = false;
  investigationView = true;
  state = { ...state, selected: scenario.investigation.id };
  displayedMessages = [];
  const complete = scenario.investigation.entries.filter(id => investigationEntryStatus(id, state.solved) === 2);
  const peelingConclusions = complete.filter(id => !seenConclusions.includes(id));
  seenConclusions = complete;
  resetChatFollow();
  render({ peelingConclusions });
  document.querySelector('.chat-area').scrollTop = investigationScrollTop;
  document.querySelector(`[data-action="investigation-open"][data-id="${investigationReturnId}"]`)?.focus({ preventScroll: true });
  if (peelingConclusions.length) {
    document.querySelector(`[data-conclusion="${peelingConclusions[0]}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }
  animateSurface(document.querySelector('.investigation-intro'), true, 8);
  if (!reducedMotion()) {
    document.querySelectorAll('.investigation-question').forEach((note, index) => {
      note.animate?.([
        { opacity: .5, transform: 'translateY(-6px) rotate(-2deg)' },
        { opacity: 1, transform: 'translateY(1px) rotate(.4deg)', offset: .72 },
        { transform: 'none' },
      ], { duration: 300, delay: index * 35, easing: MOTION.ease, fill: 'backwards' });
    });
  }
  animateSurface(document.querySelector('.investigation-next'), true, 8);
  if (previousSolved) {
    const changed = scenario.investigation.entries.filter(id => investigationEntryStatus(id, previousSolved) !== investigationEntryStatus(id, state.solved));
    for (const id of changed) animateEmphasis(document.querySelector(`[data-action="investigation-open"][data-id="${id}"] .investigation-status`), reducedMotion());
    const previousCount = answeredInvestigationCount(previousSolved);
    const currentCount = answeredInvestigationCount(state.solved);
    if (currentCount > previousCount && !reducedMotion()) {
      const sector = 360 / scenario.investigation.entries.length;
      document.querySelector('.investigation-progress')?.animate?.([
        { '--answered-angle': `${previousCount * sector}deg` },
        { '--answered-angle': `${currentCount * sector}deg` },
      ], { duration: 750, easing: 'ease-in-out' });
    }
    if (!scenario.investigation.problemIds.every(id => previousSolved.includes(id)) && investigationComplete(scenario, state)) animateEmphasis(document.querySelector('.investigation-next'), reducedMotion());
  }
  investigationSnapshot = [...state.solved];
}

function answeredInvestigationCount(solved) {
  return scenario.investigation.entries.filter(id => solved.includes(id)).length;
}

function investigationEntryStatus(id, solved) {
  const p = scenario.problems.find(item => item.id === id);
  return !solved.includes(id) ? 0 : p.continueTo && !solved.includes(p.continueTo) ? 1 : 2;
}

function openAutomaticContinuation() {
  const p = current();
  if (!p.autoOpenContinuation || !state.solved.includes(p.id) || repeatAnswer) return false;
  if (state.solved.includes(p.continueTo) && !p.reopenSolvedContinuation) return false;
  composerExpanded = true;
  selectProblem(p.continueTo, { openOverScene: true, answering: true, investigationDetail: true });
  return true;
}

function openInvestigationProblem(id) {
  if (!isInvestigation(id)) return;
  haptics.trigger('paper');
  if (investigationView) investigationScrollTop = document.querySelector('.chat-area').scrollTop;
  investigationReturnId = scenario.problems.find(p => p.continueTo === id)?.id ?? id;
  const entry = scenario.problems.find(p => p.id === id);
  if (entry.autoOpenContinuation && state.solved.includes(entry.continueTo)) id = entry.continueTo;
  composerExpanded = !state.solved.includes(id);
  selectProblem(id, { answering: !state.solved.includes(id), investigationDetail: true });
  openAutomaticContinuation();
}

function questionSymbolMarkup(p) {
  const shapes = {
    '〇': 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 1 1 0-17Z',
    '△': 'M12 3 22 21H2Z',
    '□': 'M4 4H20V20H4Z',
  };
  const shape = shapes[p.listSymbol];
  const gradientId = `question-pin-${p.id}`;
  return shape ? `<span class="question-symbol" role="img" aria-label="${esc(p.listSymbol)}"><svg viewBox="0 0 24 26" aria-hidden="true"><defs><linearGradient id="${esc(gradientId)}" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="#f2b0a0"/><stop offset=".28" stop-color="#d7715c"/><stop offset=".6" stop-color="#b44234"/><stop offset="1" stop-color="#7d2b26"/></linearGradient></defs><path d="${shape}" transform="translate(0 1.5)" fill="#682a23" stroke="#682a23" stroke-width=".8" stroke-linejoin="round"/><path d="${shape}" fill="url(#${esc(gradientId)})" stroke="#963c30" stroke-width=".6" stroke-linejoin="round"/></svg></span>` : '';
}

function problemPromptMarkup(p) {
  const text = p.promptEmphasis
    ? String(p.prompt).split(p.promptEmphasis).map(esc).join(`<strong>${esc(p.promptEmphasis)}</strong>`)
    : esc(p.prompt);
  return text;
}

function conclusionMarkup(p, peeling) {
  const revealed = investigationEntryStatus(p.id, state.solved) === 2;
  const label = p.listSymbol === '〇' ? '○' : p.listSymbol;
  const seal = !revealed || peeling
    ? `<span class="conclusion-seal${peeling ? ' is-peeling' : ''}" aria-hidden="true">？</span>` : '';
  return `<div class="conclusion-row" data-conclusion="${esc(p.id)}"><dt>${esc(label)}の結論：</dt>
    <dd>${revealed ? esc(p.conclusion) : '<span class="sr-only">未解決</span>'}${seal}</dd></div>`;
}

function investigationMarkup(peelingConclusions = []) {
  const entries = scenario.investigation.entries.map(id => scenario.problems.find(p => p.id === id));
  const notes = entries.map(p => {
    const answered = state.solved.includes(p.id);
    const solved = investigationEntryStatus(p.id, state.solved) === 2;
    const continuation = answered && !solved ? '<span class="investigation-status">続きの謎あり</span>' : '';
    return `<button class="investigation-question" data-solved="${solved}" data-answered="${answered}" data-action="investigation-open" data-id="${esc(p.id)}">${questionSymbolMarkup(p)}<span class="investigation-stamp">${answered ? '回答済み' : '未回答'}</span>${continuation}<strong><span class="investigation-question-text">${esc(p.listPrompt)}</span></strong></button>`;
  });
  const answeredCount = answeredInvestigationCount(state.solved);
  const progress = `<span class="investigation-progress" role="meter" aria-label="Q3の回答状況" aria-valuemin="0" aria-valuemax="${entries.length}" aria-valuenow="${answeredCount}" aria-valuetext="${entries.length}問中${answeredCount}問回答済み" style="--answered-angle: ${360 * answeredCount / entries.length}deg"></span>`;
  return `<div class="investigation-intro"><h1>残された違和感</h1><p>気になる問いをタップして、好きな順番で考えよう。</p>${progress}</div><div class="investigation-questions">${notes.join('')}</div><div class="conclusion-mount"><dl class="investigation-conclusions" aria-label="捜査の結論">${entries.map(p => conclusionMarkup(p, peelingConclusions.includes(p.id))).join('')}</dl></div>`;
}

function navigationProblems() {
  if (playSaves?.getStatus().mode !== 'debug') return availableNavigationProblems(scenario, state);
  return scenario.problems.filter(p => !isInvestigation(p.id) || p.id === scenario.investigation.id);
}
const surfaceAnimations = new WeakMap();
let puzzleSubmitObserver;
let puzzleImageLoadCleanup;

function bindPuzzleSubmitLayout() {
  puzzleSubmitObserver?.disconnect();
  puzzleImageLoadCleanup?.();
  const card = document.querySelector('.start-puzzle-card');
  if (!card) return;
  // コンパクト配置は回答を独立した全幅の行に置くため、画像下への移動は不要。
  if (card.dataset?.answerLayout === 'compact') return;
  const field = card.querySelector('.text-composer, .answer-choice-trigger, .symbol-slot-fields, .answer-options .option:last-of-type');
  const visual = card.querySelector('.puzzle-visual');
  const image = card.querySelector('.puzzle-diagram-image');
  if (!field || !visual || !image) return;
  function update() {
    if (!card.isConnected) return;
    const cardRect = card.getBoundingClientRect();
    if (!cardRect.width) return;
    const fieldRect = field.getBoundingClientRect();
    const visualRect = visual.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(card).columnGap) || 0;
    // 図の下に回答欄と同じ高さの行を確保できるときだけ、送信を右列へ置く。
    const beside = image.complete && image.naturalWidth > 0 && visualRect.bottom + gap <= fieldRect.top && visualRect.width >= 80;
    if (beside) {
      card.style.setProperty('--submit-top', `${fieldRect.top - cardRect.top}px`);
      card.style.setProperty('--submit-left', `${visualRect.left - cardRect.left}px`);
      card.style.setProperty('--submit-width', `${visualRect.width}px`);
      card.style.setProperty('--submit-height', `${fieldRect.height}px`);
      card.style.setProperty('--answer-row-width', `${visualRect.right - fieldRect.left}px`);
    }
    card.classList.toggle('has-side-submit', beside);
  }
  if (typeof ResizeObserver !== 'undefined') {
    puzzleSubmitObserver = new ResizeObserver(update);
    for (const element of [card, field, visual, card.querySelector('.puzzle-card-copy')]) puzzleSubmitObserver.observe(element);
  }
  image.addEventListener('load', update);
  puzzleImageLoadCleanup = () => image.removeEventListener('load', update);
  requestAnimationFrame(update);
}

function animateSurface(element, opening, offset = 20, axis = 'Y', duration = null) {
  if (!element) return Promise.resolve(false);
  const previous = surfaceAnimations.get(element);
  const currentStyle = previous || !opening ? getComputedStyle(element) : null;
  const interruptedFrame = currentStyle ? { opacity: currentStyle.opacity, transform: currentStyle.transform } : null;
  previous?.cancel();
  surfaceAnimations.delete(element);
  if (!element.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(true);
  const hiddenFrame = { opacity: 0, transform: `translate${axis}(${typeof offset === 'number' ? `${offset}px` : offset})` };
  const visibleFrame = { opacity: 1, transform: `translate${axis}(0)` };
  const animation = element.animate([interruptedFrame ?? (opening ? hiddenFrame : visibleFrame), opening ? visibleFrame : hiddenFrame], {
    duration: duration ?? (opening ? MOTION.enter : MOTION.exit), easing: MOTION.ease, fill: 'both',
  });
  surfaceAnimations.set(element, animation);
  return animation.finished.then(() => {
    if (surfaceAnimations.get(element) !== animation) return false;
    surfaceAnimations.delete(element);
    animation.cancel();
    return true;
  }).catch(() => false);
}

function revealItems(selector, root = document) {
  if (reducedMotion()) return;
  root.querySelectorAll(selector).forEach((item, index) => {
    item.animate?.([
      { opacity: .25, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: MOTION.enter, delay: Math.min(index, 4) * 35, easing: MOTION.ease, fill: 'backwards' });
  });
}

// 文字による正解通知を挟まず、短い間とフェードで次の小問を見せる。
function animateQuestionAdvance(composer) {
  if (!composer?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  questionAdvanceAnimation?.cancel();
  surfaceAnimations.get(composer)?.cancel();
  const animation = composer.animate([
    { opacity: 0, transform: 'translateY(10px)', offset: 0 },
    { opacity: 0, transform: 'translateY(10px)', offset: .4 },
    { opacity: 1, transform: 'translateY(0)', offset: 1 },
  ], { duration: 600, easing: MOTION.ease, fill: 'both' });
  questionAdvanceAnimation = animation;
  surfaceAnimations.set(composer, animation);
  composer.inert = true;
  void animation.finished.catch(() => {}).finally(() => {
    composer.inert = false;
    if (questionAdvanceAnimation === animation) questionAdvanceAnimation = null;
    if (surfaceAnimations.get(composer) === animation) {
      surfaceAnimations.delete(composer);
      animation.cancel();
    }
  });
}

function animateComposerHeight(composer, previousHeight) {
  composerHeightAnimation?.cancel();
  if (!composer || composer.hidden || !previousHeight || !composer.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const height = composer.getBoundingClientRect().height;
  if (Math.abs(height - previousHeight) < 2) return;
  composerHeightAnimation = composer.animate([{ height: `${previousHeight}px`, overflow: 'hidden' }, { height: `${height}px`, overflow: 'hidden' }], { duration: MOTION.enter, easing: MOTION.ease });
}

function answerControls(form) {
  return [...form.elements].filter(field => field.name === 'answer');
}

function rememberAnswerDraft() {
  const form = document.querySelector('#answer-form');
  const composer = document.querySelector('.composer-area');
  if (!form?.elements || composer?.hidden || composer?.inert || isPlaying) return;
  const p = scenario.problems.find(item => item.id === form.dataset.problemId);
  if (!p || state.solved.includes(p.id) && !repeatAnswer && !startView) return;
  const controls = answerControls(form);
  let values;
  if (p.answerSlots) values = selectedSymbols;
  else if (p.id === 'N1') values = [selectedPuzzleAnswer];
  else if (p.type === 'fields') {
    let offset = 0;
    values = p.fields.map(field => {
      const group = controls.slice(offset, offset += field.options?.length ?? 1);
      return field.options ? group.find(control => control.checked)?.value ?? '' : group[0]?.value ?? '';
    });
  } else values = controls.filter(field => !['radio', 'checkbox'].includes(field.type) || field.checked).map(field => field.value);
  const draft = sanitizeAnswerDraft(p, values);
  if (draft.some(Boolean)) answerDrafts[p.id] = draft;
  else delete answerDrafts[p.id];
}

function restoreAnswerDraft(form, p) {
  const draft = answerDrafts[p.id];
  if (!draft) return;
  const controls = answerControls(form);
  if (p.type === 'fields') {
    let offset = 0;
    p.fields.forEach((field, index) => {
      const group = controls.slice(offset, offset += field.options?.length ?? 1);
      for (const control of group) {
        if (field.options) control.checked = control.value === draft[index];
        else control.value = draft[index] ?? '';
      }
    });
  } else if (p.type === 'multiple' || p.type === 'single' && p.id !== 'N1' && p.answerControl !== 'select') {
    for (const control of controls) control.checked = draft.includes(control.value);
  } else if (!p.answerSlots && p.id !== 'N1' && controls[0]) controls[0].value = draft[0] ?? '';
}

function prepareAnswerForm() {
  const form = document.querySelector('#answer-form');
  if (!form?.elements) return;
  if (composerExpanded) preloadSceneImages(current().dialogue);
  form.noValidate = true;
  form.dataset.problemId = current().id;
  restoreAnswerDraft(form, current());
  const fields = [...form.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), select')];
  fields.forEach((field, index) => {
    if (field.tagName === 'INPUT') field.maxLength = 256;
    field.enterKeyHint = index < fields.length - 1 ? 'next' : 'send';
  });
  for (const field of form.querySelectorAll('input, select, .answer-choice-trigger, .symbol-slot-button, button[type="submit"]')) field.setAttribute('aria-describedby', 'answer-readiness answer-error');
  updateAnswerReadiness();
}

function updateAnswerReadiness({ highlight = false, feedback: showFeedback = false } = {}) {
  const form = document.querySelector('#answer-form');
  if (!form?.elements) return true;
  const problem = current();
  const raw = problem.answerSlots ? selectedSymbols : [...new FormData(form).getAll('answer')];
  const result = answerReadiness(problem, raw);
  const multiPart = problem.type === 'fields' || Boolean(problem.answerSlots) || problem.type === 'multiple';
  const becameReady = form.dataset.ready === 'false' && result.ready && multiPart;
  if (!composingAnswer) form.dataset.ready = String(result.ready);
  form.classList.toggle('answer-is-ready', multiPart && result.ready);
  if (showFeedback && !composingAnswer && becameReady) {
    animateEmphasis(form.querySelector('[type="submit"]'), reducedMotion());
    haptics.trigger('ready');
  }
  const hint = document.querySelector('#answer-readiness');
  if (hint) hint.textContent = multiPart && result.ready ? '入力・選択がそろいました。送信できます。' : result.message;
  form.classList.toggle('needs-completion', highlight && !result.ready);
  form.querySelectorAll('.needs-answer').forEach(field => field.classList.remove('needs-answer'));
  if (highlight && !result.ready) {
    const empty = [...form.querySelectorAll('input:not([type="hidden"]), select')].filter(field => field.type === 'radio' || field.type === 'checkbox' ? !form.querySelector('input:checked') : !field.value.trim());
    for (const field of empty) {
      (field.closest('.answer-field, .answer-options, .text-composer') ?? field).classList.add('needs-answer');
      field.setAttribute('aria-invalid', 'true');
    }
    for (const field of form.querySelectorAll('.symbol-slot-button[data-filled="false"], .answer-choice-trigger')) {
      if (field.dataset.filled === 'false' || !selectedPuzzleAnswer) field.classList.add('needs-answer');
    }
    (form.querySelector('.needs-answer input, .needs-answer select, button.needs-answer') ?? empty[0])?.focus({ preventScroll: true });
    viewportLayout.schedule();
  }
  return result.ready;
}

function setMenuExpanded(expanded) {
  if (expanded) setProblemMenuExpanded(false);
  if (menuExpanded === expanded) return;
  menuExpanded = expanded;
  syncNavigation();
  const menu = document.querySelector('#navigation-menu');
  document.querySelector('.menu-button')?.setAttribute('aria-expanded', String(expanded));
  if (!menu) return;
  menu.hidden = false;
  menu.inert = !expanded;
  animateSurface(menu, expanded, -8).then(finished => {
    if (finished && !menuExpanded && menu.isConnected) menu.hidden = true;
  });
}

function closeAnswerArea() {
  if (!startView && (current().conversationBackground === 'investigation' || !answerOrigin && isInvestigation())) { showInvestigation(); return; }
  setComposerExpanded(false);
}

function setComposerExpanded(expanded) {
  rememberAnswerDraft();
  if (composerExpanded === expanded) return;
  composerExpanded = expanded;
  if (!expanded && answerOrigin) {
    answerOrigin.answerId = state.selected;
    state = { ...state, selected: answerOrigin.problemId };
    repeatAnswer = answerOrigin.repeatAnswer;
    updateProblemNavigation();
    document.querySelector('.chat-area').scrollTop = answerOrigin.scrollTop;
    const gallery = document.querySelector('.chat-area .travel-guide-gallery');
    if (gallery) gallery.scrollLeft = answerOrigin.scrollLeft;
  }
  syncNavigation();
  save();
  if (current().answerPresentation === 'page') {
    render();
    animateSurface(document.querySelector(expanded ? '.composer-area' : '.chat-area'), true, 8);
    document.querySelector(expanded ? '.composer-area' : '.answer-fab')?.focus({ preventScroll: true });
    return;
  }
  const composer = document.querySelector('.composer-area');
  const fab = document.querySelector('.answer-fab');
  if (!composer || !fab) return;
  const focusWasInside = composer.contains(document.activeElement);
  composer.hidden = false;
  composer.inert = !expanded;
  viewportLayout.schedule();
  if (expanded) composer.focus({ preventScroll: true });
  fab.disabled = expanded;
  if (fab.dataset?.action !== 'travel-next') fab.setAttribute('aria-expanded', String(expanded));
  animateSurface(composer, expanded, 0).then(finished => {
    if (finished && !composerExpanded && composer.isConnected) composer.hidden = true;
  });
  if (!expanded && focusWasInside) fab.focus({ preventScroll: true });
}

function closePanel() {
  if (!panel.open || panel.classList.contains('is-closing')) return;
  miniView?.destroy();miniView=null;
  if (panel.classList.contains('clue-gallery') && expandedCharacter !== null) {
    closeCharacterPreview();
    return;
  }
  if (panel.dataset?.kind === 'travel-image' && imageReturnElement?.dataset.id === 'trouble') {
    const index = imageReturnElement.dataset.index;
    openPanel('trouble');
    const details = panel.querySelector('.trouble-photos');
    if (details) details.open = true;
    panel.querySelector(`[data-index="${index}"]`)?.focus();
    return;
  }
  const resumeSheet = panel.classList.contains('resume-sheet');
  if (resumeSheet && gateBusy) return;
  panelRevision++;
  if (resumeSheet) gateInput = false;
  const returnSlot = panel.classList.contains('symbol-choice-dialog') ? activeSymbolSlot : null;
  const closingImageViewer = imageViewer;
  const imageOrigin = panel.dataset?.kind === 'puzzle-image' ? document.querySelector('.puzzle-preview') : imageReturnElement;
  const returnRect = imageOrigin?.isConnected && imageOrigin.getClientRects?.().length
    ? imageOrigin.getBoundingClientRect() : null;
  const imageExit = closingImageViewer?.dismissTo(returnRect);
  imageViewer = null;
  sheetDismiss?.dispose({ preservePosition: true }); sheetDismiss = null;
  panel.classList.add('is-closing');
  panel.inert = true;
  syncNavigation();
  const clueScreen = panel.classList.contains('clue-gallery');
  const exitTarget = clueScreen ? panel.querySelector('.clue-screen-content') ?? panel : panel;
  const exit = animateSurface(exitTarget, false, clueScreen || closingImageViewer ? 0 : panel.classList.contains('draggable-sheet') ? '100%' : 24, 'Y', clueScreen ? MOTION.state : imageExit ? MOTION.enter : null);
  const completion = imageExit ? Promise.all([exit, imageExit]).then(([finished]) => finished) : exit;
  return completion.then(finished => {
    closingImageViewer?.dispose();
    if (!finished) return;
    const outsideFocus = document.activeElement && document.activeElement !== document.body && !panel.contains?.(document.activeElement) ? document.activeElement : null;
    panel.style?.removeProperty('transform');
    panel.close();
    panel.classList.remove('is-closing');
    panel.inert = false;
    const available = element => element?.isConnected && !element.closest?.('[hidden], [inert]') && (!element.getClientRects || element.getClientRects().length > 0);
    const actionTarget = panelReturnAction ? document.querySelector(`[data-action="${panelReturnAction}"]`) : null;
    const returnTarget = available(outsideFocus) ? outsideFocus : available(panelReturnFocus) ? panelReturnFocus : available(actionTarget) ? actionTarget : document.querySelector('.composer-area:not([hidden])') ?? document.querySelector('.menu-button');
    returnTarget?.focus?.({ preventScroll: true });
    if (!outsideFocus && returnSlot !== null) document.querySelector(`#symbol-slot-${returnSlot}`)?.focus({ preventScroll: true });
    if (resumeSheet && gateVisible) document.querySelector('[data-action="save-continue"]')?.focus({ preventScroll: true });
    syncNavigation();
  });
}

function capturePlayView() {
  return { startView, yoiEndView, showVenueDirections, investigationView, ...(investigationClosing ? { investigationClosing: true } : {}), investigationScrollTop, investigationReturnId,
    ...(scenario.investigation.entries.some(id => investigationEntryStatus(id, state.solved) === 2) ? { seenConclusions: [...seenConclusions] } : {}),
    repeatAnswer, composerExpanded, ...(answerOrigin ? { answerOrigin: { ...answerOrigin } } : {}), sceneStart, displayedMessages: [...displayedMessages], isPlaying,
    puzzleImageIndex, chatScrollTop: historyView ? historyChatScrollTop : document.querySelector('.chat-area')?.scrollTop ?? 0,
    selectedPuzzleAnswer, selectedSymbols: [...selectedSymbols], answerDrafts: Object.fromEntries(Object.entries(answerDrafts).map(([id, values]) => [id, [...values]])) };
}

function save() {
  if (!playSaves || gateVisible || changingSession) return;
  playSaves.update(state, capturePlayView());
}

function updateSaveStatus(status) {
  storageWarning = ['offline', 'local-only', 'conflict'].includes(status.phase) ? status.message : '';
  document.querySelectorAll('[data-save-status]').forEach(node => { node.textContent = status.message; });
  const record = playSaves?.getRecord();
  document.querySelectorAll('[data-save-code]').forEach(node => { node.textContent = record?.code ?? '発行待ち'; });
  document.querySelectorAll('[data-action="save-copy"]').forEach(node => { node.disabled = !normalizePlayCode(record?.code); });
  const debug = status.mode === 'debug';
  if (!debug && record?.code && record.creationId) {
    try { browserStorage?.setItem(`${storageKey}:migrated`, '1'); } catch {}
  }
  document.querySelector('.save-status-strip')?.classList.toggle('debug-mode', debug);
  document.querySelector('.save-status-strip')?.classList.toggle('save-warning', Boolean(storageWarning));
  if (!gateVisible && !debug && record?.code && !announcedCode) {
    announcedCode = true;
    // 旧データの移行で後から番号が発行された場合も、必ず本人へ知らせる。
    if (!panel.open) openPanel('save-info', { showStartButton: startView && !state.solved.length });
  }
}

function renderEntry() {
  const entering = !document.querySelector('.title-entry');
  app.innerHTML = `<div class="shell title-shell"><main id="main" class="save-entry title-entry">
    <h1 class="sr-only">${esc(scenario.title)}</h1>
    <div class="title-art" aria-hidden="true"><img src="../assets/title-patchwork-v3.webp" alt="" width="1024" height="1536" fetchpriority="high"></div>
    <div class="title-actions">
      <button class="primary-button full title-new" data-action="save-new" ${gateBusy ? 'disabled' : ''}>${gateBusy ? '読み込み中…' : 'はじめから'}</button>
      <button class="secondary-button full title-continue" data-action="save-continue" ${gateBusy ? 'disabled' : ''}>続きから</button>
      ${!gateInput ? `<p class="save-entry-error" role="alert">${esc(gateError)}</p>` : ''}
    </div></main></div>`;
  if (entering) animateSurface(document.querySelector('.title-actions'), true, 12);
  if (gateInput) openPanel('resume');
  syncNavigation();
}

function renderResumeLoading() {
  app.innerHTML = `<div class="shell"><main id="main" class="resume-loading" role="status" aria-live="polite" aria-busy="true"><span class="resume-loading-spinner" aria-hidden="true"></span><p>続きを開いています…</p></main></div>`;
}

function setResumeDigits(index, raw) {
  if (gateBusy) return;
  const digits = String(raw).normalize('NFKC').replace(/[^0-9]/g, '').slice(0, 6 - index);
  if (!digits) gateDigits[index] = '';
  else [...digits].forEach((digit, offset) => { gateDigits[index + offset] = digit; });
  gateCode = gateDigits.join('');
  gateError = '';
  panel.querySelectorAll('[data-resume-digit]').forEach((input, position) => {
    input.value = gateDigits[position];
    input.setAttribute('aria-invalid', 'false');
  });
  const error = panel.querySelector('#resume-error');
  if (error) error.textContent = '';
  panel.querySelector(`#resume-digit-${Math.min(index + digits.length, 5)}`)?.focus({ preventScroll: true });
  if (gateDigits.every(digit => /^[0-9]$/.test(digit))) void beginPlay('code', gateCode);
}

function enterPlay(record) {
  playSessionRevision++;
  conversationPlayer.stop();
  historyView = false;
  changingSession = true;
  state = restoreState(scenario, JSON.stringify(record.state));
  investigationSnapshot = [...state.solved];
  const savedView = state.selected === scenario.investigation.id && record.state.selected !== state.selected
    ? { investigationView: true, answerDrafts: record.view?.answerDrafts }
    : record.view;
  const view = restorePlayView(scenario, state, savedView, record.state.scenarioRevision ?? 0, record.state);
  ({ startView, yoiEndView, showVenueDirections, investigationView, investigationClosing = false, investigationScrollTop, investigationReturnId,
    repeatAnswer, composerExpanded, answerOrigin = null, sceneStart, displayedMessages, isPlaying, puzzleImageIndex,
    selectedPuzzleAnswer, selectedSymbols, answerDrafts } = view);
  // Older saves already on the board have seen its completed entries.
  const completedEntries = scenario.investigation.entries.filter(id => investigationEntryStatus(id, state.solved) === 2);
  seenConclusions = view.seenConclusions ?? completedEntries.filter(id => investigationView
    || id !== state.selected && !scenario.problems.some(p => p.id === id && p.continueTo === state.selected));
  if (!answerDrafts.N1 && selectedPuzzleAnswer && (!state.solved.includes('N1') || repeatAnswer && state.selected === 'N1')) answerDrafts.N1 = [selectedPuzzleAnswer];
  if (selectedSymbols.some(Boolean) && !answerDrafts[state.selected] && (!state.solved.includes(state.selected) || repeatAnswer)) answerDrafts[state.selected] = [...selectedSymbols];
  if (record.code !== '000000') localRecord = record;
  gateVisible = false;
  gateBusy = false;
  gateError = '';
  menuExpanded = problemMenuExpanded = false;
  selectedSymbols = [...selectedSymbols];
  feedback = '';
  resetChatFollow();
  closePanel();
  const scene = isPlaying ? conversationMessages(state.messages.slice(sceneStart).filter(m => m.problemId === state.selected)) : [];
  novelPlayback = usesNovelBubbles(scene);
  if (novelPlayback) {
    const remaining = pendingConversation(state, view);
    preloadSceneImages(remaining);
    displayedMessages = scene.slice(0, scene.length - remaining.length);
    if (!displayedMessages.length || isSceneNotice(displayedMessages.at(-1)) || (isInvestigation() && !remaining.length && current().autoOpenContinuation !== 'after-dialogue')) advanceNovel(remaining);
    else render();
  } else render();
  const chat = document.querySelector('.chat-area');
  if (chat) chat.scrollTop = view.chatScrollTop;
  const gallery = document.querySelector('.chat-area .travel-guide-gallery');
  if (answerOrigin && gallery) gallery.scrollLeft = answerOrigin.scrollLeft;
  changingSession = false;
  if (!isPlaying && !investigationView && !composerExpanded && !answerOrigin && current().autoOpenContinuation === 'after-dialogue') openAutomaticContinuation();
  if (isPlaying && !novelPlayback) conversationPlayer.play(pendingConversation(state, view));
  updateSaveStatus(playSaves.getStatus());
  if (!openFinishedPageTurn() && record.code && record.code !== '000000' && !announcedCode) {
    announcedCode = true;
    openPanel('save-info', { showStartButton: startView && !state.solved.length });
  }
}

async function transitionToPlay(record) {
  const cover = document.querySelector('.title-shell');
  const resumeSheet = panel.open && panel.classList.contains('resume-sheet');
  if (resumeSheet) {
    panel.classList.add('is-closing');
    panel.inert = true;
  }
  // 読み込み成功後に表紙と入力シートを退場させ、その後チャットを表示する。
  await Promise.all([
    animateSurface(cover, false, -12),
    resumeSheet ? animateSurface(panel, false, '100%') : Promise.resolve(),
  ]);
  if (resumeSheet) {
    panel.close();
    panel.classList.remove('is-closing');
    panel.inert = false;
  }
  gateInput = false;
  enterPlay(record);
  await animateSurface(document.querySelector('.shell'), true, 12);
  viewportLayout.update();
}

async function beginPlay(kind, code = '', { automatic = false } = {}) {
  if (gateBusy) return;
  gateBusy = true;
  gateError = '';
  if (automatic) renderResumeLoading();
  else renderEntry();
  try {
    let record;
    if (kind === 'continue') {
      record = playSaves.getRecord() ?? playSaves.readLocal();
      if (!record && legacyState) record = playSaves.adoptLegacy(legacyState, restorePlayView(scenario, legacyState, null));
      if (!record) throw new Error('このブラウザには保存された記録がありません。');
      if (record.code && !record.pending) {
        try { record = await playSaves.loadCode(record.code); }
        catch (error) { if (error.status && error.status < 500 && error.status !== 429) throw error; }
      }
      announcedCode = Boolean(record.code);
    } else if (kind === 'code') {
      const normalized = normalizePlayCode(code);
      if (!normalized) throw new Error('数字6桁の再開番号を入力してください。');
      record = normalized === '000000'
        ? playSaves.enterDebug(initialState(scenario), restorePlayView(scenario, initialState(scenario), null))
        : await playSaves.loadCode(normalized);
      announcedCode = true;
    } else {
      record = await playSaves.startNew(initialState(scenario), restorePlayView(scenario, initialState(scenario), null));
      announcedCode = false;
    }
    if (!record) throw new Error('再開番号が見つかりません。');
    if (automatic) { enterPlay(record); viewportLayout.update(); }
    else await transitionToPlay(record);
    if (requestedMinigame) {const id=requestedMinigame;requestedMinigame=null;openHexCube(id);}
    if (kind === 'continue') void playSaves.retry();
  } catch (error) {
    gateBusy = false;
    gateError = error.message || '読み込めませんでした。通信を確認して、もう一度お試しください。';
    if (gateVisible) {
      if (requestedMinigame) gateInput = true;
      renderEntry();
    }
    else openPanel('save-info');
  }
}

function travelGuideMarkup(guide, problemId) {
  const placeholder = guide.placeholder ? '<span class="travel-guide-placeholder">仮の写真</span>' : '';
  return `<div class="travel-guide-gallery" role="region" aria-label="${esc(guide.destination)}の写真、全${guide.steps.length}枚。横スクロールで確認できます" tabindex="0">${guide.steps.map((step, index) => `
    <figure class="travel-guide-photo">
      <div class="travel-guide-step"><span>${index + 1}</span>${esc(step.title)}</div>
      <button type="button" class="travel-guide-image" data-action="travel-image" data-id="${esc(problemId)}" data-index="${index}" aria-label="${esc(guide.destination)}の案内写真${index + 1}を拡大表示" aria-haspopup="dialog">
        <img src="${esc(step.preview)}" alt="${esc(step.imageAlt)}" loading="${index === 0 ? 'eager' : 'lazy'}">${placeholder}
        <span class="travel-guide-zoom" aria-hidden="true">タップして拡大</span>
      </button>
      <figcaption class="travel-guide-copy">${esc(step.directions)}</figcaption>
    </figure>`).join('')}</div>`;
}

function normalizePageTurnText(text) {
  return /^(?:冊子の)?(?:次の)?ページ(?:をめくろう|[へに](?:いこう|行こう|進もう))[。！!]?$/u.test(text)
    ? '冊子の次のページをめくろう' : text;
}

function instructionCardMarkup(text, { notice = false, warningText = '', guide = null, problemId = '' } = {}) {
  const instruction = text.replace(/^(?:指示|伝達)[：:]\s*/, '');
  if (!notice && normalizePageTurnText(instruction) === '冊子の次のページをめくろう') {
    return pageTurnCardMarkup('冊子の次のページをめくろう');
  }
  const label = notice ? 'ご案内' : '目的地に移動しよう';
  const body = esc(instruction);
  const copy = warningText ? body.replace(esc(warningText), `<strong class="message-warning">${esc(warningText)}</strong>`) : body;
  return `<article class="instruction-card${notice ? ' instruction-card-notice' : ''}" aria-label="${label}"><div class="instruction-card-heading"><span class="instruction-card-icon" aria-hidden="true">${icon(notice ? 'info' : 'map')}</span><span>${label}</span></div><p class="instruction-card-copy">${copy}</p>${guide ? travelGuideMarkup(guide, problemId) : ''}</article>`;
}

function isBookletTurn(text) {
  return normalizePageTurnText(text.replace(/^指示[：:]\s*/, '')) === '冊子の次のページをめくろう';
}

function hasStoryPageTurn(problem) {
  return problem?.chapter === '第二章' && (problem.completionScreen === 'booklet' || Boolean(followingProblem(problem)))
    && (isBookletTurn(problem.instruction) || problem.dialogue.some(line => !line.speaker && isBookletTurn(line.text)));
}

function openFinishedPageTurn() {
  let kind;
  if (awaitingYoiPageTurn()) kind = 'yoi-page-turn';
  else if (!composerExpanded && !investigationView && hasStoryPageTurn(current()) && showsGuideStop(current())) kind = 'travel-next';
  if (!kind) return false;
  openPanel(kind);
  return true;
}

function showsGuideStop(problem, repeating = repeatAnswer) {
  if (startView || isPlaying) return false;
  if (problem.id === 'Q1') return !displayedMessages.length;
  return Boolean((problem.travelGuide || hasStoryPageTurn(problem)) && state.solved.includes(problem.id) && !repeating);
}

function pageTurnCardMarkup(text = '次の問題を見つけたらページをめくろう', { action = '', buttonLabel = '', notice = '' } = {}) {
  text = normalizePageTurnText(text);
  return `<article class="instruction-card instruction-card-page-turn" aria-label="${esc(text)}"><span class="page-turn-stop" aria-hidden="true">STOP</span><p class="page-turn-text"${action ? ' id="panel-title"' : ''}>${esc(text)}</p>${notice ? `<p class="page-turn-notice">${esc(notice)}</p>` : ''}${action ? `
    <button type="button" class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button>
    <button type="button" class="primary-button" data-action="${esc(action)}">${esc(buttonLabel)}</button>` : ''}</article>`;
}

function messageMarkup(m) {
  const problem = scenario.problems.find(p => p.id === m.problemId);
  // 写真と案内は現行データから表示し、以前の保存記録にも適用する。
  const guide = problem?.travelGuide;
  const guidePart = guide && !m.speaker && problem.dialogue.find(line => line.text === m.text)?.travelGuidePart;
  if (guidePart) return '';
  // 保存済みの案内にも、現行の注意書きと赤字指定を適用する。
  if (m.problemId === 'N5' && m.kind === 'dialogue' && m.text.startsWith('伝達：以上で、構内での周遊、滞在が必須な部分は終了となります。')) {
    m = { ...m, ...scenario.problems.find(p => p.id === 'N5').dialogue.find(line => line.warningText) };
  }
  if (m.problemId === 'Q7' && m.kind === 'dialogue' && m.text.startsWith('※会場でプレイされている方へ')) {
    m = { ...m, ...scenario.problems.find(p => p.id === 'Q7').dialogue.find(line => line.text.startsWith('※会場でプレイされている方へ')) };
  }
  if (!m.speaker && /^(?:指示|伝達)[：:]/.test(m.text)) {
    const notice = /^伝達[：:]/.test(m.text);
    if (!notice && problem?.pageTurnText) return pageTurnCardMarkup(problem.pageTurnText);
    return instructionCardMarkup(m.text, { notice, warningText: m.warningText, guide: notice ? null : guide, problemId: m.problemId });
  }
  const displayText = dialogueDisplayText(m);
  const text = esc(!m.speaker ? normalizePageTurnText(displayText) : displayText);
  const formattedText = m.warningText ? text.replace(esc(m.warningText), `<strong class="message-warning">${esc(m.warningText)}</strong>`) : text;
  if (m.kind === 'success') return '';
  if (!m.speaker) return `<p class="narration">${m.emphasis ? `<strong>${formattedText}</strong>` : formattedText}</p>`;
  const own = m.kind === 'answer';
  const portrait = scenario.portraits?.[m.speaker];
  const rightSide = m.speaker === 'タツ';
  const avatar = portrait
    ? `<div class="character-speaker"><span class="avatar character-avatar" aria-hidden="true"><img src="${esc(portrait)}" alt="" width="56" height="70"></span><span class="character-name">${esc(m.speaker)}</span></div>`
    : `<span class="avatar" aria-hidden="true">${esc(Array.from(m.speaker)[0])}</span>`;
  return `<article class="message ${own ? 'own' : ''} ${m.kind === 'error' ? 'retry' : ''} ${portrait ? 'has-character' : ''} ${rightSide ? 'character-right' : ''}">${own || rightSide ? '' : avatar}<div class="message-body">${portrait ? '' : `<span class="speaker">${esc(m.speaker)}</span>`}<div class="bubble">${formattedText}</div></div>${rightSide ? avatar : ''}</article>`;
}

function answerChoiceMarkup(option) {
  return `<span class="answer-number">${esc(option.label.normalize('NFKC'))}</span>`;
}

function symbolSlotValues(p) {
  const word = p.fields?.find(field => field.kanaChoices);
  if (word) {
    const draft = answerDrafts[p.id]?.[p.fields.indexOf(word)] ?? '';
    return Array.from({ length: word.length }, (_, i) => draft.charAt(i).trim());
  }
  return Array.from({ length: p.answerSlots }, (_, i) => selectedSymbols[i] ?? '');
}

function symbolSlotButtonsMarkup(values, picker = false) {
  return values.map((value, index) => {
    return `<button id="${picker ? 'picker-' : ''}symbol-slot-${index}" type="button" class="symbol-slot-button" data-action="symbol-slot" data-index="${index}" data-filled="${Boolean(value)}" aria-label="${index + 1}文字目を選択：${esc(value || '未選択')}" aria-haspopup="dialog" aria-controls="panel"${picker ? ` aria-pressed="${index === activeSymbolSlot}"` : ''}>${esc(value || '—')}</button>`;
  }).join('');
}

function answerSelectMarkup(choices, id, placeholder) {
  const options = choices.map(choice => typeof choice === 'string' ? { id: choice, label: choice } : choice);
  return `<span class="text-composer select-composer"><select id="${esc(id)}" name="answer" required><option value="" disabled selected>${esc(placeholder)}</option>${options.map(option => `<option value="${esc(option.id)}">${esc(option.label)}</option>`).join('')}</select></span>`;
}

function answerControlMarkup(p, control, { stacked = false, disabled = false } = {}) {
  const attrs = disabled ? ' disabled' : '';
  if (p.answerSubmitLayout === 'beside-options') return `${control}<button type="submit" class="send-button" aria-label="答えを送信"${attrs}>${icon('send')}</button>`;
  return `<div class="answer-control-row${stacked ? ' answer-control-stack' : ''}">${control}<button type="submit" class="send-button" aria-label="答えを送信"${attrs}>${icon('send')}</button></div>`;
}

function answerFormMarkup(p) {
  return `<div class="answer-entry-label">回答欄</div>${answerInputsMarkup(p)}`;
}

function roomDeductionMarkup(p) {
  const word = p.fields[2];
  const draft = answerDrafts[p.id]?.[2] ?? '';
  const rooms = p.fields.slice(0, 2).map((field, index) =>
    `<label class="answer-field"><span class="sr-only">${esc(field.label)}</span>${answerSelectMarkup(field.answerChoices, `room-${index}`, field.placeholder)}</label>`).join('');
  return `<form id="answer-form" class="room-form multi-field-answer" data-fields-layout="row">
    <div class="answer-fields" role="group" aria-label="${esc(problemLabel(p))}の回答">
      ${rooms}
      <input name="answer" type="hidden" id="deduction-word" value="${esc(draft)}">
      <div class="room-word-input"><span class="answer-field-label">${esc(word.label)}（ひらがな${word.length}文字）</span>
        <div class="symbol-slot-fields" role="group" aria-label="空欄③のひらがな">${symbolSlotButtonsMarkup(symbolSlotValues(p))}</div>
      </div>
    </div>
    <button type="submit" class="send-button" aria-label="答えを送信">${icon('send')}</button>
  </form>`;
}

function answerInputsMarkup(p) {
  const label = `${problemLabel(p)}の回答`;
  if (p.answerFieldsLayout === 'rooms') return roomDeductionMarkup(p);
  if (p.type === 'fields') {
    const row = p.answerFieldsLayout === 'row';
    const inlineParts = p.answerParts && !p.answerTemplate;
    const inputs = p.fields.map((field, index) => field.answerChoices
      ? `<label class="answer-field"><span class="${p.answerParts || row ? 'sr-only' : 'answer-field-label'}">${esc(field.label)}</span>${answerSelectMarkup(field.answerChoices, `answer${index ? `-${index}` : ''}`, field.placeholder ?? '選択…')}</label>`
      : field.options
      ? `<fieldset class="answer-options answer-options-two-columns"><legend class="answer-field-label">${esc(field.label)}</legend>${field.options.map((option, optionIndex) => `<label class="option"><input id="answer-${index}-option-${optionIndex}" name="answer" type="radio" value="${esc(option.id)}" required><span>${esc(option.label)}</span></label>`).join('')}</fieldset>`
      : `<label class="answer-field"><span class="${p.answerParts || row ? 'sr-only' : 'answer-field-label'}">${esc(field.label)}</span><span class="text-composer"><input id="answer${index ? `-${index}` : ''}" name="answer" type="text" inputmode="${esc(field.inputMode ?? 'text')}" placeholder="${esc(field.placeholder)}" autocomplete="off" required></span></label>`);
    const submit = `<button type="submit" class="send-button" aria-label="答えを送信">${icon('send')}</button>`;
    if (p.answerFieldsLayout === 'pairs') {
      const pairs = [];
      for (let index = 0; index < inputs.length; index += 2) {
        pairs.push(`<div class="answer-field-pair">${inputs.slice(index, index + 2).join('')}${index + 2 >= inputs.length ? submit : ''}</div>`);
      }
      return `<form id="answer-form" class="multi-field-answer" data-fields-layout="pairs"><div class="answer-fields" role="group" aria-label="${esc(label)}">${pairs.join('')}</div></form>`;
    }
    const fields = inlineParts ? p.answerParts.map((part, index) => `${esc(part)}${inputs[index] ?? ''}`).join('') : inputs.join('');
    const group = `<div class="answer-fields${inlineParts ? ' answer-fields-inline' : ''}" role="group" aria-label="${esc(label)}">${fields}</div>`;
    const controls = row
      ? `${group}${submit}`
      : answerControlMarkup(p, group, { stacked: true });
    return `<form id="answer-form" class="multi-field-answer"${row ? ' data-fields-layout="row"' : ''}>${controls}</form>`;
  }
  if (p.answerSlots) {
    const complete = selectedSymbols.length === p.answerSlots && selectedSymbols.every(Boolean);
    const slots = `<div class="symbol-slot-fields" role="group" aria-label="${esc(label)}・${p.answerSlots}文字">${symbolSlotButtonsMarkup(symbolSlotValues(p))}</div>`;
    return `<form id="answer-form" class="puzzle-symbol-answer"><input id="answer" name="answer" type="hidden" value="${esc(selectedSymbols.join(''))}">${answerControlMarkup(p, slots, { stacked: p.answerSubmitLayout !== 'inline', disabled: !complete })}</form>`;
  }
  if (p.id === 'N1') {
    const selected = p.options.find(option => option.id === selectedPuzzleAnswer);
    const choice = `<button id="answer-choice-trigger" type="button" class="answer-choice-trigger" data-action="answer-choices" aria-haspopup="dialog" aria-controls="panel"><span id="answer-choice-label">${selected ? answerChoiceMarkup(selected) : '番号を選択'}</span></button>`;
    return `<form id="answer-form" class="puzzle-card-answer"><label class="sr-only" for="answer-choice-trigger">答えを選択</label><input id="answer" name="answer" type="hidden" value="${esc(selected?.id ?? '')}">${answerControlMarkup(p, choice)}</form>`;
  }
  if (p.answerChoices || p.answerControl === 'select') {
    const select = answerSelectMarkup(p.answerChoices ?? p.options, 'answer', p.answerPlaceholder ?? '場所を選択…');
    return `<form id="answer-form" class="puzzle-text-answer"><label class="${p.answerLabel ? 'answer-field-label' : 'sr-only'}" for="answer">${esc(p.answerLabel ?? label)}</label>${answerControlMarkup(p, select)}</form>`;
  }
  if (p.type === 'text') {
    if (p.diagram) {
      const input = `<div class="text-composer"><input id="answer" name="answer" type="text" inputmode="${esc(p.inputMode ?? 'text')}" placeholder="${esc(p.placeholder)}" autocomplete="off" required></div>`;
      return `<form id="answer-form" class="puzzle-text-answer"><label class="${p.answerLabel ? 'answer-field-label' : 'sr-only'}" for="answer">${esc(p.answerLabel ?? label)}</label>${answerControlMarkup(p, input)}</form>`;
    }
    const input = `<div class="text-composer"><input id="answer" name="answer" type="text" inputmode="${esc(p.inputMode ?? 'text')}" placeholder="${esc(p.placeholder)}" autocomplete="off" required></div>`;
    return `<form id="answer-form"${p.image ? ' class="puzzle-text-answer"' : ''}><label class="sr-only" for="answer">${esc(label)}</label>${answerControlMarkup(p, input)}</form>`;
  }
  const besideOptions = p.answerSubmitLayout === 'beside-options';
  const columns = p.type === 'multiple' ? 2 : p.optionColumns ?? 3;
  const options = `<legend class="${p.answerLabel ? 'answer-field-label' : 'sr-only'}">${esc(p.answerLabel ?? label)}</legend>${p.options.map((o, index) => `<label class="option"${besideOptions ? ` style="grid-column: ${index % columns + 1}; grid-row: ${Math.floor(index / columns) + 1}"` : ''}><input id="${o.id}" type="${p.type === 'single' ? 'radio' : 'checkbox'}" name="answer" value="${esc(o.id)}" ${p.type === 'single' ? 'required' : ''}><span>${esc(o.label)}</span></label>`).join('')}`;
  const classes = `answer-options${p.optionColumns === 2 ? ' answer-options-two-columns' : ''}`;
  if (besideOptions) return `<form id="answer-form" data-submit-layout="beside-options" style="--answer-option-columns: ${columns}; --answer-option-rows: ${Math.ceil(p.options.length / columns)}"><fieldset class="${classes}">${answerControlMarkup(p, options)}</fieldset></form>`;
  return `<form id="answer-form">${answerControlMarkup(p, `<fieldset class="${classes}">${options}</fieldset>`, { stacked: true })}</form>`;
}

function problemNavigationMarkup() {
  const label = yoiEndView ? '宵 終幕' : startView ? 'スタート' : investigationView ? scenario.investigation.id : problemLabel(current());
  return `<button class="problem-toggle" data-action="toggle-problems" aria-label="問題番号を選択：${esc(label)}" aria-expanded="${problemMenuExpanded}" aria-controls="problem-menu"><span>問題番号 <strong>${esc(label)}</strong></span>${icon('chevron')}</button><nav id="problem-menu" class="problem-menu" aria-label="問題番号" ${problemMenuExpanded ? '' : 'hidden'}><button data-action="start" ${startView ? 'aria-current="step"' : ''}><span>スタート</span></button>${navigationProblems().map(p => `<button data-action="select" data-id="${esc(p.id)}" ${canOpenProblem(p, state) ? '' : 'disabled'} ${!startView && !yoiEndView && (p.id === state.selected || isInvestigation(state.selected) && p.id === scenario.investigation.id) ? 'aria-current="step"' : ''} aria-label="${esc(p.id)}${(p.id === scenario.investigation.id ? investigationComplete(scenario, state) : state.solved.includes(p.id)) ? ' 解答済み' : ''}"><span>${esc(p.id)}</span>${(p.id === scenario.investigation.id ? investigationComplete(scenario, state) : state.solved.includes(p.id)) ? icon('check') : ''}</button>${p.completionScreen === 'yoi' && state.solved.includes(p.id) ? `<button data-action="yoi-end" ${yoiEndView ? 'aria-current="step"' : ''}><span>宵 終幕</span></button>` : ''}`).join('')}</nav>`;
}

function alignCurrentProblem(menu = document.querySelector('#problem-menu')) {
  const active = menu?.querySelector?.('[aria-current="step"]');
  if (!active || !menu.clientHeight) return;
  const alignFrom = scenario.problems.findIndex(p => p.id === 'N5');
  const currentIndex = scenario.problems.findIndex(p => p.id === state.selected);
  if (startView || currentIndex < alignFrom) {
    menu.scrollTop = 0;
    return;
  }
  const style = getComputedStyle(menu);
  const paddingTop = parseFloat(style.paddingTop) || 0;
  // N5以降は、リストの実際のスクロール範囲内で現在の問題を上端へ揃える。
  const offset = active.getBoundingClientRect().top - menu.getBoundingClientRect().top - paddingTop;
  menu.scrollTop += offset;
}

function updateProblemNavigation() {
  const navigation = document.querySelector('#problem-navigation');
  if (navigation) navigation.innerHTML = problemNavigationMarkup();
  if (problemMenuExpanded) alignCurrentProblem();
}

function setProblemMenuExpanded(expanded) {
  if (problemMenuExpanded === expanded) return;
  problemMenuExpanded = expanded;
  syncNavigation();
  if (expanded) setMenuExpanded(false);
  const menu = document.querySelector('#problem-menu');
  document.querySelector('.problem-toggle')?.setAttribute('aria-expanded', String(expanded));
  if (!menu) return;
  menu.hidden = false;
  menu.inert = !expanded;
  if (expanded) alignCurrentProblem(menu);
  animateSurface(menu, expanded, -8).then(finished => {
    if (finished && !problemMenuExpanded && menu.isConnected) menu.hidden = true;
  });
  if (expanded) document.querySelector('.problem-toggle')?.focus({ preventScroll: true });
}

function composerContentMarkup(p) {
  const heading = p.answerPresentation === 'page'
    ? `<div class="answer-composer-heading"><h2>${esc(problemLabel(p))}</h2></div>`
    : `<div class="answer-composer-heading"><h2>${esc(problemLabel(p))}</h2><button class="composer-close" data-action="close-composer" aria-label="回答エリアを閉じる">${icon('close')}</button></div>`;
  if (p.type === 'pending') return `${heading}<div class="answer-problem"><p>${esc(p.prompt)}</p></div>`;
  const content = p.image ? puzzleCardMarkup(p) : `<div class="answer-problem" data-problem-id="${esc(p.id)}"><p>${problemPromptMarkup(p)}</p>${p.answerTemplate ? `<p class="answer-template">${esc(p.answerTemplate)}</p>` : ''}${p.wordBank ? `<div class="word-bank"><span>語群</span><p>${p.wordBank.map(esc).join('、')}</p></div>` : ''}</div>
    ${answerFormMarkup(p)}
    ${['text', 'fields'].includes(p.type) ? '' : `<div class="composer-meta"><span>${p.type === 'multiple' ? p.selectionCount ? `${p.selectionCount}つ選んでください。` : '当てはまるものをすべて選んでください。' : 'ひとつ選んでください。'}</span></div>`}`;
  return `${heading}${content}<div id="answer-readiness" class="answer-readiness" role="status"></div><div id="answer-error" class="answer-error" role="status"></div><div class="feedback" role="status">${esc(feedback || storageWarning)}</div>`;
}

function puzzleTextMarkup(text) {
  return String(text).split('{blank}').map(esc).join('<span class="puzzle-blank">？</span>');
}

function puzzleImages(p = current()) {
  return p.images ?? (p.diagram || p.image ? [{ src: p.diagram ?? p.image, alt: p.diagramAlt ?? p.imageAlt ?? `${problemLabel(p)}の問題図` }] : []);
}

function puzzlePageButtonsMarkup(p = current()) {
  return puzzleImages(p).map((_, index) => `<button type="button" data-action="puzzle-page" data-index="${index}" aria-label="資料${index + 1}を表示" aria-pressed="${index === puzzleImageIndex}"><span>${index + 1}</span></button>`).join('');
}

function puzzlePagesMarkup(p = current()) {
  return puzzleImages(p).length > 1 ? `<nav class="puzzle-gallery-pages" aria-label="問題資料の切り替え">${puzzlePageButtonsMarkup(p)}</nav>` : '';
}

function puzzleVisualMarkup(p) {
  const image = puzzleImages(p)[puzzleImageIndex] ?? puzzleImages(p)[0];
  return `<button class="puzzle-preview" data-action="puzzle-image" aria-label="${esc(problemLabel(p))}の図を拡大表示">
    <img class="puzzle-diagram-image" src="${esc(image.src)}" alt="${esc(image.alt)}">
  </button>${puzzlePagesMarkup(p)}`;
}

function setPuzzleImage(index) {
  const p = current();
  const images = puzzleImages(p);
  if (!Number.isInteger(index) || index < 0 || index >= images.length || index === puzzleImageIndex) return;
  const pageHadFocus = document.activeElement?.dataset?.action === 'puzzle-page';
  const direction = index > puzzleImageIndex ? 1 : -1;
  puzzleImageIndex = index;
  const visual = document.querySelector('.puzzle-visual');
  if (visual) {
    visual.innerHTML = puzzleVisualMarkup(p);
    bindPuzzleSubmitLayout();
    animatePuzzleImage(visual.querySelector('.puzzle-diagram-image'), direction);
  }
  if (panel.open && panel.classList.contains('image-viewer')) {
    const image = panel.querySelector('.puzzle-full-image');
    imageViewer?.reset();
    if (image) { image.src = images[index].src; image.alt = images[index].alt; animatePuzzleImage(image, direction); }
    const pages = panel.querySelector('.puzzle-gallery-pages');
    if (pages) pages.innerHTML = puzzlePageButtonsMarkup(p);
  }
  save();
  if (pageHadFocus) (panel.open ? panel : visual)?.querySelector(`[data-action="puzzle-page"][data-index="${index}"]`)?.focus({ preventScroll: true });
}

// 読み込み前の空画像を動かさず、連続切り替えでは最後に選んだ資料だけを表示する。
const puzzleImageReveals = new WeakMap();
function animatePuzzleImage(image, direction) {
  if (!image) return;
  const previous = puzzleImageReveals.get(image);
  if (previous) image.removeEventListener('load', previous);
  surfaceAnimations.get(image)?.cancel();
  surfaceAnimations.delete(image);
  const reveal = () => {
    image.removeEventListener('load', reveal);
    puzzleImageReveals.delete(image);
    if (image.isConnected && image.naturalWidth > 0) animateSurface(image, true, direction * 12, 'X');
  };
  if (image.complete) reveal();
  else if (image.addEventListener) {
    puzzleImageReveals.set(image, reveal);
    image.addEventListener('load', reveal, { once: true });
  }
}

function puzzleCopyMarkup(p, includeAnswer = true) {
  const instruction = Array.isArray(p.cardInstruction)
    ? p.cardInstruction.map(part => `<span class="instruction-phrase">${puzzleTextMarkup(part)}</span>`).join('')
    : puzzleTextMarkup(p.cardInstruction ?? '');
  const question = `<h2>${p.cardQuestionIcon ? `<img class="puzzle-question-icon" src="${esc(p.cardQuestionIcon)}" alt="${esc(p.cardQuestionIconAlt)}" width="54" height="83">` : ''}${puzzleTextMarkup(p.cardHeading ?? p.prompt)}</h2>
      ${p.cardInstruction ? `<p class="puzzle-card-instruction">${instruction}</p>` : ''}`;
  const prompt = `${p.answerLayout === 'compact' ? `<div class="puzzle-card-prompt">${question}</div>` : question}
      ${p.cardDestination ? `<p class="puzzle-card-destination">${puzzleTextMarkup(p.cardDestination)}</p>` : ''}`;
  return `${prompt}${includeAnswer ? answerFormMarkup(p) : ''}`;
}

function puzzleCardMarkup(p) {
  const compact = p.answerLayout === 'compact';
  return `<article class="start-puzzle-card" data-problem-id="${esc(p.id)}"${compact ? ` data-answer-layout="compact" data-has-destination="${Boolean(p.cardDestination)}"` : ''} aria-label="${esc(problemLabel(p))}の問題カード">
    <div class="puzzle-card-copy">${puzzleCopyMarkup(p, !compact)}</div>
    <div class="puzzle-visual">
      ${puzzleVisualMarkup(p)}
      ${compact ? '<span class="puzzle-preview-hint" aria-hidden="true">タップで拡大</span>' : ''}
    </div>
    ${compact ? `<div class="puzzle-card-response">${answerFormMarkup(p)}</div>` : ''}
  </article>`;
}

function yoiCompletionMarkup() {
  return `<section class="yoi-completion" aria-labelledby="yoi-completion-title">
    <div class="yoi-completion-copy"><p class="yoi-completion-label">11月の救祭</p><h1 id="yoi-completion-title" tabindex="-1">宵</h1><p class="yoi-completion-end">終幕</p><p>「11月の救祭 宵」はここで終了です。<br>遊んでいただき、ありがとうございました。</p><p>冊子後半「11月の救祭 冥」をご購入の方は続きを会場または自宅などでお楽しみいただけます。</p></div>
    <div class="yoi-completion-actions" role="group" aria-label="続きの遊び方">
      <button class="primary-button yoi-venue-button" data-action="continue-at-venue"><span>会場で続きを解く</span></button>
      <button class="secondary-button yoi-online-button" data-action="continue-online"><span>オンライン版を利用して自宅などで解く</span></button>
    </div>
    ${storageWarning ? `<p class="feedback" role="status">${esc(storageWarning)}</p>` : ''}
  </section>`;
}

function showChapterTransition() {
  if (reducedMotion()) return;
  const workspace = document.querySelector('.workspace');
  workspace?.insertAdjacentHTML('beforeend', '<div class="chapter-transition" role="status"><p>11月の救祭</p><strong>冥</strong></div>');
  const cover = document.querySelector('.chapter-transition');
  if (!cover?.animate) { cover?.remove(); return; }
  const animation = cover.animate([
    { opacity: 1, backgroundColor: '#eee8df' },
    { opacity: 1, backgroundColor: '#1d211e', offset: .45 },
    { opacity: 0, backgroundColor: '#1d211e' },
  ], { duration: 750, easing: MOTION.ease, fill: 'both' });
  void animation.finished.catch(() => {}).finally(() => { cover.remove(); animation.cancel(); });
}

function historyProblems() {
  return scenario.problems.filter(item => state.solved.includes(item.id) && !item.advanceTo).reverse();
}

function secondaryScreenHeader(backAction) {
  return `<header class="topbar clue-screen-header"><div class="brand"><button class="menu-button clue-back" data-action="${backAction}" aria-label="戻る">${icon('arrow')}</button><span${backAction === 'close' ? ' id="panel-title"' : ''} class="brand-title">${esc(scenario.title)}</span></div><button class="hint-button" data-action="hints" aria-label="ヒント">${icon('hint')}<span>ヒント</span></button></header>`;
}

function historyScreenMarkup() {
  const visibleMessages = isPlaying ? [...state.messages.slice(0, sceneStart), ...displayedMessages] : state.messages;
  const entries = historyProblems().map(item =>
    `<details class="history-entry" data-history-problem="${esc(item.id)}" ${historyOpenProblems.has(item.id) ? 'open' : ''}><summary><span class="history-question">${esc(problemLabel(item))}</span><span class="history-title">${esc(problemTitle(item))}</span>${icon('chevron')}</summary><div class="history-messages">${visibleMessages.filter(m => m.problemId === item.id && isConversationLine(m)).map(messageMarkup).join('')}</div></details>`).join('');
  return `<section class="history-screen" aria-labelledby="history-heading">${secondaryScreenHeader('history-back')}<div class="history-body"><h1 id="history-heading" tabindex="-1">会話履歴</h1><p class="history-intro">問題を開くと、これまでの会話を読み返せます。</p>${entries || '<div class="history-empty"><p>まだ会話履歴はありません。</p><p>問題に正解すると、ここに会話が届きます。</p></div>'}</div></section>`;
}

function openHistoryScreen() {
  if (historyView) return;
  document.querySelector('.history-screen')?.remove();
  closePanel();
  setMenuExpanded(false);
  setProblemMenuExpanded(false);
  historyChatScrollTop = document.querySelector('.chat-area')?.scrollTop ?? 0;
  historyScrollTop = 0;
  const entries = historyProblems();
  historyOpenProblems = new Set(entries.length ? [entries[0].id] : []);
  historyView = true;
  const workspace = document.querySelector('.workspace');
  workspace?.classList.add('history-is-open');
  workspace?.insertAdjacentHTML('beforeend', historyScreenMarkup());
  animateSurface(document.querySelector('.history-screen'), true, 12, 'X');
  document.querySelector('#history-heading')?.focus({ preventScroll: true });
  syncNavigation();
}

function closeHistoryScreen() {
  if (!historyView) return;
  historyView = false;
  const screen = document.querySelector('.history-screen');
  const workspace = document.querySelector('.workspace');
  workspace?.classList.remove('history-is-open');
  const chat = document.querySelector('.chat-area');
  if (chat) chat.scrollTop = historyChatScrollTop;
  document.querySelector('.menu-button')?.focus({ preventScroll: true });
  syncNavigation();
  if (!screen?.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { screen?.remove(); return; }
  screen.inert = true;
  return animateSurface(screen, false, 12, 'X').then(finished => { if (finished) screen.remove(); });
}

document.addEventListener('toggle', event => {
  const id = event.target.dataset?.historyProblem;
  if (!id) return;
  if (event.target.open) historyOpenProblems.add(id);
  else historyOpenProblems.delete(id);
}, true);

function render({ scroll = false, peelingConclusions = [] } = {}) {
  if (gateVisible) { renderEntry(); return; }
  if (historyView) historyScrollTop = document.querySelector('.history-body')?.scrollTop ?? historyScrollTop;
  const chatScrollTop = document.querySelector('.chat-area')?.scrollTop ?? 0;
  const previousComposer = document.querySelector('.composer-area');
  const previousComposerHeight = previousComposer && !previousComposer.hidden ? previousComposer.getBoundingClientRect?.().height : 0;
  const p = current();
  const solved = state.solved.includes(p.id);
  const sceneProblem = composerExpanded && answerOrigin ? scenario.problems.find(item => item.id === answerOrigin.problemId) : p;
  const inInvestigation = !startView && !investigationView && isInvestigation(sceneProblem.id);
  const investigationReturnVisible = inInvestigation && state.solved.includes(sceneProblem.id) && !isPlaying && !(answerOrigin?.repeatAnswer ?? repeatAnswer);
  const nextProblem = followingProblem(p);
  const resumedAnswer = !composerExpanded && answerOrigin?.problemId === p.id && scenario.problems.find(item => item.id === answerOrigin.answerId);
  const answerTarget = resumedAnswer || (!startView && !repeatAnswer && solved ? nextProblem ?? p : p);
  const guideNext = showsGuideStop(sceneProblem, answerOrigin?.repeatAnswer ?? repeatAnswer);
  const opensProblemList = answerTarget.id === scenario.investigation.id && !inInvestigation;
  const sectionFinished = solved && !nextProblem && !startView && !repeatAnswer;
  const completionPending = awaitingYoiPageTurn();
  const composerVisible = !investigationView && !yoiEndView && (!solved || startView || repeatAnswer) && !isPlaying && composerExpanded;
  const boardBackground = !startView && p.conversationBackground === 'investigation';
  const showBoard = investigationView || boardBackground;
  const answerPageVisible = p.answerPresentation === 'page' && composerVisible;
  const showStartGuide = startView || (p.id === 'N1' && !isPlaying && (!solved || repeatAnswer) && !displayedMessages.length);
  const showClues = p.chapter === '第二章' && !startView && !yoiEndView;
  const clueCount = showClues ? unlockedCards(scenario, state).length : 0;
  const showDeductionGuide = ['Q1', 'Q1.1'].includes(sceneProblem.id) && !isPlaying && !displayedMessages.length;
  const characterScene = displayedMessages.some(message => message.speaker && message.kind === 'dialogue');
  const lastMessage = displayedMessages.at(-1);
  const lastScene = scenario.problems.find(item => item.id === lastMessage?.problemId);
  const storyBackdrop = !isPlaying && hasStoryPageTurn(lastScene);
  const transcript = characterScene ? displayedMessages.filter(message =>
    isSceneNotice(message) && !(storyBackdrop && isBookletTurn(message.text))) : displayedMessages;
  const lastStoryLine = storyBackdrop && (lastScene === sceneProblem || !transcript.length)
    ? displayedMessages.findLast(m => m.problemId === lastScene.id && m.kind === 'dialogue' && !isSceneNotice(m)) : null;
  // 案内のない会話は、読了後も最後の台詞を表示する。
  const closingAvailable = canReadInvestigationClosing();
  const novel = !showBoard && (isPlaying ? novelPlayback : completionPending || lastStoryLine || closingAvailable || characterScene && !transcript.length && !sceneProblem.instruction);
  const novelLine = completionPending
    ? displayedMessages.findLast(m => m.problemId === p.id && m.speaker) ?? p.dialogue.findLast(m => m.speaker)
    : lastStoryLine || lastMessage;
  const branchPending = solved && !isPlaying && !startView && p.branches && !state.branches[p.id];
  let workspace = document.querySelector('.workspace');
  if (!workspace) {
    app.innerHTML = '<div class="shell"><main id="main" class="workspace"></main></div>';
    workspace = document.querySelector('.workspace');
  }
  workspace.className = `workspace${novel ? ' novel-workspace' : ''}${p.chapter === '第二章' ? ' chapter-mei' : ''}${historyView ? ' history-is-open' : ''}`;
  workspace.inert = investigationClosing;
  workspace.innerHTML = `
      <header class="play-header"><div class="topbar"><div class="brand"><div class="navigation-menu"><button class="menu-button" data-action="toggle-menu" aria-label="メニュー" aria-controls="navigation-menu" aria-expanded="${menuExpanded}">${icon('menu')}</button><nav id="navigation-menu" class="menu-items" ${menuExpanded ? '' : 'hidden'} aria-label="メインメニュー"><button class="active" data-action="chat" aria-current="page">${icon('chat')}<span>トーク</span></button><button data-action="hints">${icon('hint')}<span>ヒント</span></button>${showClues ? `<button data-action="clues">${icon('cards')}<span>手がかり</span>${clueCount ? `<small class="nav-badge">${clueCount}</small>` : ''}</button>` : ''}<button data-action="history">${icon('history')}<span>履歴</span></button><button data-action="save-info">${icon('numberTicket')}<span>再開番号</span></button><button data-action="trouble">${icon('warning')}<span>トラブル</span></button><button data-action="save-title">${icon('home')}<span>タイトルに戻る</span></button></nav></div><span class="brand-title">${esc(scenario.title)}</span></div><button class="hint-button" data-action="hints" aria-label="ヒント">${icon('hint')}<span>ヒント</span></button></div>
        <div class="play-toolbar">
          <div id="problem-navigation" class="problem-navigation">${problemNavigationMarkup()}</div>
          <div class="play-actions">
            ${showClues ? `<button class="clue-button" data-action="clues" aria-label="手がかり">${icon('cards')}<span>手がかり</span></button>` : ''}
            ${investigationView ? `<button class="answer-fab investigation-next" data-action="investigation-next" ${investigationComplete(scenario, state) ? '' : 'disabled'} aria-describedby="investigation-next-status">${icon('edit')}<span>次へ</span></button>`
              : completionPending || p.type === 'pending' || isPlaying || branchPending || yoiEndView || sectionFinished ? '' : guideNext
              ? `<button class="answer-fab" data-action="travel-next" aria-haspopup="dialog" aria-controls="panel" ${composerVisible ? 'disabled' : ''}>${icon('edit')}<span>次へ</span></button>`
              : `<button class="answer-fab" data-action="open-composer" ${composerVisible ? 'disabled' : ''} ${opensProblemList ? '' : `aria-controls="composer-area" aria-expanded="${composerExpanded}"`}>${icon('edit')}<span>次へ</span></button>`}
          </div>
        </div>
      </header>
      ${playSaves?.getStatus().mode === 'debug' ? '' : `<div class="save-status-strip${storageWarning ? ' save-warning' : ''}"><span data-save-status>${esc(playSaves?.getStatus().message ?? '')}</span></div>`}
      ${yoiEndView ? yoiCompletionMarkup() : ''}
      ${p.type === 'pending' ? `<section class="q4-pending"><h1>${esc(p.title)}</h1><p>${esc(p.prompt)}</p><button class="primary-button" data-action="investigation-back">問題一覧へ戻る</button></section>` : ''}
      ${inInvestigation && !investigationReturnVisible ? '<button class="investigation-back" data-action="investigation-back">問題一覧へ</button>' : ''}
      <section class="chat-area${novel ? ' novel-area' : ''}${showStartGuide ? ' start-view' : ''}${showBoard ? ' investigation-hub' : ''}${inInvestigation ? ' investigation-detail' : ''}" aria-label="${showStartGuide ? 'WeBotの使い方' : showDeductionGuide ? '推理パートの進め方' : showBoard ? '残された違和感の一覧' : '謎解き会話'}" tabindex="0" ${boardBackground && composerVisible ? 'inert' : ''} ${yoiEndView || p.type === 'pending' || answerPageVisible ? 'hidden' : ''}>
        ${showStartGuide ? `<article class="start-guide" aria-labelledby="start-guide-heading">
          <h1 id="start-guide-heading">WeBotの使い方</h1>
          <p>「11月の救祭」では、謎の回答提出やヒントの閲覧、各地点への誘導などに独自開発のWebBot、通称「WeBot」を使用します。本アプリでは進行状況を記録するため、時間を空けて途中からプレイすることも可能です。</p>
          <p>別の端末で続きを遊ぶときは、タイトル画面で「続きから」を選び、6桁の再開番号を入力してください。</p>
          <div class="start-guide-menu">
            <img class="start-guide-menu-image" src="../assets/menu-guide-annotated.webp" alt="画面左上の三本線メニューを丸と矢印で示した画像">
            <p>画面左上の三本線からメニューを開き、「再開番号」を選ぶと番号を確認できます。ヒントや会話の履歴を見たいときも、タイトルに戻りたいときも、このメニューを使います。</p>
          </div>
        </article>` : ''}
        ${showDeductionGuide && showVenueDirections ? `<article class="start-guide venue-guide" aria-labelledby="venue-guide-heading">
          <h1 id="venue-guide-heading">会場への行き方</h1>
          ${travelGuideMarkup(scenario.venueGuide, 'venue')}
        </article>` : ''}
        ${showDeductionGuide ? `<article class="start-guide" aria-labelledby="deduction-guide-heading">
          <h1 id="deduction-guide-heading">推理パートの進め方</h1>
          <p>「11月の救祭 冥」では手がかりとなるカード等を用いて、事件の解決に取り組んでいただきます。</p>
          <p>オンラインでプレイされる方は、画面上部の「手がかり」のボタンから、事件に関する資料を確認することが可能です。</p>
          <figure class="deduction-guide-toolbar">
            <img src="../assets/q1-clue-toolbar.png" width="914" height="248" alt="WeBot上部の「手がかり」ボタン。画面上部の右側にあります。">
            <svg viewBox="0 0 914 248" aria-hidden="true"><rect x="455" y="147" width="190" height="86" rx="43" fill="none" stroke="currentColor" stroke-width="5"/><path d="M406 240 L462 209" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><path d="M472 203 L455 225 L445 208 Z" fill="currentColor"/></svg>
          </figure>
          <p>会場でプレイされる方は、画面上の「手がかり」ボタンに加えて、印刷した資料を会場で受け取ってプレイすることも可能です。</p>
        </article>` : ''}
        ${showBoard ? investigationMarkup(peelingConclusions) : ''}
        ${novel ? novelSceneMarkup(novelLine) : `<div id="messages" class="messages" role="log" aria-label="会話" aria-live="polite" aria-relevant="additions text">${showBoard ? '' : transcript.map(messageMarkup).join('')}</div>`}
        ${branchPending ? `<div class="branch-options" aria-label="会話の選択肢">${p.branches.map(b => `<button data-action="branch" data-id="${esc(b.id)}">${esc(b.label)}</button>`).join('')}</div>` : ''}
        ${sceneProblem.instruction && !hasStoryPageTurn(sceneProblem) && state.solved.includes(sceneProblem.id) && !isPlaying && !startView && !displayedMessages.some(message => !message.speaker && normalizePageTurnText(message.text) === normalizePageTurnText(sceneProblem.instruction)) ? instructionCardMarkup(sceneProblem.instruction) : ''}
        ${(solved || isPlaying) && storageWarning ? `<div class="feedback" role="status">${esc(storageWarning)}</div>` : ''}
      ${investigationView ? `<p id="investigation-next-status" class="sr-only">${investigationComplete(scenario, state) ? 'すべての謎を解きました。' : 'すべての謎を解くと、次へ進めます。'}</p>` : ''}
      </section>
      ${investigationReturnVisible && !closingAvailable ? '<button class="investigation-return" data-action="investigation-back">問題一覧へ戻る</button>' : ''}
      <button id="conversation-notice" class="conversation-notice" data-action="continue-conversation" aria-live="polite" aria-atomic="true" hidden>↓ 続きの会話</button>
      <section id="composer-area" class="composer-area${answerPageVisible ? ' answer-page' : ''}" aria-label="${answerPageVisible ? `${esc(p.id)}の回答画面` : '問題と回答'}" tabindex="-1" ${composerVisible ? '' : 'hidden'}>
        ${p.answerPresentation === 'page' && !composerVisible ? '' : composerContentMarkup(p)}
      </section>
      ${historyView ? historyScreenMarkup() : ''}`;
  document.querySelector('.investigation-closing')?.remove();
  if (investigationClosing) workspace.insertAdjacentHTML('afterend', investigationClosingMarkup());
  if (investigationClosing) document.querySelector('.investigation-closing button')?.focus({ preventScroll: true });
  document.querySelector('.chat-area').scrollTop = chatScrollTop;
  const historyBody = document.querySelector('.history-body');
  if (historyBody) historyBody.scrollTop = historyScrollTop;
  bindChatScroll();
  bindPuzzleSubmitLayout();
  prepareAnswerForm();
  animateComposerHeight(document.querySelector('.composer-area'), previousComposerHeight);
  if (problemMenuExpanded) alignCurrentProblem();
  viewportLayout.update();
  updateConversationNotice();
  if (scroll) scrollConversationToEnd();
  syncNavigation();
  save();
}

function switchClueTab(nextTab) {
  const tabs = ['cards', 'characters', 'combine'];
  if (!tabs.includes(nextTab) || nextTab === clueTab) return;
  const direction = tabs.indexOf(nextTab) > tabs.indexOf(clueTab) ? 1 : -1;
  clueTab = nextTab;
  expandedCharacter = null;
  haptics.trigger();
  openPanel('clues');
  animateSurface(panel.querySelector('#clue-tab-content'), true, direction * 40, 'X', MOTION.enter);
  panel.querySelector(`#clue-tab-${clueTab}`)?.focus({ preventScroll: true });
}

function animateCharacterCard(element, sourceRect) {
  if (!element?.animate || !sourceRect?.width || reducedMotion()) return;
  const targetRect = element.getBoundingClientRect();
  if (!targetRect.width || !targetRect.height) return;
  const panelRect = panel.getBoundingClientRect();
  const ghost = element.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: 'absolute', left: `${targetRect.left - panelRect.left}px`, top: `${targetRect.top - panelRect.top}px`,
    width: `${targetRect.width}px`, height: `${targetRect.height}px`, margin: '0', zIndex: '10', pointerEvents: 'none',
    transformOrigin: 'center',
  });
  panel.append(ghost);
  element.style.visibility = 'hidden';
  const dx = sourceRect.left + sourceRect.width / 2 - targetRect.left - targetRect.width / 2;
  const dy = sourceRect.top + sourceRect.height / 2 - targetRect.top - targetRect.height / 2;
  const animation = ghost.animate([
    { transform: `translate(${dx}px, ${dy}px) scale(${sourceRect.width / targetRect.width}, ${sourceRect.height / targetRect.height})` },
    { transform: 'translate(0, 0) scale(1)' },
  ], { duration: MOTION.enter, easing: MOTION.ease, fill: 'both' });
  animation.finished.catch(() => {}).finally(() => {
    ghost.remove();
    element.style.removeProperty('visibility');
  });
}

function closeCharacterPreview() {
  const index = expandedCharacter;
  const sourceRect = panel.querySelector('.clue-gallery-card[aria-current="true"]')?.getBoundingClientRect?.();
  expandedCharacter = null;
  openPanel('clues');
  const tile = panel.querySelector(`[data-action="character-open"][data-index="${index}"]`);
  tile?.focus({ preventScroll: true });
  animateCharacterCard(tile, sourceRect);
}

function hexEntryOpensReward(id) {
  return playSaves.getStatus().mode !== 'debug' && state.minigames?.includes(id);
}

function clueGalleryCards() {
  const game=scenario.minigames?.find(game=>game.id==='hex-cube');
  const cards=Array.from({length:4},(_,index)=>index===0&&game
    ? `<article class="clue-gallery-card" data-minigame-entry aria-label="${esc(game.title)}" aria-current="true"><span class="hex-card-label">手がかり・仮</span><h2>${esc(game.title)}</h2><p>${esc(game.body)}</p><button class="primary-button full" data-action="hex-open">${hexEntryOpensReward(game.id)?'取得した手がかりを見る':'装置を操作する'}</button></article>`
    : `<article class="clue-gallery-card" aria-label="手がかりカード ${index+1}"></article>`);
  for(const mini of scenario.minigames??[])if(state.minigames?.includes(mini.id)){
    const card=scenario.cards.find(card=>card.id===mini.rewardCard);
    cards.push(`<article class="clue-gallery-card" data-minigame-reward="${esc(mini.id)}" aria-label="${esc(card.title)}"><span class="hex-card-label">手がかり・仮</span><h2>${esc(card.title)}</h2><p>${esc(card.text)}</p></article>`);
  }
  return cards;
}
function openHexCube(id='hex-cube') {
  if(gateVisible)return;
  if(!(scenario.minigames??[]).some(game=>game.id===id))return;
  miniRewardAlready=Boolean(state.minigames?.includes(id));
  expandedCharacter=null;
  if (playSaves.getStatus().phase !== 'conflict') openPanel(hexEntryOpensReward(id)?hexRewardPanel():'hex-cube');
}
function hexRewardPanel() {
  if(playSaves.getStatus().phase==='conflict')return 'hex-pending';
  return playSaves.getStatus().mode!=='debug'&&playSaves.getRecord()?.pending?'hex-pending':'hex-reward';
}
async function confirmHexReward(feedbackFinished) {
  const session=playSessionRevision;
  const revision=panelRevision;
  await Promise.all([playSaves.flush(), feedbackFinished]);
  if(gateVisible||playSessionRevision!==session||panelRevision!==revision)return;
  openPanel(hexRewardPanel());
}
function recordHexFailure() {
  state = { ...state, hexCubeFailures: state.hexCubeFailures + 1 };
  save();
  return state.hexCubeFailures;
}
async function finishHexCube(moves, feedbackFinished) {
  if(miniSaving||gateVisible)return;
  const result=completeMinigame(scenario,state,'hex-cube',moves);
  if(!['correct','already-solved'].includes(result.status))throw new Error('クリアを確認できません。やり直してください。');
  miniSaving=true;
  try {
    state=result.state;miniRewardAlready=result.status==='already-solved';
    save();render();
    await confirmHexReward(feedbackFinished);
  } finally {miniSaving=false;miniView?.refresh();}
}
function bindClueCarousel(initialIndex = 0) {
  const track = panel.querySelector('.clue-carousel');
  if (!track) return;
  const cards = [...track.querySelectorAll('.clue-gallery-card')];
  const position = panel.querySelector('.clue-gallery-position');
  let activeIndex = initialIndex;
  const update = () => {
    const previousIndex = activeIndex;
    const center = track.scrollLeft + track.clientWidth / 2;
    let nearest = Infinity;
    cards.forEach((card, index) => {
      const distance = Math.abs(card.offsetLeft + card.offsetWidth / 2 - center);
      card.style.setProperty('--card-scale', 1 - .14 * Math.min(distance / card.offsetWidth, 1));
      if (distance < nearest) { nearest = distance; activeIndex = index; }
    });
    cards.forEach((card, index) => {
      if (index === activeIndex) card.setAttribute('aria-current', 'true');
      else card.removeAttribute('aria-current');
    });
    position.textContent = `${activeIndex + 1} / ${cards.length}`;
    if (clueTab === 'characters' && expandedCharacter !== null) expandedCharacter = activeIndex;
    if (activeIndex !== previousIndex) haptics.trigger('selection');
  };
  const snapToNearest = () => {
    update();
    const card = cards[activeIndex];
    track.style.scrollSnapType = '';
    track.scrollTo({ left: card.offsetLeft + card.offsetWidth / 2 - track.clientWidth / 2, behavior: reducedMotion() ? 'instant' : 'smooth' });
  };
  let wheelTimer;
  track.addEventListener('wheel', event => {
    if (event.ctrlKey) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    track.style.scrollSnapType = 'none';
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? track.clientWidth : 1;
    track.scrollLeft += delta * multiplier;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(snapToNearest, 160);
    update();
  }, { passive: false });
  let drag = null;
  let dragged = false;
  track.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    if (event.target?.closest('button, a, input, select, textarea, [role="button"]')) return;
    clearTimeout(wheelTimer);
    dragged = false;
    drag = { x: event.clientX, scroll: track.scrollLeft };
    track.style.scrollSnapType = 'none';
    track.setPointerCapture(event.pointerId);
    track.classList.add('is-dragging');
  });
  track.addEventListener('pointermove', event => {
    if (!drag) return;
    if (Math.abs(drag.x - event.clientX) > 5) dragged = true;
    track.scrollLeft = drag.scroll + drag.x - event.clientX;
    update();
  });
  const finishDrag = () => {
    if (!drag) return;
    drag = null;
    track.classList.remove('is-dragging');
    snapToNearest();
  };
  track.addEventListener('click', event => {
    if (dragged) { event.preventDefault(); event.stopPropagation(); dragged = false; }
  }, true);
  track.addEventListener('pointerup', finishDrag);
  track.addEventListener('pointercancel', finishDrag);
  track.addEventListener('lostpointercapture', finishDrag);
  track.addEventListener('scroll', update, { passive: true });
  track.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(0, Math.min(cards.length - 1, activeIndex + (event.key === 'ArrowRight' ? 1 : -1)));
    const card = cards[index];
    track.scrollTo({ left: card.offsetLeft + card.offsetWidth / 2 - track.clientWidth / 2, behavior: reducedMotion() ? 'instant' : 'smooth' });
  });
  if (initialIndex > 0) {
    const card = cards[initialIndex];
    track.scrollLeft = card.offsetLeft + card.offsetWidth / 2 - track.clientWidth / 2;
  }
  update();
}

function hintReaderMarkup(subject) {
  const { hints, explanation } = subject;
  const count = hints.length;
  const index = Math.max(0, (state.hints[subject.id] || 1) - 1);
  const answer = explanation ? `<details class="answer-reveal hint-answer"${index + 1 < count ? ' hidden' : ''}><summary>答えと解説を見る</summary><p>${esc(explanation)}</p></details>` : '';
  if (!count) return `<p class="muted">この問題のヒントはまだありません。</p>${answer}`;
  const cards = hints.map((hint, i) => `<section class="hint-card"${i === index ? '' : ' inert'}><span class="eyebrow">ヒント ${i + 1} / ${count}</span><p>${esc(hint)}</p></section>`).join('');
  return `<div class="hint-reader"><div class="hint-pager"><button type="button" class="hint-prev" aria-label="前のヒント"${index === 0 ? ' disabled' : ''}>${icon('chevron')}</button><div class="hint-window"><div class="hint-track" style="transform:translateX(-${index * 100}%)">${cards}</div></div><button type="button" class="hint-next" aria-label="次のヒント"${index === count - 1 ? ' disabled' : ''}>${icon('chevron')}</button></div><span class="sr-only" role="status"></span>${answer}</div>`;
}

function bindHintReader(subject) {
  const reader = panel.querySelector('.hint-reader');
  if (!reader) return;
  const track = reader.querySelector('.hint-track');
  const prev = reader.querySelector('.hint-prev');
  const next = reader.querySelector('.hint-next');
  const answer = reader.querySelector('.hint-answer');
  let index = Math.max(0, (state.hints[subject.id] || 1) - 1);
  function markRead() {
    if ((state.hints[subject.id] ?? 0) >= index + 1) return;
    state.hints[subject.id] = index + 1;
    save();
  }
  function move(delta) {
    const target = index + delta;
    if (target < 0 || target >= subject.hints.length) return;
    track.children[index].inert = true;
    index = target;
    track.children[index].inert = false;
    track.style.transform = `translateX(-${index * 100}%)`;
    prev.disabled = index === 0;
    next.disabled = index === subject.hints.length - 1;
    if (answer) {
      answer.hidden = !next.disabled;
      if (answer.hidden) answer.open = false;
    }
    reader.querySelector('[role="status"]').textContent = `ヒント ${index + 1} / ${subject.hints.length}。${subject.hints[index]}`;
    if ((delta > 0 && next.disabled) || (delta < 0 && prev.disabled)) {
      (delta > 0 ? prev : next).focus({ preventScroll: true });
    }
    haptics.trigger();
    markRead();
  }
  prev.addEventListener('click', () => move(-1));
  next.addEventListener('click', () => move(1));
  const disclosure = reader.closest('details');
  if (disclosure) {
    disclosure.addEventListener('toggle', () => { if (disclosure.open) markRead(); });
  } else markRead();
}

function openPanel(kind, { keepFocus = false, revealSelector = null, showStartButton = false, travelId = '', travelIndex = 0, imageTrigger = null } = {}) {
  miniView?.destroy();miniView=null;
  panelRevision++;
  const wasOpen = panel.open;
  const previousPanelKind = panel.dataset?.kind;
  const isImagePanel = ['puzzle-image', 'travel-image'].includes(kind);
  const imageLabel = kind === 'travel-image' ? '案内写真' : '問題画像';
  const imageOrigin = (kind === 'puzzle-image' ? document.querySelector('.puzzle-preview') : imageTrigger)?.getBoundingClientRect?.();
  imageReturnElement = isImagePanel ? kind === 'puzzle-image' ? document.querySelector('.puzzle-preview') : imageTrigger : null;
  if (!wasOpen) {
    panelReturnFocus = document.activeElement;
    panelReturnAction = panelReturnFocus?.dataset?.action ?? null;
  }
  imageViewer?.dispose(); imageViewer = null;
  sheetDismiss?.dispose(); sheetDismiss = null;
  if (panel.dataset) panel.dataset.kind = kind;
  const scrollTop = panel.scrollTop;
  const bodyScrollTop = panel.querySelector('.panel-body')?.scrollTop ?? 0;
  surfaceAnimations.get(panel)?.cancel();
  surfaceAnimations.delete(panel);
  panel.classList.remove('is-closing');
  panel.classList.toggle('image-viewer', isImagePanel);
  panel.classList.toggle('clue-gallery', kind === 'clues');
  panel.classList.toggle('hex-cube-panel', kind === 'hex-cube');
  panel.classList.toggle('answer-choice-dialog', ['answer-choices', 'symbol-choices'].includes(kind));
  panel.classList.toggle('symbol-choice-dialog', kind === 'symbol-choices');
  panel.classList.toggle('resume-sheet', kind === 'resume');
  panel.classList.toggle('start-answer-dialog', kind === 'start-answer');
  const pageTurnDialog = kind === 'travel-next' || kind === 'yoi-page-turn';
  panel.classList.toggle('page-turn-dialog', pageTurnDialog);
  const saveInfo = kind === 'save-info';
  panel.classList.toggle('save-info-sheet', saveInfo);
  panel.inert = false;
  const focusedId = keepFocus ? document.activeElement?.id : null;
  let title = '';
  let content = '';
  const p = current();
  panel.classList.toggle('image-gallery', kind === 'puzzle-image' && puzzleImages(p).length > 1);
  if (kind === 'hex-cube') {
    title = '控室の問題';
    const game = scenario.minigames.find(game => game.id === 'hex-cube');
    content = `<div id="hex-cube-host"></div><details class="answer-reveal"><summary>控室の問題のヒント</summary>${hintReaderMarkup(game)}</details>`;
  } else if (kind === 'hex-reward') {
    title='システム';
    const game=scenario.minigames.find(game=>game.id==='hex-cube'),card=scenario.cards.find(card=>card.id===game.rewardCard);
    content=`<div class="hex-reward-message" role="status"><span class="eyebrow">SYSTEM</span><p>${miniRewardAlready?'この手がかりは取得済みです。':`新しい手がかり「${esc(card.title)}」を手に入れた。`}</p></div><button class="primary-button full" data-action="hex-card">手がかりを見る</button>`;
    if (playSaves.getStatus().mode === 'debug') {
      content += '<button class="primary-button full" data-action="hex-open">もう一度解く</button>';
    }
  } else if (kind === 'hex-pending') {
    title='システム';content='<p role="status">クリアしました。手がかりの保存を確認しています。通信が戻ったら、もう一度確認してください。</p><button class="primary-button full" data-action="hex-save-retry">保存を確認する</button>';
  } else if (kind === 'resume') {
    title = '続きから';
    content = `<form id="resume-form"><p id="resume-help">6桁の再開番号を入力してください。</p><fieldset class="resume-digits" aria-describedby="resume-help resume-error" ${gateBusy ? 'disabled' : ''}><legend class="sr-only">再開番号（数字6桁）</legend>${gateDigits.map((digit, index) => `<input id="resume-digit-${index}" data-resume-digit="${index}" name="digit" type="text" inputmode="numeric" pattern="[0-9０-９]" maxlength="1" required autocomplete="${index === 0 ? 'one-time-code' : 'off'}" aria-label="再開番号 ${index + 1}桁目" aria-invalid="${Boolean(gateError)}" value="${esc(digit)}">`).join('')}</fieldset><p id="resume-error" class="resume-error" role="alert">${esc(gateError)}</p><button class="primary-button full" type="submit" ${gateBusy ? 'disabled' : ''}>${gateBusy ? '確認中…' : '続きから'}</button></form>`;
  } else if (kind === 'symbol-choices') {
    const word = p.fields?.find(field => field.kanaChoices);
    const values = symbolSlotValues(p);
    title = `${p.id}：${word ? '空欄③の' : ''}${activeSymbolSlot + 1}文字目を選択`;
    content = `<div class="symbol-picker-slots" role="group" aria-label="回答する空欄">${symbolSlotButtonsMarkup(values, true)}</div><div class="symbol-choice-grid" role="group" aria-label="${word ? 'ひらがな' : '数字0〜9と8方向の矢印'}">${(word?.kanaChoices ?? p.symbolChoices).map(value => `<button type="button" data-action="choose-symbol" data-id="${esc(value)}" aria-label="${esc(value)}" aria-pressed="${value === values[activeSymbolSlot]}">${esc(value)}</button>`).join('')}</div>${word ? '<div class="kana-actions"><button type="button" data-action="kana-delete">1字消す</button></div>' : ''}`;
  } else if (kind === 'answer-choices') {
    title = '答えを選択';
    content = `<div class="answer-choice-grid" role="group" aria-label="N1の選択肢">${p.options.map(option => `<button type="button" data-action="choose-answer" data-id="${esc(option.id)}" aria-pressed="${option.id === selectedPuzzleAnswer}">${answerChoiceMarkup(option)}</button>`).join('')}</div>`;
  } else if (kind === 'puzzle-image') {
    title = `${problemLabel(p)}の問題`;
    const image = puzzleImages(p)[puzzleImageIndex] ?? puzzleImages(p)[0];
    content = `<img class="puzzle-full-image" src="${esc(image.src)}" alt="${esc(image.alt)}" draggable="false">`;
  } else if (kind === 'trouble') {
    title = 'トラブル';
    content = `<details class="trouble-photos"><summary>N5の現地資料が見られないとき</summary>${travelGuideMarkup(scenario.troubleGuide, 'trouble')}</details>`;
  } else if (kind === 'travel-image') {
    const guide = travelId === 'trouble' ? scenario.troubleGuide
      : travelId === 'venue' ? scenario.venueGuide : scenario.problems.find(item => item.id === travelId)?.travelGuide;
    const step = Number.isInteger(travelIndex) && guide?.steps[travelIndex];
    if (!step) return;
    title = `${guide.destination}の案内写真${travelIndex + 1}`;
    content = `<img class="puzzle-full-image" src="${esc(step.image)}" alt="${esc(step.imageAlt)}" draggable="false">`;
  } else if (kind === 'hints') {
    title = 'ヒント';
    content = hintReaderMarkup(p);
  } else if (kind === 'clues' && clueTab === 'cards') {
    title = '手がかり';
    const cards=clueGalleryCards();
    content=`<div class="clue-carousel" tabindex="0" role="region" aria-label="手がかりカード。横スクロールまたは左右キーで切り替え">${cards.join('')}</div><p class="clue-gallery-position" role="status">1 / ${cards.length}</p>`;
  } else if (kind === 'clues' && clueTab === 'characters') {
    title = '手がかり';
    content = expandedCharacter === null
      ? `<div class="character-grid">${Array.from({ length: 4 }, (_, index) => `<button class="character-tile" data-action="character-open" data-index="${index}" aria-label="キャラ情報 ${index + 1}を拡大"></button>`).join('')}</div>`
      : `<div class="character-expanded" data-action="character-dismiss"><div class="clue-carousel" tabindex="0" role="region" aria-label="キャラ情報。横スクロールまたは左右キーで切り替え">${Array.from({ length: 4 }, (_, index) => `<article class="clue-gallery-card" aria-label="キャラ情報 ${index + 1}"${index === expandedCharacter ? ' aria-current="true"' : ''}></article>`).join('')}</div><p class="clue-gallery-position" role="status">${expandedCharacter + 1} / 4</p></div>`;
  } else if (kind === 'clues') {
    title = '手がかり';
    const cards = unlockedCards(scenario, state);
    content = `<p class="panel-intro">集めた手がかりを2枚選んで、組み合わせてみましょう。</p><form id="combine-form"><div class="card-grid">${cards.map(c => `<label class="evidence-card"><input type="checkbox" name="card" value="${esc(c.id)}"><span class="card-code">${esc(c.id)}</span><span class="card-mark">${esc(c.mark)}</span><strong>${esc(c.title)}</strong><span class="card-copy">${esc(c.text)}</span></label>`).join('') || '<div class="empty-state">問題に正解すると、ここに<br>手がかりが届きます。</div>'}</div>${cards.length >= 2 ? '<button class="primary-button full" type="submit">2枚の手がかりを組み合わせる</button>' : ''}</form><div id="combine-feedback" role="status"></div><div class="findings">${scenario.combinations.filter(c => state.combinations.includes(c.id)).map(c => `<section class="finding" data-finding-id="${esc(c.id)}"><span class="eyebrow">DISCOVERY · ${esc(c.cards.join(' + '))}</span><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></section>`).join('')}</div>`;
  } else if (kind === 'save-info') {
    const record = playSaves.getRecord();
    const status = playSaves.getStatus();
    title = status.mode === 'debug' ? 'デバッグモード' : '再開番号';
    content = status.mode === 'debug'
      ? '<p>進行は保存されません。再読み込みすると、デバッグ中の進行は失われます。</p><button class="secondary-button full" data-action="save-entry">番号入力画面へ</button>'
      : `<p class="panel-intro">別の端末で再開するときに、この番号を入力してください。番号をメモするか、画面を保存してください。</p>
        <div class="save-code-row"><p class="save-code" data-save-code>${esc(record?.code ?? '発行待ち')}</p><button class="save-copy-button" data-action="save-copy" aria-label="再開番号をコピー" ${normalizePlayCode(record?.code) ? '' : 'disabled'}>${icon('copy')}<span>コピー</span></button></div>
        <p class="save-copy-feedback" data-copy-feedback role="status"></p>
        ${showStartButton ? `<button class="primary-button full save-start-button" data-action="save-start" ${status.phase === 'conflict' ? 'disabled' : ''}>ゲームを開始</button>` : ''}
        ${gateError ? `<p role="alert">${esc(gateError)}</p>` : ''}
        <p class="muted save-code-note">この番号を知っている人は、進行を開けます。他の人への共有はお控えください。</p>
        <div class="save-footer-actions"><button data-action="save-delete-confirm">このプレイデータを削除する</button></div>`;
  } else if (kind === 'save-delete-confirm') {
    title = 'プレイデータを削除';
    content = '<p>この番号のCloudflare上の記録と、このブラウザの対応する記録を削除します。削除後はこの番号で再開できません。</p><div class="reset-actions"><button class="secondary-button" data-action="close">キャンセル</button><button class="primary-button" data-action="save-delete">削除する</button></div>';
  } else if (kind === 'travel-next') {
    const storyTurn = hasStoryPageTurn(p);
    const notice = storyTurn ? p.dialogue.find(line => isSceneNotice({ ...line, problemId: p.id }) && !isBookletTurn(line.text)) : null;
    const bookletEnd = p.completionScreen === 'booklet';
    content = pageTurnCardMarkup(storyTurn ? '冊子の次のページをめくろう' : p.travelGuide?.pageTurnText, {
      action: bookletEnd ? 'close' : 'travel-found',
      buttonLabel: bookletEnd ? 'ページをめくった' : p.travelGuide ? '問題を見つけた' : '次の問題を確認した。', notice: notice?.text,
    });
  } else if (kind === 'yoi-page-turn') {
    content = pageTurnCardMarkup(p.pageTurnText, { action: 'yoi-next', buttonLabel: '宵の最後まで読んだら次へ' });
  } else if (kind === 'start-answer') {
    title = '「次へ」ボタンについて';
    content = '<p class="panel-intro">「次へ」を押すと問題と回答欄が表示されます。シナリオ上で指示があってから押してください。</p><div class="reset-actions"><button class="secondary-button" data-action="close">戻る</button><button class="primary-button" data-action="start-answer-confirm">理解した</button></div>';
  } else if (kind === 'reset') {
    title = 'はじめからやり直す';
    content = '<p class="panel-intro">新しい番号で最初から始めます。元の番号の記録は残ります。元の番号は、プレイ中のメニューにある「再開番号」で確認できます。</p><div class="reset-actions"><button class="secondary-button" data-action="close">キャンセル</button><button class="primary-button" data-action="confirm-reset">新しいプレイを始める</button></div>';
  }
  if (kind === 'trouble' && haptics.supported) {
    content += `<button class="secondary-button full" data-action="toggle-haptics" aria-pressed="${haptics.enabled}">操作時の振動：${haptics.enabled ? 'オン' : 'オフ'}</button>`;
  }
  const clueTabs = [['cards', 'カード'], ['characters', 'キャラ情報'], ['combine', '合成']];
  panel.innerHTML = kind === 'clues'
    ? `${secondaryScreenHeader('close')}<div class="clue-screen-content"><div class="clue-tabs" role="tablist" aria-label="手がかりの表示">${clueTabs.map(([id, label]) => `<button id="clue-tab-${id}" role="tab" data-action="clue-tab" data-tab="${id}" aria-selected="${clueTab === id}" aria-controls="clue-tab-content" tabindex="${clueTab === id ? 0 : -1}">${label}</button>`).join('')}</div><div id="clue-tab-content" class="panel-body" role="tabpanel" aria-labelledby="clue-tab-${clueTab}">${content}</div></div>`
    : pageTurnDialog ? content
    : ['answer-choices', 'symbol-choices'].includes(kind)
    ? `<div class="answer-choice-header"><h2 id="panel-title">${title}</h2><button class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button></div>${content}`
    : isImagePanel
    ? `<h2 id="panel-title" class="sr-only">${title}</h2><button class="icon-button image-viewer-close" data-action="close" aria-label="${imageLabel}を閉じる">${icon('close')}</button><div class="image-viewer-stage" tabindex="0" aria-label="${imageLabel}。ピンチまたはプラス・マイナスで拡大縮小。拡大中はドラッグで移動できます。">${content}</div><div class="image-zoom-controls" role="group" aria-label="画像の拡大縮小"><button data-action="image-zoom-out" aria-label="画像を縮小">−</button><button data-action="image-zoom-reset" aria-label="画像の倍率をリセット"><span data-zoom-label>100%</span></button><button data-action="image-zoom-in" aria-label="画像を拡大">＋</button></div>${kind === 'puzzle-image' ? puzzlePagesMarkup(p) : ''}`
    : `<div class="panel-header"><div><h2 id="panel-title"${saveInfo ? ' tabindex="-1"' : ''}>${title}</h2></div>${saveInfo || kind === 'start-answer' ? '' : `<button class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button>`}</div><div class="panel-body">${content}</div>`;
  const draggableSheet = !isImagePanel && !pageTurnDialog && !['start-answer', 'answer-choices', 'symbol-choices', 'clues', 'hex-cube'].includes(kind);
  panel.classList.toggle('draggable-sheet', draggableSheet);
  if (draggableSheet) {
    const header = panel.querySelector('.panel-header');
    header?.insertAdjacentHTML?.('afterbegin', '<button class="sheet-handle" type="button" data-action="close" aria-label="パネルを閉じる。下に引いて閉じることもできます"><span></span></button>');
    sheetDismiss = bindSheetDismiss(panel, { onDismiss: closePanel, canDismiss: () => !gateBusy, motion: reducedMotion, onThreshold: () => haptics.trigger(), onStart() { surfaceAnimations.get(panel)?.cancel(); surfaceAnimations.delete(panel); } });
  }
  if (!panel.open) panel.showModal();
  syncNavigation();
  if (isImagePanel) {
    imageViewer = bindImageViewer(panel, {
      win: window, onPage: delta => { if (kind === 'puzzle-image') setPuzzleImage(puzzleImageIndex + delta); },
      motion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      onInteract() {
        const image = panel.querySelector('.puzzle-full-image');
        surfaceAnimations.get(image)?.cancel(); surfaceAnimations.delete(image);
      },
    });
    imageViewer?.revealFrom(imageOrigin);
  }
  if (kind === 'hex-cube') miniView=mountHexCube(panel.querySelector('#hex-cube-host'),{onComplete:finishHexCube,onFailure:recordHexFailure,canInteract:()=>!gateVisible&&!miniSaving&&playSaves.getStatus().phase!=='conflict'});
  if (kind === 'hints') bindHintReader(p);
  if (kind === 'hex-cube') bindHintReader(scenario.minigames.find(game => game.id === 'hex-cube'));
  if (kind === 'clues') bindClueCarousel(expandedCharacter ?? 0);
  viewportLayout.schedule();
  if (kind === 'clues') {
    if (revealSelector) animateSurface(panel.querySelector(revealSelector), true, 8);
    else if (!wasOpen || previousPanelKind !== kind) animateSurface(panel.querySelector('.clue-screen-content'), true, 0, 'Y', MOTION.state);
  } else if (!isImagePanel && (kind !== 'resume' || !wasOpen) && (!wasOpen || previousPanelKind !== kind || revealSelector)) {
    animateSurface(wasOpen ? panel.querySelector(revealSelector ?? '.panel-body') ?? panel.querySelector('.symbol-choice-grid, .answer-choice-grid, .image-viewer-stage') : panel, true, kind === 'resume' ? '100%' : wasOpen ? 8 : 24);
  }
  if ((!wasOpen || previousPanelKind !== kind) && ['answer-choices', 'symbol-choices'].includes(kind)) {
    revealItems('.answer-choice-grid button, .symbol-choice-grid button', panel);
  }
  if (kind === 'resume') {
    const closeButton = panel.querySelector('[data-action="close"]');
    if (closeButton) closeButton.disabled = gateBusy;
    if (!gateBusy) panel.querySelector(`#resume-digit-${Math.max(0, gateDigits.findIndex(digit => !digit))}`)?.focus({ preventScroll: true });
  } else (focusedId ? document.getElementById(focusedId) : panel.querySelector(saveInfo ? '#panel-title' : '[data-action="close"]'))?.focus({ preventScroll: keepFocus });
  if (wasOpen && keepFocus) {
    panel.scrollTop = scrollTop;
    const body = panel.querySelector('.panel-body');
    if (body) body.scrollTop = bodyScrollTop;
  }
}

function selectProblem(id, { start = false, openOverScene = false, preserveConversation = openOverScene, answering = false, investigationDetail = false } = {}) {
  const nextProblem = scenario.problems.find(p => p.id === id);
  if (!nextProblem) return;
  const slideIn = !openOverScene || (current().autoOpenContinuation && current().continueTo === id);
  rememberAnswerDraft();
  if (historyView) closeHistoryScreen();
  if (!canOpenProblem(nextProblem, state)) { showInvestigation(); return; }
  if (id === scenario.investigation.id && !investigationDetail) { showInvestigation(); return; }
  answerOrigin = openOverScene ? {
    problemId: state.selected, answerId: id, repeatAnswer,
    scrollTop: document.querySelector('.chat-area').scrollTop,
    scrollLeft: document.querySelector('.chat-area .travel-guide-gallery')?.scrollLeft ?? 0,
  } : null;
  investigationView = investigationClosing = false;
  if (nextProblem.type === 'pending') composerExpanded = false;
  if (!preserveConversation && (nextProblem.answerPresentation === 'page' || nextProblem.openAnswerOnEntry === true)) composerExpanded = answering && nextProblem.openAnswerOnEntry === true;
  if (!openOverScene && nextProblem.openAnswerOnEntry === false) composerExpanded = false;
  if (!preserveConversation || state.selected !== id) {
    selectedSymbols = nextProblem.answerSlots ? [...(answerDrafts[id] ?? Array(nextProblem.answerSlots).fill(''))] : [];
    activeSymbolSlot = 0;
  }
  if (!preserveConversation || current().images !== nextProblem.images) puzzleImageIndex = 0;
  conversationPlayer.stop(); isPlaying = false;
  problemMenuExpanded = false;
  const resetBackground = !preserveConversation || (!openOverScene && nextProblem.conversationBackground === 'empty');
  if (resetBackground) resetChatFollow();
  startView = start;
  yoiEndView = false;
  repeatAnswer = answering && state.solved.includes(id);
  selectedPuzzleAnswer = id === 'N1' ? answerDrafts[id]?.[0] ?? '' : '';
  state = { ...state, selected: id };
  if (resetBackground) {
    sceneStart = latestSceneStart(state.messages, id);
    if (start || ['empty', 'investigation'].includes(nextProblem.conversationBackground) || isInvestigation(id) && answering) displayedMessages = [];
    else if (isInvestigation(id)) displayedMessages = nextProblem.dialogue.map(line => ({ ...line, kind: 'dialogue', problemId: id }));
    else if (answering) {
      // 番号から回答へ移るときは、直前の会話を背景にする。
      // 会話を挟まない小問では、さらに前の会話を引き継ぐ。
      const previous = scenario.problems.slice(0, scenario.problems.findIndex(p => p.id === id)).reverse().find(p => p.chapter === nextProblem.chapter && p.dialogue.length);
      displayedMessages = previous ? previous.dialogue.map(line => ({ ...line, kind: 'dialogue', problemId: previous.id })) : [];
    } else displayedMessages = conversationMessages(state.messages.slice(sceneStart).filter(m => m.problemId === id));
  }
  feedback = '';
  if (openOverScene && composerExpanded) {
    // 会話や案内は同じ位置に残し、回答欄だけを更新する。
    document.querySelector('.chat-area').scrollTo({ top: answerOrigin.scrollTop, behavior: 'instant' });
    const composer = document.querySelector('.composer-area');
    composer.innerHTML = composerContentMarkup(nextProblem);
    composer.hidden = composer.inert = false;
    composer.scrollTop = 0;
    updateProblemNavigation();
    const button = document.querySelector('.answer-fab');
    button.disabled = true;
    if (button.dataset?.action !== 'travel-next') button.setAttribute('aria-expanded', 'true');
    bindPuzzleSubmitLayout();
    prepareAnswerForm();
    viewportLayout.schedule();
    syncNavigation();
    save();
  } else {
    render();
  }
  if (resetBackground) document.querySelector('.chat-area').scrollTop = nextProblem.conversationBackground === 'investigation' ? investigationScrollTop : 0;
  if (!preserveConversation && displayedMessages.length) animateSurface(document.querySelector('#messages'), true, 8);
  if (start && !preserveConversation) animateSurface(document.querySelector('.start-guide'), true, 8);
  if (composerExpanded) animateSurface(document.querySelector('.composer-area'), true, slideIn ? 12 : 0);
  else if (!isPlaying) animateSurface(document.querySelector('.answer-fab'), true, 8);
  if (composerExpanded) document.querySelector('.composer-area')?.focus({ preventScroll: true });
}

function setAnswerError(incorrect) {
  answerErrorAnimation?.cancel();
  answerErrorAnimation = null;
  const form = document.querySelector('#answer-form');
  if (!form) return;
  form.classList.toggle('is-incorrect', incorrect);
  form.querySelectorAll('input:not([type="hidden"]), select, .answer-choice-trigger, .symbol-slot-fields, .answer-options').forEach(field => {
    if (incorrect) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  });
  const status = document.querySelector('#answer-error');
  if (status) status.textContent = incorrect ? '答えが違います。もう一度回答してください。' : '';
  if (!incorrect || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const fields = form.querySelector('.answer-fields, .text-composer, .answer-choice-trigger, .symbol-slot-fields, .answer-options');
  if (fields?.animate) answerErrorAnimation = fields.animate(
    [0, -6, 6, -5, 5, -2, 0].map(x => ({ transform: `translateX(${x}px)` })),
    { duration: 380, easing: 'ease-in-out' },
  );
}

function answer(value) {
  if (gateVisible) return { status: 'unavailable' };
  if (historyView) return { status: 'unavailable', problemId: state.selected };
  if (isPlaying || questionAdvanceAnimation) return { status: 'busy', problemId: state.selected };
  if (investigationView || investigationClosing) return { status: 'unavailable', problemId: state.selected };
  const problem = current();
  const wasSolved = state.solved.includes(problem.id);
  const investigationWasComplete = investigationComplete(scenario, state);
  rememberAnswerDraft();
  const start = state.messages.length;
  // スタートからは、進行を消さずにN1を再回答できる。
  const submissionState = startView || repeatAnswer ? { ...state, solved: state.solved.filter(id => id !== problem.id) } : state;
  const result = submitAnswer(scenario, submissionState, value);
  if (result.status === 'correct') {
    const milestone = !wasSolved && (problem.completionScreen || (!investigationWasComplete && investigationComplete(scenario, result.state)));
    haptics.trigger(milestone ? 'complete' : 'success');
  }
  else if (['incorrect', 'empty'].includes(result.status)) haptics.trigger('error');
  if (startView || repeatAnswer) result.state = { ...result.state, solved: [...new Set([...state.solved, ...result.state.solved])] };
  state = result.state;
  if (result.status === 'correct') { repeatAnswer = false; delete answerDrafts[problem.id]; }
  if (result.status === 'correct' && problem.advanceTo && answerOrigin) answerOrigin.answerId = state.selected;
  feedback = result.status === 'empty' ? problem.answerSlots ? `${problem.answerSlots}つすべての空欄を選択してください。` : '答えを入力・選択してください。' : '';
  save();
  if (result.status === 'incorrect') {
    if (result.response) {
      setAnswerError(false);
      playConversation(start);
      return { status: result.status, problemId: problem.id };
    }
    const feedbackArea = document.querySelector('.composer-area .feedback');
    if (feedbackArea) feedbackArea.textContent = storageWarning;
    setAnswerError(true);
    return { status: result.status, problemId: problem.id };
  }
  setAnswerError(false);
  if (result.status === 'correct' && problem.advanceTo) {
    selectedSymbols = [];
    activeSymbolSlot = 0;
    repeatAnswer = state.solved.includes(state.selected);
    composerExpanded = true;
    const composer = document.querySelector('.composer-area');
    const nextProblem = current();
    const previousComposerHeight = composer.getBoundingClientRect?.().height;
    const card = composer.querySelector?.('.start-puzzle-card');
    const copy = card?.querySelector('.puzzle-card-copy');
    const response = card?.querySelector('.puzzle-card-response');
    const compact = nextProblem.answerLayout === 'compact';
    const heading = composer.querySelector?.('.answer-composer-heading h2');
    if (problem.images && problem.images === nextProblem.images && problem.answerLayout === nextProblem.answerLayout && copy && heading && (!compact || response)) {
      // 同じ資料を使う小問では、画像のDOMと選択位置を維持して左側だけを切り替える。
      copy.innerHTML = puzzleCopyMarkup(nextProblem, !compact);
      if (compact) {
        response.innerHTML = answerFormMarkup(nextProblem);
        card.setAttribute('data-has-destination', String(Boolean(nextProblem.cardDestination)));
      }
      card.setAttribute('data-problem-id', nextProblem.id);
      card.setAttribute('aria-label', `${nextProblem.id}の問題カード`);
      heading.textContent = nextProblem.id;
      card.querySelector('.puzzle-preview')?.setAttribute('aria-label', `${nextProblem.id}の図を拡大表示`);
      const feedbackArea = composer.querySelector('.feedback');
      if (feedbackArea) feedbackArea.textContent = storageWarning;
      if (compact) {
        // display: contentsの親ではなく、表示される問題文とフォームを動かす。
        animateSurface(copy.querySelector?.('.puzzle-card-prompt'), true, 8);
        animateSurface(response, true, 8);
      } else animateSurface(copy, true, 0);
    } else {
      composer.innerHTML = composerContentMarkup(nextProblem);
      animateSurface(composer, true, 8);
    }
    updateProblemNavigation();
    composer.hidden = false;
    composer.inert = false;
    composer.scrollTop = 0;
    bindPuzzleSubmitLayout();
    prepareAnswerForm();
    animateComposerHeight(composer, previousComposerHeight);
    viewportLayout.schedule();
    document.querySelector('.answer-fab')?.setAttribute('aria-expanded', 'true');
    // 選択式の小問では候補を自動で開かず、問題パネルへフォーカスを移す。
    const focusTarget = nextProblem.answerChoices || nextProblem.answerControl === 'select'
      ? composer : document.querySelector('#answer') ?? composer.querySelector?.('#answer-form input');
    focusTarget?.focus({ preventScroll: true });
    animateQuestionAdvance(composer);
  }
  else if (result.status === 'correct') playConversation(start, { fromCorrectAnswer: true });
  else render();
  return { status: result.status, problemId: problem.id };
}

document.addEventListener('click', event => {
  const summary = event.target.closest('summary');
  if (summary?.parentElement?.matches('.history-entry, .answer-reveal:not(.hint-answer)') && toggleDisclosure(summary.parentElement, reducedMotion())) {
    event.preventDefault();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (button?.disabled || button?.closest?.('[inert]')) return;
  const action = button?.dataset.action;
  if ((!event.target.closest('.navigation-menu') && !event.target.closest('#navigation-menu')) || event.target.closest('.menu-items [data-action]')) setMenuExpanded(false);
  if (!event.target.closest('.problem-navigation')) setProblemMenuExpanded(false);
  if (!button) return;
  if (['toggle-menu', 'toggle-problems', 'open-composer', 'travel-found', 'close-composer', 'select', 'investigation-closing', 'investigation-back', 'investigation-next', 'yoi-next', 'continue-at-venue', 'continue-online', 'history', 'history-back', 'hints', 'clues'].includes(action)) haptics.trigger();
  if (action === 'hex-open') {openHexCube();return;}
  if (action === 'hex-save-retry') {if(!miniSaving){miniSaving=true;void confirmHexReward().finally(()=>{miniSaving=false;});}return;}
  if (action === 'hex-card') {clueTab='cards';expandedCharacter=null;openPanel('clues');bindClueCarousel(4);return;}
  if (action === 'toggle-haptics') {
    haptics.setEnabled(!haptics.enabled);
    button.setAttribute('aria-pressed', String(haptics.enabled));
    button.textContent = `操作時の振動：${haptics.enabled ? 'オン' : 'オフ'}`;
    if (haptics.enabled) haptics.trigger();
    return;
  }
  if (action === 'save-continue') {
    if (gateBusy) return;
    if (localRecord?.state || playSaves.getRecord()?.state || legacyState) {
      gateInput = false;
      void beginPlay('continue');
    } else {
      gateInput = true;
      gateError = '';
      openPanel('resume');
    }
    return;
  }
  else if (action === 'save-new') { if (localRecord || legacyState || playSaves.getRecord()?.code && playSaves.getRecord().code !== '000000') { gateError = ''; renderEntry(); openPanel('reset'); } else void beginPlay('new'); return; }
  else if (action === 'save-entry-back') { closePanel(); return; }
  else if (action === 'save-start') {
    if (playSaves.getStatus().phase === 'conflict') return;
    closePanel();
    if (startView && !state.solved.length) setComposerExpanded(true);
    return;
  }
  else if (action === 'save-copy') {
    const code = normalizePlayCode(playSaves.getRecord()?.code);
    if (!code) return;
    const message = panel.querySelector('[data-copy-feedback]');
    const revision = panelRevision;
    void copyWithFeedback({ code, button, message, writeText: value => window.navigator.clipboard.writeText(value),
      isCurrent: () => panel.open && panelRevision === revision && normalizePlayCode(playSaves.getRecord()?.code) === code,
      checkIcon: icon('check'), copyIcon: icon('copy'), reduced: reducedMotion(), onSuccess: () => haptics.trigger() });
    return;
  }
  else if (action === 'save-title') {
    save(); conversationPlayer.stop(); isPlaying = false; closePanel();
    gateVisible = true; gateInput = false; gateError = ''; gateCode = ''; gateDigits = Array(6).fill('');
    const leavingDebug = playSaves.getStatus().mode === 'debug';
    if (leavingDebug) playSaves.leaveSession();
    localRecord = playSaves.getRecord() ?? playSaves.readLocal();
    renderEntry();
    if (!leavingDebug) void playSaves.flush();
    return;
  }
  else if (action === 'save-entry') {
    save(); conversationPlayer.stop(); isPlaying = false; closePanel(); gateVisible = true; gateInput = true; gateError = ''; gateCode = ''; gateDigits = Array(6).fill(''); playSaves.leaveSession(); localRecord = playSaves.readLocal(); renderEntry(); return;
  }
  else if (action === 'save-retry') { void playSaves.retry().then(() => openPanel('save-info')).catch(error => { gateError = error.message; openPanel('save-info'); }); return; }
  else if (action === 'save-delete') {
    if (saveMutationBusy) return;
    saveMutationBusy = true;
    button.disabled = true;
    conversationPlayer.stop(); isPlaying = false;
    void playSaves.deleteCurrent().then(deleted => { if (!deleted) { openPanel('save-info'); return; } conversationPlayer.stop(); isPlaying = false; legacyState = null; localRecord = null; gateVisible = true; gateInput = true; gateError = ''; closePanel(); renderEntry(); }).catch(error => { gateError = error.message; openPanel('save-info'); }).finally(() => { saveMutationBusy = false; }); return;
  }
  else if (action === 'toggle-menu') setMenuExpanded(!menuExpanded);
  else if (action === 'investigation-closing' && canReadInvestigationClosing()) {
    investigationClosing = true;
    render();
  }
  else if (action === 'investigation-back') showInvestigation();
  else if (action === 'investigation-open') openInvestigationProblem(button.dataset.id);
  else if (action === 'investigation-next' && investigationView && investigationComplete(scenario, state)) {
    investigationScrollTop = document.querySelector('.chat-area').scrollTop;
    selectProblem(scenario.investigation.next, { answering: true });
  }
  else if (action === 'close-menu') setMenuExpanded(false);
  else if (action === 'toggle-problems') setProblemMenuExpanded(!problemMenuExpanded);
  else if (action === 'history') openHistoryScreen();
  else if (action === 'history-back') closeHistoryScreen();
  else if (action === 'chat') { if (historyView) closeHistoryScreen(); closePanel(); document.querySelector('.menu-button')?.focus({ preventScroll: true }); }
  else if (action === 'yoi-end' && state.solved.includes(scenario.problems.find(p => p.completionScreen === 'yoi')?.id)) {
    composerExpanded = false; selectProblem(scenario.problems.find(p => p.completionScreen === 'yoi').id);
    yoiEndView = true; resetChatFollow(); render();
    document.querySelector('#yoi-completion-title')?.focus({ preventScroll: true });
    animateSurface(document.querySelector('.yoi-completion'), true, 8);
  }
  else if (action === 'yoi-page-turn' && awaitingYoiPageTurn()) openPanel('yoi-page-turn');
  else if (action === 'yoi-next' && awaitingYoiPageTurn() && panel.open && panel.dataset.kind === 'yoi-page-turn') {
    closePanel();
    yoiEndView = true; resetChatFollow(); render();
    document.querySelector('#yoi-completion-title')?.focus({ preventScroll: true });
    animateSurface(document.querySelector('.yoi-completion'), true, 8);
  }
  else if (['continue-at-venue', 'continue-online'].includes(action) && yoiEndView && state.solved.includes(current().id)) {
    showVenueDirections = action === 'continue-at-venue';
    composerExpanded = false;
    selectProblem('Q1', { preserveConversation: true, answering: true });
    document.querySelector('.chat-area')?.focus?.({ preventScroll: true });
    showChapterTransition();
  }
  else if (action === 'start-answer-confirm' && startView && !isPlaying && panel.open && panel.classList.contains('start-answer-dialog')) {
    closePanel();
    composerExpanded = true;
    selectProblem(state.selected, { start: true, openOverScene: true, answering: true });
  }
  else if (action === 'travel-next' && showsGuideStop(current()) && !composerExpanded) {
    haptics.trigger('pageTurn');
    openPanel('travel-next');
  }
  else if ((action === 'open-composer' || action === 'travel-found') && !isPlaying && !composerExpanded) {
    if (action === 'travel-found') {
      if (!panel.open || panel.dataset.kind !== 'travel-next' || !showsGuideStop(current())) return;
      closePanel();
    }
    if (startView) { openPanel('start-answer'); return; }
    const next = !startView && !repeatAnswer && state.solved.includes(state.selected)
      ? followingProblem(current()) : null;
    if (action === 'travel-found' && next?.openAnswerOnEntry === false) {
      selectProblem(next.id, { answering: true });
      setComposerExpanded(true);
      return;
    }
    composerExpanded = true;
    const id = answerOrigin?.problemId === state.selected ? answerOrigin.answerId : next?.id ?? state.selected;
    selectProblem(id, { openOverScene: true, answering: true, investigationDetail: isInvestigation() });
  }
  else if (action === 'close-composer') closeAnswerArea();
  else if (action === 'start') { composerExpanded = false; selectProblem('N1', { start: true }); }
  else if (action === 'select') { composerExpanded = true; selectProblem(button.dataset.id, { answering: true }); }
  else if (action === 'travel-image') {
    const index = Number(button.dataset.index);
    openPanel('travel-image', { travelId: button.dataset.id, travelIndex: index, imageTrigger: button });
  }
  else if (action === 'image-zoom-in') imageViewer?.zoom(.5);
  else if (action === 'image-zoom-out') imageViewer?.zoom(-.5);
  else if (action === 'image-zoom-reset') imageViewer?.zoom(0);
  else if (action === 'puzzle-page') setPuzzleImage(Number(button.dataset.index));
  else if (action === 'symbol-slot') {
    const index = Number(button.dataset.index);
    if (Number.isInteger(index) && index >= 0 && index < symbolSlotValues(current()).length) {
      activeSymbolSlot = index;
      openPanel('symbol-choices');
    }
  }
  else if ((action === 'choose-symbol' || action === 'kana-delete') && panel.open && panel.dataset.kind === 'symbol-choices') {
    const p = current();
    const word = p.fields?.find(field => field.kanaChoices);
    const values = symbolSlotValues(p);
    const deleting = action === 'kana-delete';
    if (deleting) {
      if (!word) return;
      if (!values[activeSymbolSlot]) {
        const previous = values.findLastIndex((value, index) => value && index < activeSymbolSlot);
        activeSymbolSlot = previous >= 0 ? previous : Math.max(0, values.findLastIndex(Boolean));
      }
    } else if (!(word?.kanaChoices ?? p.symbolChoices)?.includes(button.dataset.id)) return;
    haptics.trigger();
    setAnswerError(false);
    const value = deleting ? '' : button.dataset.id;
    values[activeSymbolSlot] = value;
    if (word) {
      // Preserve empty positions in a partially filled word when the panel is reopened.
      document.querySelector('#deduction-word').value = values.map(letter => letter || ' ').join('').trimEnd();
    } else {
      selectedSymbols = values;
      document.querySelector('#answer').value = values.join('');
    }
    rememberAnswerDraft(); save();
    const slot = document.querySelector(`#symbol-slot-${activeSymbolSlot}`);
    if (slot) {
      slot.textContent = value || '—';
      slot.setAttribute('data-filled', String(Boolean(value)));
      slot.setAttribute('aria-label', `${activeSymbolSlot + 1}文字目を選択：${value || '未選択'}`);
      animateSurface(slot, true, 4);
    }
    const complete = values.every(Boolean);
    const submit = document.querySelector('.puzzle-symbol-answer button[type="submit"]');
    if (!word && submit) submit.disabled = !complete;
    updateAnswerReadiness({ feedback: true });
    if (complete) closePanel();
    else {
      if (!deleting) activeSymbolSlot = values.findIndex(letter => !letter);
      openPanel('symbol-choices');
    }
  }
  else if (action === 'choose-answer') {
    const option = current().options?.find(item => item.id === button.dataset.id);
    if (option) {
      haptics.trigger();
      setAnswerError(false);
      selectedPuzzleAnswer = option.id;
      rememberAnswerDraft(); save();
      document.querySelector('#answer').value = option.id;
      document.querySelector('#answer-choice-label').innerHTML = answerChoiceMarkup(option);
      animateSurface(document.querySelector('#answer-choice-label'), true, 4);
      updateAnswerReadiness({ feedback: true });
      closePanel();
    }
  }
  else if (action === 'character-open' && clueTab === 'characters') {
    const index = Number(button.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index > 3) return;
    const sourceRect = button.getBoundingClientRect?.();
    expandedCharacter = index;
    haptics.trigger();
    openPanel('clues');
    panel.querySelector('.clue-carousel')?.focus({ preventScroll: true });
    animateCharacterCard(panel.querySelector('.clue-gallery-card[aria-current="true"]'), sourceRect);
  }
  else if (action === 'character-dismiss' && !event.target.closest('.clue-gallery-card')) {
    closeCharacterPreview();
  }
  else if (action === 'clue-tab' && ['cards', 'characters', 'combine'].includes(button.dataset.tab)) {
    switchClueTab(button.dataset.tab);
  }
  else if (['hints', 'clues', 'trouble', 'save-info', 'save-delete-confirm', 'puzzle-image', 'answer-choices'].includes(action)) {
    if (action === 'clues') { clueTab = 'cards'; expandedCharacter = null; }
    openPanel(action);
  }
  else if (action === 'close') closePanel();
  else if (action === 'continue-conversation') {
    resetChatFollow(); updateConversationNotice(); scrollConversationToEnd(true);
  }
  else if (action === 'novel-next' && isPlaying && novelPlayback && !historyView && !gateVisible) {
    advanceNovel();
    haptics.trigger(panel.open && panel.classList.contains('page-turn-dialog') ? 'pageTurn' : 'dialogue');
  }
  else if (action === 'replay' && !isPlaying) playConversation(latestSceneStart(state.messages, state.selected));
  else if (action === 'next' && !isPlaying) { composerExpanded = false; selectProblem(followingProblem(current())?.id); }
  else if (action === 'branch' && !isPlaying) {
    const start = state.messages.length;
    const next = chooseBranch(scenario, state, state.selected, button.dataset.id);
    if (next !== state) { state = next; save(); playConversation(start); }
  }
  else if (action === 'confirm-reset') {
    closePanel();
    if (playSaves.getStatus().mode === 'debug') {
      enterPlay(playSaves.enterDebug(initialState(scenario), restorePlayView(scenario, initialState(scenario), null)));
    } else {
      save(); conversationPlayer.stop(); isPlaying = false;
      gateVisible = true; gateInput = true;
      void beginPlay('new');
    }
  }
});
for (const name of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) {
  document.addEventListener(name, () => {
    if (name.startsWith('pointer')) chatPointerDown = false;
    else chatTouchDown = false;
    resumeChatFollowIfAtBottom();
  }, { passive: true });
}
document.addEventListener('keydown', event => {
  if (event.target?.dataset?.action === 'clue-tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = ['cards', 'characters', 'combine'];
    const index = tabs.indexOf(clueTab);
    switchClueTab(tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]);
    return;
  }

  if (event.key === 'Enter' && event.target?.closest?.('#answer-form')) {
    if (isComposingSubmit(event, composingAnswer, compositionEndedAt)) return;
    if (event.target.matches?.('input[type="text"]')) {
      event.preventDefault();
      const form = event.target.closest('#answer-form');
      const fields = [...form.querySelectorAll('input[type="text"], select')];
      const next = fields[fields.indexOf(event.target) + 1];
      if (next) { next.focus({ preventScroll: true }); viewportLayout.schedule(); }
      else form.requestSubmit();
      return;
    }
  }
  const resumeIndex = event.target?.dataset?.resumeDigit;
  if (resumeIndex !== undefined && !gateBusy && !event.isComposing) {
    const index = Number(resumeIndex);
    if (event.key === 'Backspace' && !event.target.value && index > 0) {
      event.preventDefault();
      setResumeDigits(index - 1, '');
    } else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      panel.querySelector(`#resume-digit-${Math.max(0, Math.min(5, index + (event.key === 'ArrowLeft' ? -1 : 1)))}`)?.focus({ preventScroll: true });
    }
  }
  if (panel.open && panel.classList.contains('image-gallery') && (imageViewer?.scale ?? 1) === 1 && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    setPuzzleImage(puzzleImageIndex + (event.key === 'ArrowLeft' ? -1 : 1));
    return;
  }
  if (event.key !== 'Escape' || panel.open) return;
  if (historyView) { closeHistoryScreen(); return; }
  if (problemMenuExpanded) {
    setProblemMenuExpanded(false); document.querySelector('.problem-toggle')?.focus({ preventScroll: true });
  } else if (menuExpanded) {
    setMenuExpanded(false); document.querySelector('.menu-button')?.focus({ preventScroll: true });
  } else if (composerExpanded) closeAnswerArea();
});
for (const name of ['input', 'change']) {
  document.addEventListener(name, event => {
    if (name === 'change' && event.target.matches?.('select, input[type="radio"], input[type="checkbox"]') && event.target.closest('#answer-form, #combine-form')) haptics.trigger();
    if (event.target.closest('#answer-form')) { setAnswerError(false); updateAnswerReadiness({ feedback: true }); rememberAnswerDraft(); save(); }
    if (name === 'input' && event.target.dataset?.resumeDigit !== undefined && !event.isComposing) setResumeDigits(Number(event.target.dataset.resumeDigit), event.target.value);
  });
}
document.addEventListener('compositionstart', event => {
  if (event.target.closest?.('#answer-form')) { composingAnswer = true; compositionEndedAt = null; }
});
document.addEventListener('compositionend', event => {
  if (event.target.closest?.('#answer-form')) { composingAnswer = false; compositionEndedAt = Date.now(); updateAnswerReadiness({ feedback: true }); rememberAnswerDraft(); save(); }
  if (event.target.dataset?.resumeDigit !== undefined) setResumeDigits(Number(event.target.dataset.resumeDigit), event.target.value);
});
document.addEventListener('focusin', event => {
  if (!event.target.closest?.('#answer-form')) { composingAnswer = false; compositionEndedAt = null; }
  if (event.target.dataset?.resumeDigit !== undefined) event.target.select();
});
document.addEventListener('paste', event => {
  if (event.target.dataset?.resumeDigit === undefined || gateBusy) return;
  const text = event.clipboardData?.getData('text');
  if (!text) return;
  event.preventDefault();
  setResumeDigits(Number(event.target.dataset.resumeDigit), text);
});
document.addEventListener('submit', event => {
  if (event.target.id === 'resume-form') {
    event.preventDefault();
    if (gateBusy) return;
    gateCode = gateDigits.join('');
    void beginPlay('code', gateCode);
  } else if (event.target.id === 'answer-form') {
    event.preventDefault();
    if (isComposingSubmit(event, composingAnswer, compositionEndedAt) || Date.now() < submissionLockedUntil) return;
    if (!updateAnswerReadiness({ highlight: true })) { haptics.trigger('error'); return; }
    submissionLockedUntil = Date.now() + 350;
    const form = event.target;
    const submit = form.querySelector('[type="submit"]');
    if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); }
    setTimeout(() => { if (submit?.isConnected) { submit.disabled = false; submit.removeAttribute('aria-busy'); } }, 350);
    const data = new FormData(event.target);
    answer(current().type === 'text' ? data.get('answer') : data.getAll('answer'));
  } else if (event.target.id === 'combine-form') {
    event.preventDefault();
    if (event.target.inert) return;
    const ids = new FormData(event.target).getAll('card');
    const result = findCombination(scenario, ids);
    if (!result) {
      haptics.trigger('error');
      const message = document.querySelector('#combine-feedback');
      message.textContent = ids.length !== 2 ? '手がかりを2枚選んでください。' : 'この組み合わせからは、まだ新しい情報を見つけられません。';
      animateSurface(message, true, 4);
      return;
    }
    if (!state.combinations.includes(result.id)) state.combinations.push(result.id);
    haptics.trigger('success');
    save();
    const form = event.target;
    const revision = panelRevision;
    const cards = [...panel.querySelectorAll('.evidence-card:has(input:checked)')];
    const motion = animateCombination(cards, reducedMotion());
    const reveal = () => {
      form.inert = false;
      if (panel.open && panelRevision === revision) openPanel('clues', { keepFocus: true, revealSelector: `[data-finding-id="${result.id}"]` });
    };
    if (motion) { form.inert = true; void motion.then(reveal); }
    else reveal();
  }
});
panel.addEventListener('click', event => { const rect = panel.getBoundingClientRect(); if (event.target === panel && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closePanel(); });
panel.addEventListener('cancel', event => { event.preventDefault(); closePanel(); });
let browserStorage;
try { browserStorage = window.localStorage; } catch { browserStorage = null; }
playSaves = createPlaySaveController({ scenarioId: scenario.id, storage: browserStorage,
  debounceMs: 2400, onStatus: updateSaveStatus,
  onCloudRestore(record) {
    localRecord = record;
    if (record && !gateVisible) { gateError = ''; enterPlay(record); }
    else if (!record) {
      conversationPlayer.stop(); closePanel();
      gateVisible = true; gateInput = false; gateBusy = false;
      renderEntry();
    }
  },
});
localRecord = playSaves.readLocal();
if (!localRecord) {
  try {
    const raw = browserStorage?.getItem(`${storageKey}:migrated`) ? null : browserStorage?.getItem(storageKey);
    const parsed = JSON.parse(raw);
    if ([1, 2].includes(parsed?.version) && Array.isArray(parsed?.messages) && Array.isArray(parsed?.solved)) legacyState = restoreState(scenario, raw);
  } catch { /* 保存できない環境でも番号入力とデバッグを利用できる。 */ }
}
window.addEventListener('online', () => { if (!gateVisible && playSaves.getStatus().mode !== 'debug') void playSaves.retry(); });
window.addEventListener('storage', event => playSaves.handleStorageEvent(event));
window.addEventListener('pagehide', () => { haptics.cancel(); rememberAnswerDraft(); save(); if (!gateVisible) void playSaves.flush(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { haptics.cancel(); rememberAnswerDraft(); save(); if (!gateVisible) void playSaves.flush(); } });
// Bootstrap once: explicit title navigation later still stays on the title.
if(requestedMinigame&&!localRecord&&!legacyState)gateInput=true;
const startup = localRecord || legacyState
  ? beginPlay('continue', '', { automatic: true })
  : Promise.resolve(render());

// ブラウザが対応している場合だけ、画面と同じ操作をWebMCPへ登録します。
const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const tool = { name: 'submit_puzzle_answer', title: '謎の答えを送る', description: '現在選択中の問題に回答し、正誤判定と会話の更新を行います。選択問題には選択肢IDの配列、複数入力欄の問題には画面の順に文字列の配列を渡します。', inputSchema: { type: 'object', properties: { answer: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] } }, required: ['answer'], additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute(input) {
    if (!input || Object.keys(input).some(k => k !== 'answer') || !(typeof input.answer === 'string' || Array.isArray(input.answer) && input.answer.every(a => typeof a === 'string'))) throw new Error('答えの形式が正しくありません。');
    if (investigationView || current().type === 'pending') return { status: 'unavailable', problemId: state.selected };
    if (current().type === 'text' ? typeof input.answer !== 'string' : !Array.isArray(input.answer) || (current().type === 'fields' ? input.answer.length !== current().fields.length : input.answer.some(a => !current().options.some(o => o.id === a)))) throw new Error('問題の回答形式に合わせてください。');
    return answer(input.answer);
  } };
  try { Promise.resolve(modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(() => {}); } catch { /* 対応状況により登録できない場合も、画面の操作は利用できます。 */ }
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
}
