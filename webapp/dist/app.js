import { scenario } from './scenario.js';
import { initialState, restoreState, submitAnswer, chooseBranch, unlockedCards, unlockedGalleryCards, findCombination, canOpenProblem, investigationComplete, availableNavigationProblems, completeMinigame, minigameReward, readMinigameEntry, normalizeAnswer } from './engine.js';
import { createConversationPlayer, latestSceneStart } from './conversation.js';
import { createPlaySaveController, normalizePlayCode } from './play-save.js';
import { isConversationLine, restorePlayView, pendingConversation, sanitizeAnswerDraft } from './save-view.js';
import { createOverlayHistory } from './navigation.js';
import { bindVisualViewport } from './viewport.js';
import { MOTION, createHaptics, answerReadiness, isComposingSubmit, bindImageViewer, bindSheetDismiss } from './interaction.js';
import { animateEmphasis, toggleDisclosure, copyWithFeedback } from './feedback.js';

const app = document.querySelector('#app');
const panel = document.querySelector('#panel');
const SURVEY_ENDPOINT = 'https://docs.google.com/forms/d/e/1FAIpQLSc15TibCS9BSs688NeI48xmV5tAC8PyO-plPsvPZod5IKey9w/formResponse';
const CONTACT_ENDPOINT = '/api/contact';
const SURVEY_ENTRIES = { code: 'entry.1334614969', progress: 'entry.1146454153', affiliation: 'entry.20256359', yoiVolume: 'entry.663390734', yoiDifficulty: 'entry.2109384794', meiVolume: 'entry.2071052292', meiDifficulty: 'entry.1089849868', ending: 'entry.629875828', feedback: 'entry.1851684099' };
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
let surveyStatus = 'idle';
let contactStatus = 'idle';
let surveyScaleDrag = null;
let answerErrorAnimations = [];
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
let hintTab = '';
let lastClueBadgeCount = 0;
let miniView=null, miniSaving=false, miniRewardAlready=false, hexReturnToChat=false, parkedMiniHost=null, hintContext=null;
let pendingReward = null;
let combineOutcome = null;
let combineOutcomeDialog = null;
let combineOutcomeClosing = false;
let playSessionRevision=0;
let requestedMinigame=readMinigameEntry(window.location?.href);
// 入場用のクエリは一度だけ使い、読み込み直しでミニゲームが勝手に開かないように履歴から除く。
if (requestedMinigame) {
  try {
    const entryUrl = new URL(window.location.href);
    entryUrl.searchParams.delete('minigame');
    window.history?.replaceState?.(null, '', entryUrl);
  } catch { /* URLを書き換えられない環境ではそのまま使う。 */ }
}
let expandedCharacter = null;
let expandedClueId = null;
let seenClueIds = new Set();
let combineSelection = [];
let combineReplaceAt = null;
let combinePicker = false;
let combineSelecting = false;
let combineSuppressCard = null;
let combineSuppressUntil = 0;
let combineSuppressPointer = null;
let historyChatScrollTop = 0;
let historyScrollTop = 0;
let historyOpenProblems = new Set();
let selectedPuzzleAnswer = '';
let selectedSymbols = [];
let activeSymbolSlot = 0;
let puzzleImageIndex = 0;
let q9GuideSeen = false;
let q9GuideIndex = 0;
let composerExpanded = false;
let answerOrigin = null;
let menuExpanded = false;
let problemMenuExpanded = false;
let startView = true;
let yoiEndView = false;
let meiEndRoute = null;
let meiEndView = false;
let meiPlayChoiceVisible = false;
let pageTurnRevealed = false;
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
let epiloguePhase = null;
let shownSceneArt = '';
let pageTurnSceneArmed = false;
let epilogueToken = 0;
let epilogueTimer = 0;
let epilogueFading = false;
let epilogueAfterBlackout = false;
let epilogueBlackoutReady = false;
let epilogueBlackoutActive = false;
let epilogueEnteredFromBlack = false;
const epilogueSceneArt = {
  hallway: '../assets/endings/b-hallway.webp',
  library: '../assets/endings/b-library.webp',
  bookstore: '../assets/endings/b-bookstore.webp',
  ginkgo: '../assets/endings/b-ginkgo.webp',
  riverside: '../assets/endings/c-riverside.webp',
  ward: '../assets/endings/c-hospital.webp',
  dusk: '../assets/endings/c-dusk.webp',
};
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
  updateHeaderActions();
}

function dismissTopSurface() {
  if (panel.open) return closePanel();
  if (historyView) return closeHistoryScreen();
  if (investigationClosing) return showInvestigation();
  if (problemMenuExpanded) { setProblemMenuExpanded(false); document.querySelector('.problem-toggle')?.focus({ preventScroll: true }); }
  else if (menuExpanded) { setMenuExpanded(false); document.querySelector('.menu-button')?.focus({ preventScroll: true }); }
  else if (composerExpanded) answerAreaBack();
}

const chatIsBeingHandled = () => chatPointerDown || chatTouchDown || chatWheelActive;
const chatIsAtBottom = chat => chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 32;

function updateConversationNotice() {
  const notice = document.querySelector('#conversation-notice');
  if (!notice) return;
  if (!unreadConversationCount) {
    if (notice.hidden || surfaceAnimations.has(notice)) return;
    if (!notice.animate || reducedMotion()) { notice.hidden = true; return; }
    animateFade(notice, false).then(finished => { if (finished && !unreadConversationCount) notice.hidden = true; });
    return;
  }
  const grew = !notice.hidden && !surfaceAnimations.has(notice) && unreadConversationCount > noticeCount;
  surfaceAnimations.get(notice)?.cancel();
  notice.hidden = false;
  noticeCount = unreadConversationCount;
  const label = `↓ 続きの会話（${unreadConversationCount}）`;
  if (notice.textContent !== label) notice.textContent = label;
  if (grew) animateEmphasis(notice, reducedMotion());
}
let noticeCount = 0;

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

function clearTypingIndicator() {
  document.querySelector('.typing-message')?.remove();
}

// 次の連絡を待つ間だけ、小さな三点バブルを置く。再生の中断や自分の回答では消す。
function showTypingIndicator(message) {
  clearTypingIndicator();
  const host = document.querySelector('#messages');
  if (!host || !message || ['answer', 'success', 'error'].includes(message.kind) || reducedMotion()) return;
  host.insertAdjacentHTML('beforeend', '<div class="message typing-message" aria-hidden="true"><div class="message-body"><div class="bubble typing-bubble"><i></i><i></i><i></i></div></div></div>');
  host.lastElementChild.classList.add('message-enter');
  if (followChat && !chatIsBeingHandled()) scrollConversationToEnd();
}

const conversationPlayer = createConversationPlayer({
  onMessage(message) {
    displayedMessages.push(message);
    save();
    const markup = messageMarkup(message);
    if (!markup) return;
    const messages = document.querySelector('#messages');
    clearTypingIndicator();
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
  onWait: showTypingIndicator,
  onComplete: finishConversation,
});

function meiEndingReady() {
  const problem = current();
  const branch = problem?.answerBranches?.find(item => item.id === state.branches?.[problem.id]);
  if (problem?.id !== 'Q9' || !branch) return false;
  const shown = displayedMessages.filter(message => message.problemId === 'Q9' && message.kind === 'dialogue');
  return shown.length >= branch.dialogue.length && shown.at(-1)?.text === branch.dialogue.at(-1).text;
}

function finishConversation({ scroll = true } = {}) {
  isPlaying = false;
  epiloguePhase = null;
  cancelEpilogueMotion();
  if (meiEndingReady()) {
    meiEndView = true;
    meiEndRoute = state.branches.Q9;
  }
  save();
  render({ scroll });
  const pageTurnOpened = openFinishedPageTurn();
  if (meiEndView) document.querySelector('#mei-completion-title')?.focus({ preventScroll: true });
  else if (yoiEndView) document.querySelector('#yoi-completion-title')?.focus({ preventScroll: true });
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

function preloadImageSources(sources) {
  if (typeof Image === 'undefined') return;
  for (const src of sources) {
    if (!src || preloadedSceneSources.has(src)) continue;
    preloadedSceneSources.add(src);
    const image = new Image();
    image.src = src;
    image.decode().catch(() => preloadedSceneSources.delete(src));
  }
}

function preloadSceneImages(scene = [], problem = current()) {
  const sources = new Set();
  for (const line of scene) {
    for (const name of (line.speaker || '').split('＆')) {
      const portrait = scenario.portraits?.[name];
      if (portrait) sources.add(portrait);
    }
    if (line.appear && scenario.portraits?.[line.appear]) sources.add(scenario.portraits[line.appear]);
    if (line.background) sources.add(line.background);
    if (epilogueSceneArt[line.scene]) sources.add(epilogueSceneArt[line.scene]);
  }
  for (const step of problem?.travelGuide?.steps ?? []) {
    if (step.preview) sources.add(step.preview);
    if (step.image) sources.add(step.image);
  }
  preloadImageSources(sources);
}

// タイトルや再開の待ち時間に、最初に映る画面の画像を先読みしておく。
function warmupEntryImages() {
  const problemId = localRecord?.state?.selected ?? legacyState?.selected ?? null;
  const problem = scenario.problems.find(p => p.id === problemId) ?? scenario.problems[0];
  preloadSceneImages(problem?.dialogue ?? [], problem);
  if (!problemId) preloadImageSources(['../assets/menu-guide-annotated.webp', ...Object.values(scenario.portraits ?? {})]);
}

function cancelEpilogueMotion() {
  epilogueToken += 1;
  epilogueFading = false;
  epilogueAfterBlackout = false;
  epilogueBlackoutReady = false;
  epilogueBlackoutActive = false;
  epilogueEnteredFromBlack = false;
  clearTimeout(epilogueTimer);
}

function resumeEpiloguePhase(displayed, remaining) {
  if (!isPlaying) return null;
  if (displayed.at(-1)?.epilogue) return 'line';
  // 場面付きの結末も、ルートAと同じく題字から始める。
  if (!displayed.length && remaining[0]?.epilogue) return 'title';
  return null;
}

function sakuraFallMarkup() {
  const petals = [
    [4, 18, 15, -3, 34, .9], [13, 13, 18, -11, -26, .78], [22, 24, 16, -7, 30, .62],
    [31, 16, 13, -9, -36, .92], [40, 12, 17, -2, 18, .84], [48, 22, 20, -14, -22, .58],
    [57, 15, 14, -6, 40, .86], [66, 26, 19, -4, -32, .55], [73, 14, 12, -8, 24, .9],
    [81, 20, 17, -12, -28, .7], [89, 16, 15, -1, 32, .82], [17, 11, 21, -16, 16, .94],
    [53, 19, 16, -5, -38, .74], [95, 13, 14, -10, -18, .86], [36, 28, 22, -18, 20, .5],
  ];
  const marks = petals.map(([x, size, duration, delay, drift, opacity]) =>
    `<span class="sakura-petal" style="--x:${x}%;--s:${size}px;--d:${duration}s;--delay:${delay}s;--drift:${drift}px;--o:${opacity}"></span>`).join('');
  return `<div class="sakura-fall" aria-hidden="true">${marks}</div>`;
}

function syncPlayChrome() {
  const header = document.querySelector('.play-header');
  const workspace = document.querySelector('.workspace');
  const height = header?.offsetHeight;
  if (workspace?.style && Number.isFinite(height)) workspace.style.setProperty('--play-header-height', `${height}px`);
}

// Covers sit inside the workspace, under the header. The test harness has no child list and keeps the cover beside the workspace.
function mountWorkspaceCover(html) {
  const workspace = document.querySelector('.workspace');
  if (workspace?.children) workspace.insertAdjacentHTML('beforeend', html);
  else workspace?.insertAdjacentHTML('afterend', html);
}

function lockPlayContent(locked) {
  const workspace = document.querySelector('.workspace');
  if (workspace) workspace.inert = false;
  if (!workspace?.children) return;
  for (const child of workspace.children) {
    if (child.classList?.contains('play-header')) continue;
    if (locked) child.setAttribute?.('inert', '');
    else child.removeAttribute?.('inert');
  }
}

function epilogueLineMarkup(line) {
  const text = typeof line === 'string' ? line : line?.text;
  // 句点だけを改行にし、文の途中は行の端まで続ける。「変わらぬ空。」のあとと、末尾の閉じ括弧の前では改行しない。
  const body = esc(text ?? '').replace(/。(?!(?:[」』])?$)/g, (mark, index, source) => source.endsWith('変わらぬ空。', index + 1) ? '。' : '。<br>');
  const speaker = typeof line === 'string' || !line?.speaker ? '' : `<span class="epilogue-speaker">${esc(line.speaker)}</span>`;
  return speaker + body;
}

function epilogueMarkup() {
  if (epiloguePhase === 'title') {
    const routeId = state.branches?.[state.selected];
    const mark = MEI_ENDING_MARKS[routeId];
    const caption = MEI_ENDING_TITLES[routeId];
    const script = `Epilogue${mark ? ` : ${mark}` : ''}`;
    const label = caption ? `${script}「${caption}」` : script;
    const heading = caption ? `<span class="epilogue-heading" aria-hidden="true">${esc(`「${caption}」`)}</span>` : '';
    return `<button type="button" class="epilogue-screen is-title" data-action="epilogue-next" aria-label="${esc(label)}"><span class="epilogue-backdrop" aria-hidden="true"></span><span class="epilogue-title-card"><span class="epilogue-script" aria-hidden="true">${esc(script)}</span>${heading}</span></button>`;
  }
  const line = displayedMessages.findLast(message => message.epilogue);
  const background = line?.background || epilogueSceneArt[line?.scene] || '';
  const scene = background ? ' has-scene' : '';
  const appear = line?.appear ? ' has-appear' : '';
  const image = background ? ` style="background-image:url('${esc(background)}')"` : '';
  const veil = epilogueEnteredFromBlack && background ? '<span class="epilogue-veil" aria-hidden="true"></span>' : '';
  const portrait = scenario.portraits?.[line?.appear];
  const figure = portrait ? `<span class="epilogue-appear" aria-hidden="true"><img src="${esc(portrait)}" alt=""></span>` : '';
  return `<button type="button" class="epilogue-screen is-line${scene}${appear}" data-action="epilogue-next"${image}>${figure}<span class="epilogue-line">${epilogueLineMarkup(line)}</span><span class="epilogue-cue" aria-hidden="true">▷</span>${veil}<span class="sr-only">読み進める</span></button>`;
}

function fitEpilogueTitle(script) {
  const max = Math.min(window.innerWidth, 480) - 64;
  let size = 56;
  script.style.fontSize = `${size}px`;
  while (size > 32 && script.scrollWidth > max) {
    size -= 2;
    script.style.fontSize = `${size}px`;
  }
}

function fadeEpilogueTitle(token) {
  if (epilogueFading || token !== epilogueToken || epiloguePhase !== 'title') return;
  epilogueFading = true;
  clearTimeout(epilogueTimer);
  const card = document.querySelector('.epilogue-title-card') ?? document.querySelector('.epilogue-script');
  const showLine = () => {
    if (token !== epilogueToken || epiloguePhase !== 'title') return;
    epilogueTimer = window.setTimeout(() => {
      if (token !== epilogueToken || epiloguePhase !== 'title') return;
      epilogueFading = false;
      advanceNovel();
    }, reducedMotion() ? 0 : 180);
  };
  if (!card || reducedMotion()) { showLine(); return; }
  card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 640, easing: 'ease', fill: 'forwards' })
    .finished.then(showLine, showLine);
}

function beginEpilogueTitle() {
  const screen = document.querySelector('.epilogue-screen');
  const script = screen?.querySelector('.epilogue-script');
  if (screen?.dataset.started === 'true') return;
  const token = ++epilogueToken;
  epilogueFading = false;
  clearTimeout(epilogueTimer);
  if (!screen || !script) {
    // 描画を待てない環境でも、題字を読む間だけは置いてから先へ進める。
    epilogueTimer = window.setTimeout(() => fadeEpilogueTitle(token), reducedMotion() ? 0 : 1600);
    return;
  }
  screen.dataset.started = 'true';
  // 幕の地は最初から塗る。透けるアニメーションは題字だけに掛ける。
  screen.style.opacity = '1';
  if (!reducedMotion()) screen.classList.add('is-entering');
  const start = () => {
    if (token !== epilogueToken || epiloguePhase !== 'title' || !script.isConnected) return;
    fitEpilogueTitle(script);
    if (reducedMotion()) {
      script.classList.add('is-shown');
      screen.querySelector('.epilogue-heading')?.classList.add('is-shown');
      epilogueTimer = window.setTimeout(() => fadeEpilogueTitle(token), 1600);
      return;
    }
    script.classList.add('is-writing');
    const hold = () => {
      if (token !== epilogueToken || epiloguePhase !== 'title') return;
      clearTimeout(epilogueTimer);
      epilogueTimer = window.setTimeout(() => fadeEpilogueTitle(token), 1400);
    };
    script.addEventListener('animationend', event => {
      if (event.animationName !== 'epilogue-write') return;
      script.classList.remove('is-writing');
      script.classList.add('is-shown');
      screen.querySelector('.epilogue-heading')?.classList.add('is-shown');
      hold();
    }, { once: true });
    epilogueTimer = window.setTimeout(() => fadeEpilogueTitle(token), 5600);
  };
  const load = document.fonts?.load?.('1em "Great Vibes"');
  if (load?.then) Promise.race([load.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1200))]).then(start);
  else start();
}

function revealEpilogueLine() {
  const line = document.querySelector('.epilogue-line');
  const veil = document.querySelector('.epilogue-veil');
  if (reducedMotion()) {
    veil?.remove();
    return;
  }
  veil?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 720, easing: 'ease', fill: 'forwards' })
    .finished.then(() => veil.remove(), () => veil.remove());
  if (!line) return;
  line.animate([
    { opacity: 0, transform: 'translateY(10px)' },
    { opacity: 1, transform: 'translateY(0)' },
  ], { duration: 720, easing: MOTION.ease, fill: 'both' });
}

function tremorScene() {
  if (reducedMotion()) return;
  const scene = document.querySelector('.workspace');
  scene?.getAnimations?.().find(animation => animation.id === 'scene-tremor')?.cancel();
  scene?.animate?.([
    { transform: 'translate3d(0, 0, 0) rotate(0deg)' },
    { transform: 'translate3d(3px, 1px, 0) rotate(.1deg)', offset: .5 },
    { transform: 'translate3d(0, 0, 0) rotate(0deg)' },
  ], { id: 'scene-tremor', duration: 760, easing: 'ease-in-out' });
}

function epilogueBlackoutVisible() {
  return Boolean(document.querySelector('.scene-blackout, .epilogue-veil'));
}

function releaseSceneBlackout() {
  let cover = document.querySelector('.scene-blackout');
  if (!cover) {
    syncPlayChrome();
    mountWorkspaceCover('<button type="button" class="scene-blackout is-held" data-action="scene-blackout" aria-label="暗転"></button>');
    cover = document.querySelector('.scene-blackout');
  }
  if (!cover) return;
  if (reducedMotion() || !cover.animate) { cover.remove(); return; }
  cover.classList.add('is-held');
  cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: 'ease', fill: 'forwards' })
    .finished.then(() => cover.remove(), () => cover.remove());
}

function beginSceneBlackout() {
  const token = ++epilogueToken;
  epilogueFading = true;
  epilogueBlackoutActive = true;
  clearTimeout(epilogueTimer);
  const proceed = () => {
    if (token !== epilogueToken) return;
    epilogueFading = false;
    epilogueBlackoutActive = false;
    epilogueBlackoutReady = true;
    advanceNovel();
  };
  const hold = () => {
    if (token !== epilogueToken) return;
    epilogueTimer = window.setTimeout(proceed, reducedMotion() ? 0 : 520);
  };
  document.querySelector('.scene-blackout')?.remove();
  syncPlayChrome();
  mountWorkspaceCover('<button type="button" class="scene-blackout" data-action="scene-blackout" aria-label="暗転"></button>');
  const cover = document.querySelector('.scene-blackout');
  if (!cover?.animate || reducedMotion()) { hold(); return; }
  cover.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease', fill: 'forwards' }).finished.then(hold, hold);
}

function beginEpilogueBlackout() {
  const token = ++epilogueToken;
  epilogueFading = true;
  epilogueBlackoutActive = true;
  clearTimeout(epilogueTimer);
  const proceed = () => {
    if (token !== epilogueToken || epiloguePhase !== 'line') return;
    epilogueFading = false;
    epilogueBlackoutActive = false;
    epilogueBlackoutReady = true;
    advanceNovel();
  };
  const hold = () => {
    if (token !== epilogueToken) return;
    epilogueTimer = window.setTimeout(proceed, reducedMotion() ? 0 : 640);
  };
  const line = document.querySelector('.epilogue-line');
  const cue = document.querySelector('.epilogue-cue');
  if (!line || reducedMotion()) { hold(); return; }
  const fade = [{ opacity: 1 }, { opacity: 0 }];
  const options = { duration: 480, easing: 'ease', fill: 'forwards' };
  const lineFade = line.animate(fade, options);
  cue?.animate(fade, options);
  lineFade.finished.then(hold, hold);
}

function mountEpilogue(workspace) {
  document.querySelector('.epilogue-screen')?.remove();
  if (!epiloguePhase || historyView || gateVisible) return;
  syncPlayChrome();
  mountWorkspaceCover(epilogueMarkup());
  if (!panel.open) document.querySelector('[data-action="epilogue-next"]')?.focus({ preventScroll: true });
  if (epiloguePhase === 'title') beginEpilogueTitle();
  else {
    // 行の幕も透明にしない。文言だけを後から出す。差し替えで幕をフェードさせると、Safari では裏が透ける。
    revealEpilogueLine();
  }
}

function playConversation(start, { fromCorrectAnswer = false } = {}) {
  answerOrigin = null;
  startView = false;
  yoiEndView = meiPlayChoiceVisible = false;
  meiEndRoute = null;
  meiEndView = false;
  resetChatFollow();
  sceneStart = start;
  displayedMessages = [];
  isPlaying = true;
  composerExpanded = false;
  if (panel.dataset?.kind === 'ritual-guide') dismissRitualGuideNow();
  menuExpanded = false;
  problemMenuExpanded = false;
  const scene = conversationMessages(state.messages.slice(sceneStart).filter(m => m.problemId === state.selected));
  preloadSceneImages(scene);
  novelPlayback = usesNovelBubbles(scene);
  cancelEpilogueMotion();
  if (scene[0]?.epilogue || scene[0]?.scene) {
    novelPlayback = true;
    epiloguePhase = 'title';
    render();
    return;
  }
  epiloguePhase = null;
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
    || isBookletTurn(message.text)) return true;
  const problem = scenario.problems.find(p => p.id === message.problemId);
  return Boolean(problem?.dialogue.some(line => line.travelGuidePart && line.text === message.text));
}

function usesNovelBubbles(scene) {
  return scene.some(line => line.speaker || (isInvestigation() || current().completionScreen === 'booklet') && line.kind === 'dialogue' && !isSceneNotice(line));
}

function holdSceneNarration() {
  isPlaying = false;
  epiloguePhase = 'line';
  save();
  render();
}

function q9NarrationOnly() {
  const start = latestSceneStart(state.messages, 'Q9');
  const lines = state.messages.slice(start).filter(m => m.problemId === 'Q9' && m.kind === 'dialogue' && !isSceneNotice(m));
  return lines.length > 0 && lines.every(m => !m.speaker && !m.scene);
}

function advanceNovel(remaining = pendingConversation(state, { isPlaying, sceneStart, displayedMessages })) {
  // 背景付きの結末は、読み終えても吹き出しの一覧に戻さない。
  // Q9はルートAと同じ暗転を挟んでから冥の終幕へ進む。
  if (!remaining.length && displayedMessages.at(-1)?.scene) {
    if (meiEndingReady()) {
      if (!epilogueBlackoutReady) {
        beginSceneBlackout();
        return;
      }
      epilogueBlackoutReady = false;
      finishConversation({ scroll: false });
      releaseSceneBlackout();
      return;
    }
    holdSceneNarration();
    return;
  }
  // Q3では次の台詞がなければ、最後の一言と一覧・再回答への操作を一緒に表示する。
  const lastInvestigationLine = isInvestigation() && current().autoOpenContinuation !== 'after-dialogue'
    && remaining.length === 1 && !isSceneNotice(remaining[0])
    && !current().instruction && !displayedMessages.some(isSceneNotice);
  if (remaining.every(isSceneNotice) || lastInvestigationLine) {
    displayedMessages.push(...remaining);
    if (continuationPending()) composerExpanded = true;
    const pageTurnOpened = finishConversation({ scroll: false });
    document.querySelector('.chat-area').scrollTop = 0;
    if (pageTurnOpened || openAutomaticContinuation()) return;
    const continuation = document.querySelector('.novel-bubble[data-action="investigation-closing"]') ?? document.querySelector('.branch-options button, .answer-fab:not([aria-expanded="true"]):not([hidden]), .investigation-return');
    continuation?.focus({ preventScroll: true });
    return;
  }
  const previous = displayedMessages.at(-1);
  const line = remaining[0];
  // 場面が切り替わるときも、明示の暗転と同じ全面の黒を使う。文字だけを落として背景を差し替えない。
  const crossesScene = Boolean(epiloguePhase && line?.scene && previous?.scene && previous.scene !== line.scene);
  if ((line?.blackout || crossesScene) && !epilogueBlackoutReady) {
    beginSceneBlackout();
    return;
  }
  const openedFromBlackout = Boolean((line?.blackout || crossesScene) && epilogueBlackoutReady);
  if (openedFromBlackout) epilogueBlackoutReady = false;
  if (line?.epilogue) {
    if (epiloguePhase && line.background && !previous?.background && !line.blackout) {
      if (!epilogueBlackoutReady) {
        beginEpilogueBlackout();
        return;
      }
      epilogueBlackoutReady = false;
      epilogueEnteredFromBlack = true;
    }
    displayedMessages.push(line);
    epiloguePhase = 'line';
    save();
    render();
    epilogueEnteredFromBlack = false;
    if (openedFromBlackout) releaseSceneBlackout();
    if (line.tremor) tremorScene();
    document.querySelector('.chat-area').scrollTop = 0;
    document.querySelector('[data-action="epilogue-next"]')?.focus({ preventScroll: true });
    return;
  }
  if (epiloguePhase) {
    epiloguePhase = null;
    cancelEpilogueMotion();
    displayedMessages.push(line);
    render();
    settleNovelArrival(openedFromBlackout);
    if (line.tremor) tremorScene();
    document.querySelector('.chat-area').scrollTop = 0;
    if (!panel.open) document.querySelector('[data-action="novel-next"]')?.focus({ preventScroll: true });
    return;
  }
  displayedMessages.push(line);
  const artworkChanged = Boolean(line?.scene && previous?.scene && previous.scene !== line.scene) || Boolean(line?.recall) !== Boolean(previous?.recall);
  const bubble = previous && !artworkChanged && !openedFromBlackout && document.querySelector('[data-action="novel-next"]');
  if (bubble) {
    updateNovelBubble(bubble, line);
    save();
  } else {
    render();
    if (!openedFromBlackout) revealNovelContent(document.querySelector('.novel-line'));
    if (historyView) document.querySelector('#history-heading')?.focus({ preventScroll: true });
    else if (!panel.open) document.querySelector('[data-action="novel-next"]')?.focus({ preventScroll: true });
  }
  if (openedFromBlackout) settleNovelArrival(true);
  if (line.tremor) tremorScene();
  document.querySelector('.chat-area').scrollTop = 0;
}

function novelPortraitMarkup(speaker) {
  if (!speaker) return '';
  const names = speaker.split('＆');
  names.sort((a, b) => (a === 'タツ' ? 1 : 0) - (b === 'タツ' ? 1 : 0));
  return names.map((name, index) => {
    const portrait = scenario.portraits[name];
    const side = names.length > 1 && index === names.length - 1 ? ' novel-portrait-right' : '';
    return `<div class="novel-portrait${side}">${portrait ? `<img src="${esc(portrait)}" alt="">` : ''}<span class="novel-speaker">${esc(name)}</span></div>`;
  }).join('');
}

// 保存済みの台詞も表示時に直し、再生位置の照合には元の本文を使う。
function dialogueDisplayText(line) {
  if (line.problemId === 'Q6.2' && !line.speaker && isBookletTurn(line.text)) return 'テープを破って冊子の次のページへ進もう';
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
  return `${canAdvance && line.speaker ? `<span class="sr-only">${esc(line.speaker)}</span>` : ''}
      <span class="novel-line">${esc(dialogueDisplayText(line))}</span>
      ${canAdvance ? '<span class="novel-next"><span aria-hidden="true">▷</span><span class="sr-only">読み進める</span></span>' : ''}`;
}

// Keep the bubble opaque while its new text settles into place.
function revealNovelContent(element) {
  if (!element || reducedMotion()) return;
  element.animate?.([{ opacity: .78, translate: '0 3px' }, { opacity: 1, translate: '0 0' }], {
    duration: MOTION.state, easing: MOTION.ease,
  });
}

// 暗転で開く台詞は、黒が落ちてから吹き出しの文字と立ち絵を通常の会話と同じ時間で出す。
function settleNovelArrival(fromBlackout) {
  if (fromBlackout) releaseSceneBlackout();
  revealNovelContent(document.querySelector('.novel-line'));
  if (!fromBlackout || reducedMotion()) return;
  document.querySelectorAll('.novel-portrait:not(.portrait-leaving)').forEach(portrait => {
    portrait.animate?.([{ opacity: .78 }, { opacity: 1 }], { duration: MOTION.state, easing: MOTION.ease });
  });
}

function updateNovelBubble(bubble, line) {
  if (!line.appear) document.querySelector('.scene-appear')?.remove();
  const stage = bubble.parentElement;
  const outgoings = [...stage.querySelectorAll('.novel-portrait:not(.portrait-leaving)')];
  const speaker = line.speaker || '';
  const outgoingSpeaker = outgoings.map(node => node.querySelector('.novel-speaker').textContent).join('＆');
  if (outgoingSpeaker !== speaker) {
    stage.querySelectorAll('.portrait-leaving').forEach(node => node.remove());
    let incomingOpacity = .78;
    for (const outgoing of outgoings) {
      if (!reducedMotion()) {
        const opacity = Number(getComputedStyle(outgoing).opacity);
        incomingOpacity = 1 - opacity;
        outgoing.getAnimations().forEach(animation => animation.cancel());
        outgoing.classList.toggle('was-right', outgoing.classList.contains('novel-portrait-right') || stage.classList.contains('novel-right'));
        outgoing.classList.add('portrait-leaving');
        outgoing.setAttribute('aria-hidden', 'true');
        const exit = outgoing.animate([{ opacity }, { opacity: 0 }], {
          duration: MOTION.state, easing: MOTION.ease, fill: 'forwards',
        });
        exit.finished.then(() => outgoing.remove(), () => outgoing.remove());
      } else outgoing.remove();
    }
    stage.classList.toggle('novel-right', speaker === 'タツ');
    if (speaker) {
      bubble.insertAdjacentHTML('beforebegin', novelPortraitMarkup(speaker));
      if (!reducedMotion()) stage.querySelectorAll('.novel-portrait:not(.portrait-leaving)').forEach(portrait => portrait.animate([
        { opacity: incomingOpacity }, { opacity: 1 },
      ], { duration: MOTION.state, easing: MOTION.ease }));
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
    : (current().completionScreen === 'booklet' || current().deferPageTurn) && showsGuideStop(current()) ? 'travel-next'
    : !state.solved.includes(current().id) || repeatAnswer ? 'open-composer' : '';
  const tag = action ? 'button' : 'article';
  return `<div class="novel-stage${line.speaker === 'タツ' ? ' novel-right' : ''}">
    ${line.appear ? '' : novelPortraitMarkup(line.speaker)}
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
  book: '<path d="M12 6c-1.8-1.4-4.5-2-8-2v15c3.5 0 6.2.6 8 2 1.8-1.4 4.5-2 8-2V4c-3.5 0-6.2.6-8 2v15Z"/>',
  send: '<path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>',
  edit: '<path d="m16 5 3 3M4 20l4.2-.8L20 7.4 16.6 4 4.8 15.8 4 20Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  reset: '<path d="M3 11a9 9 0 1 1 2 7M3 3v8h8"/>',
  numberTicket: '<path d="M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4V6Z"/><path d="m10 8-1 8m6-8-1 8m-6-5h9m-9 3h9"/>',
  warning: '<path d="m12 3 10 17H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
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

function investigationClosingEntry(id = state.selected) {
  const problem = scenario.problems.find(item => item.id === id);
  return problem?.requiresSolved?.find(item => scenario.investigation.entries.includes(item)) ?? id;
}

function investigationClosingMarkup() {
  const lastSolved = state.solved.filter(isInvestigation).at(-1);
  const last = investigationComplete(scenario, state) && lastSolved === state.selected;
  const closing = scenario.investigation.closing;
  const text = `${closing.byEntry[investigationClosingEntry()] ?? ''}${closing[last ? 'last' : 'more']}`;
  return `<section class="investigation-closing" aria-label="捜査の振り返り">
    <button type="button" data-action="investigation-back">
      <span class="investigation-closing-text">${esc(text)}</span>
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
  startView = yoiEndView = meiEndView = repeatAnswer = composerExpanded = menuExpanded = problemMenuExpanded = meiPlayChoiceVisible = false;
  meiEndRoute = null;
  investigationView = true;
  state = { ...state, selected: scenario.investigation.id };
  displayedMessages = [];
  const complete = scenario.investigation.entries.filter(id => investigationEntryStatus(id, state.solved) === 2);
  const peelingConclusions = complete.filter(id => !seenConclusions.includes(id));
  seenConclusions = complete;
  const justCompleted = Boolean(previousSolved) && !scenario.investigation.problemIds.every(id => previousSolved.includes(id)) && investigationComplete(scenario, state);
  resetChatFollow();
  render({ peelingConclusions });
  document.querySelector('.chat-area').scrollTop = investigationScrollTop;
  (justCompleted ? document.querySelector('.investigation-next') : document.querySelector(`[data-action="investigation-open"][data-id="${investigationReturnId}"]`))?.focus({ preventScroll: true });
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
    for (const id of changed) {
      if (state.solved.includes(id)) document.querySelector(`[data-action="investigation-open"][data-id="${id}"] .investigation-stamp`)?.classList.add('is-stamping');
    }
    const previousCount = answeredInvestigationCount(previousSolved);
    const currentCount = answeredInvestigationCount(state.solved);
    if (currentCount > previousCount && !reducedMotion()) {
      const sector = 360 / scenario.investigation.entries.length;
      document.querySelector('.investigation-progress')?.animate?.([
        { '--answered-angle': `${previousCount * sector}deg` },
        { '--answered-angle': `${currentCount * sector}deg` },
      ], { duration: 750, easing: 'ease-in-out' });
    }
    if (justCompleted) animateEmphasis(document.querySelector('.investigation-next'), reducedMotion());
  }
  investigationSnapshot = [...state.solved];
}

function answeredInvestigationCount(solved) {
  return scenario.investigation.entries.filter(id => investigationEntryStatus(id, solved) === 2).length;
}

function investigationEntryStatus(id, solved) {
  const p = scenario.problems.find(item => item.id === id);
  return !solved.includes(id) ? 0 : p.continueTo && !solved.includes(p.continueTo) ? 1 : 2;
}

function continuationPending() {
  const p = current();
  if (!p?.autoOpenContinuation || !state.solved.includes(p.id) || repeatAnswer) return false;
  if (state.solved.includes(p.continueTo) && !p.reopenSolvedContinuation) return false;
  return true;
}

function openAutomaticContinuation() {
  const p = current();
  if (!continuationPending()) return false;
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
    const status = investigationEntryStatus(p.id, state.solved);
    const stamp = status === 2 ? '回答済み' : status === 1 ? '回答中' : '未回答';
    const progress = status === 2 ? 'solved' : status === 1 ? 'answering' : 'open';
    return `<button class="investigation-question" data-solved="${status === 2}" data-answered="${status === 2}" data-progress="${progress}" data-action="investigation-open" data-id="${esc(p.id)}">${questionSymbolMarkup(p)}<span class="investigation-stamp">${stamp}</span><strong><span class="investigation-question-text">${esc(p.listPrompt)}</span></strong></button>`;
  });
  const answeredCount = answeredInvestigationCount(state.solved);
  const progress = `<span class="investigation-progress" role="meter" aria-label="Q3の回答状況" aria-valuemin="0" aria-valuemax="${entries.length}" aria-valuenow="${answeredCount}" aria-valuetext="${entries.length}問中${answeredCount}問回答済み" style="--answered-angle: ${360 * answeredCount / entries.length}deg"></span>`;
  return `<div class="investigation-intro"><h1>残された違和感</h1><p>上の付箋をタップして、気になる問いから好きな順番で考えよう。下の「？」は答えが揃うと開きます。</p>${progress}</div><div class="investigation-questions">${notes.join('')}</div><div class="conclusion-mount"><dl class="investigation-conclusions" aria-label="捜査の結論">${entries.map(p => conclusionMarkup(p, peelingConclusions.includes(p.id))).join('')}</dl></div>`;
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

function trackSurface(element, animation) {
  surfaceAnimations.set(element, animation);
  return animation.finished.then(() => {
    if (surfaceAnimations.get(element) !== animation) return false;
    surfaceAnimations.delete(element);
    animation.cancel();
    return true;
  }).catch(() => false);
}

function animateSurface(element, opening, offset = 20, axis = 'Y', duration = null) {
  return animateFrames(element, opening, `translate${axis}(${typeof offset === 'number' ? `${offset}px` : offset})`, `translate${axis}(0)`, duration);
}

// 中央に出る小さな面は、位置を変えずに拡大縮小で出入りさせる。
function animateScale(element, opening, from = .94, duration = null) {
  return animateFrames(element, opening, `scale(${from})`, 'scale(1)', duration);
}

// 開いたトリガの位置から中央ダイアログを膨らませて出す。
function animateFromRect(element, from) {
  if (!element?.animate || !from?.width || !from?.height || reducedMotion()) return false;
  const to = element.getBoundingClientRect();
  if (!to.width || !to.height) return false;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const animation = element.animate([
    { transformOrigin: 'center', transform: `translate(${dx}px, ${dy}px) scale(${Math.max(.05, from.width / to.width)})`, opacity: .4 },
    { transformOrigin: 'center', transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
  ], { duration: MOTION.enter, easing: MOTION.ease, fill: 'both' });
  trackSurface(element, animation);
  return true;
}

// 位置を transform で決めている要素は、不透明度だけを動かす。
function animateFade(element, opening, duration = null) {
  return animateFrames(element, opening, null, null, duration);
}

// フローティングボタンの位置・形からシートを膨らませて開く。
function morphFromFab(composer, fab) {
  if (!composer?.animate || reducedMotion()) return null;
  surfaceAnimations.get(composer)?.cancel();
  surfaceAnimations.delete(composer);
  const from = fab.getBoundingClientRect();
  const to = composer.getBoundingClientRect();
  if (!from.width || !to.width || !to.height) return null;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const animation = composer.animate([
    { transformOrigin: 'center', transform: `translate(${dx}px, ${dy}px) scale(${Math.max(.05, from.width / to.width)}, ${Math.max(.05, from.height / to.height)})`, opacity: 0, borderRadius: '999px' },
    { transformOrigin: 'center', transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1, borderRadius: getComputedStyle(composer).borderRadius },
  ], { duration: MOTION.enter, easing: MOTION.ease, fill: 'both' });
  return trackSurface(composer, animation);
}

function animateFrames(element, opening, hiddenTransform, visibleTransform, duration) {
  if (!element) return Promise.resolve(false);
  const previous = surfaceAnimations.get(element);
  const currentStyle = previous || !opening ? getComputedStyle(element) : null;
  const frame = (opacity, transform) => transform == null ? { opacity } : { opacity, transform };
  const interruptedFrame = currentStyle ? frame(currentStyle.opacity, hiddenTransform == null ? null : currentStyle.transform) : null;
  previous?.cancel();
  surfaceAnimations.delete(element);
  if (!element.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(true);
  const hiddenFrame = frame(0, hiddenTransform);
  const visibleFrame = frame(1, visibleTransform);
  const animation = element.animate([interruptedFrame ?? (opening ? hiddenFrame : visibleFrame), opening ? visibleFrame : hiddenFrame], {
    duration: duration ?? (opening ? MOTION.enter : MOTION.exit), easing: MOTION.ease, fill: 'both',
  });
  return trackSurface(element, animation);
}

// 宣言済みの transform-origin から小さく弾くメニュー用の開閉。
function animatePop(element, opening) {
  if (!element) return Promise.resolve(false);
  const previous = surfaceAnimations.get(element);
  const currentStyle = previous || !opening ? getComputedStyle(element) : null;
  const interruptedFrame = currentStyle ? { opacity: currentStyle.opacity, transform: currentStyle.transform } : null;
  previous?.cancel();
  surfaceAnimations.delete(element);
  if (!element.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve(true);
  const hiddenFrame = { opacity: 0, transform: 'scale(.92)' };
  const visibleFrame = { opacity: 1, transform: 'scale(1)' };
  const animation = element.animate([interruptedFrame ?? (opening ? hiddenFrame : visibleFrame), opening ? visibleFrame : hiddenFrame], {
    duration: opening ? MOTION.enter : MOTION.exit, easing: MOTION.ease, fill: 'both',
  });
  return trackSurface(element, animation);
}

function shakeElement(element, distance = 6) {
  if (!element?.animate || reducedMotion()) return;
  element.animate([0, -distance, distance, -distance * .8, distance * .8, -distance / 3, 0].map(x => ({ transform: `translateX(${x}px)` })), { duration: 380, easing: 'ease-in-out' });
}

function popElement(element) {
  if (!element?.animate || reducedMotion()) return;
  element.animate([{ opacity: 0, scale: .4 }, { opacity: 1, scale: 1.15, offset: .6 }, { opacity: 1, scale: 1 }], { duration: MOTION.enter, easing: MOTION.ease });
}

let clueToastTimer;
function announceNewClue(count) {
  const button = document.querySelector('.clue-button');
  if (!reducedMotion()) button?.animate?.([{ scale: 1 }, { scale: 1.12, offset: .35 }, { scale: 1 }], { duration: 520, easing: MOTION.ease });
  const shell = document.querySelector('.shell');
  if (!shell?.insertAdjacentHTML) return;
  document.querySelector('.clue-toast')?.remove();
  clearTimeout(clueToastTimer);
  shell.insertAdjacentHTML('beforeend', `<p class="clue-toast" role="status">${icon('cards')}<span>新しい手がかりを${count > 1 ? `${count}枚` : ''}手に入れた</span></p>`);
  const toast = document.querySelector('.clue-toast');
  if (!toast) return;
  animateSurface(toast, true, -12);
  clueToastTimer = setTimeout(() => {
    animateSurface(toast, false, -12).then(finished => { if (finished) toast.remove(); });
  }, 2600);
}

function revealItems(selector, root = document) {
  if (reducedMotion()) return;
  root.querySelectorAll?.(selector)?.forEach((item, index) => {
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
  form.classList.toggle('needs-completion', highlight && !result.ready && !problem.concealBlankFields);
  form.querySelectorAll('.needs-answer').forEach(field => field.classList.remove('needs-answer'));
  if (highlight && !result.ready && !problem.concealBlankFields) {
    const empty = [...form.querySelectorAll('input:not([type="hidden"]), select')].filter(field => field.type === 'radio' || field.type === 'checkbox' ? !form.querySelector('input:checked') : !field.value.trim() && field.required);
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
  animatePop(menu, expanded).then(finished => {
    if (finished && !menuExpanded && menu.isConnected) menu.hidden = true;
  });
  if (expanded) revealItems(':scope > button', menu);
}

// 展開した問題は閉じられない。戻る操作は履歴（捜査中は問題一覧）へ送る。
function answerAreaBack() {
  if (!startView && (current().conversationBackground === 'investigation' || !answerOrigin && isInvestigation())) { showInvestigation(); return; }
  openHistoryScreen();
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
    maybeShowQ9Guide();
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
  // シートの背後に残るFABは、開閉と同じ速さで透過させる。
  if (fab.style) fab.style.opacity = expanded ? '0' : '';
  const opened = expanded && !composer.classList?.contains('answer-page') ? morphFromFab(composer, fab) : null;
  (opened ?? animateSurface(composer, expanded, 40)).then(finished => {
    if (finished && !composerExpanded && composer.isConnected) composer.hidden = true;
  });
  if (!expanded && focusWasInside) fab.focus({ preventScroll: true });
  maybeShowQ9Guide();
}

function closePanel() {
  clearTimeout(hintCueTimer);
  if (!panel.open || panel.classList.contains('is-closing')) return;
  if (panel.dataset?.kind === 'hints' && hintContext === 'hex-cube' && parkedMiniHost && miniView) {
    hintContext = null;
    openPanel('hex-cube');
    return;
  }
  miniView?.destroy();miniView=null;
  parkedMiniHost = null;
  hintContext = null;
  if (panel.classList.contains('clue-gallery') && combinePicker) {
    combinePicker = false;
    combineReplaceAt = null;
    openPanel('clues');
    animateFade(panel.querySelector('#clue-tab-content'), true, MOTION.state);
    return;
  }
  if (panel.classList.contains('clue-gallery') && combineSelecting) {
    clearCombineSelecting();
    openPanel('clues');
    return;
  }
  if (panel.classList.contains('clue-gallery') && expandedClueId !== null) {
    closeClueCardPreview();
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
  const closingRevision = panelRevision;
  if (resumeSheet) gateInput = false;
  const returnSlot = panel.classList.contains('symbol-choice-dialog') ? activeSymbolSlot : null;
  const closingImageViewer = imageViewer;
  const imageOrigin = panel.dataset?.kind === 'puzzle-image' ? document.querySelector('.puzzle-preview') : imageReturnElement;
  const returnRect = imageOrigin?.isConnected && imageOrigin.getClientRects?.().length
    ? imageOrigin.getBoundingClientRect() : null;
  const imageExit = closingImageViewer?.dismissTo(returnRect);
  imageViewer = null;
  sheetDismiss?.dispose({ preservePosition: true }); sheetDismiss = null;
  const closingTravelNext = panel.dataset?.kind === 'travel-next';
  panel.classList.add('is-closing');
  panel.inert = true;
  syncNavigation();
  const clueScreen = panel.classList.contains('clue-gallery');
  const centered = ['page-turn-dialog', 'tour-thanks-dialog', 'afterword-dialog', 'start-answer-dialog', 'answer-choice-dialog'].some(name => panel.classList.contains(name));
  const exit = clueScreen ? animateSurface(panel, false, 16, 'X')
    : centered && !closingImageViewer ? animateScale(panel, false, .96)
    : animateSurface(panel, false, closingImageViewer ? 0 : panel.classList.contains('draggable-sheet') ? '100%' : 24, 'Y', imageExit ? MOTION.enter : null);
  const completion = imageExit ? Promise.all([exit, imageExit]).then(([finished]) => finished) : exit;
  return completion.then(finished => {
    closingImageViewer?.dispose();
    // 閉じている途中に別のパネルを開いたら、遅れて届くクローズでそれを消さない。
    if (!finished || closingRevision !== panelRevision) return;
    const outsideFocus = document.activeElement && document.activeElement !== document.body && !panel.contains?.(document.activeElement) ? document.activeElement : null;
    panel.style?.removeProperty('transform');
    panel.style?.removeProperty('--sheet-drag');
    panel.close();
    panel.classList.remove('is-closing');
    panel.inert = false;
    if (closingTravelNext) {
      pageTurnRevealed = false;
      if (current().deferPageTurn && !panel.open) render();
    }
    const available = element => element?.isConnected && !element.closest?.('[hidden], [inert]') && (!element.getClientRects || element.getClientRects().length > 0);
    const actionTarget = panelReturnAction ? document.querySelector(`[data-action="${panelReturnAction}"]`) : null;
    const returnTarget = available(outsideFocus) ? outsideFocus : available(panelReturnFocus) ? panelReturnFocus : available(actionTarget) ? actionTarget : document.querySelector('.composer-area:not([hidden])') ?? document.querySelector('.menu-button');
    returnTarget?.focus?.({ preventScroll: true });
    if (!outsideFocus && returnSlot !== null) document.querySelector(`#symbol-slot-${returnSlot}`)?.focus({ preventScroll: true });
    if (resumeSheet && gateVisible) document.querySelector('[data-action="save-continue"]')?.focus({ preventScroll: true });
    syncNavigation();
    maybeShowQ9Guide();
  });
}

function capturePlayView() {
  return { startView, yoiEndView, meiEndView, ...(meiEndRoute ? { meiEndRoute } : {}), showVenueDirections, investigationView, ...(investigationClosing ? { investigationClosing: true } : {}), investigationScrollTop, investigationReturnId,
    ...(scenario.investigation.entries.some(id => investigationEntryStatus(id, state.solved) === 2) ? { seenConclusions: [...seenConclusions] } : {}),
    repeatAnswer, composerExpanded, ...(answerOrigin ? { answerOrigin: { ...answerOrigin } } : {}), sceneStart,
    displayedCount: displayedMessages.length, isPlaying,
    seenClueIds: [...seenClueIds],
    ...(q9GuideSeen ? { q9GuideSeen: true } : {}),
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
  shownSceneArt = '';
  pageTurnSceneArmed = false;
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
  if (entering && !reducedMotion()) document.querySelector('.title-art')?.animate?.([{ opacity: 0, transform: 'scale(1.03)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: MOTION.ease, fill: 'backwards' });
  if (gateInput) openPanel('resume');
  syncNavigation();
  warmupEntryImages();
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
  // 確定した桁を小さく弾いて、次の入力へ進んだことを視覚的にも返す。
  if (digits) popElement(panel.querySelector(`#resume-digit-${index + digits.length - 1}`));
  panel.querySelector(`#resume-digit-${Math.min(index + digits.length, 5)}`)?.focus({ preventScroll: true });
  if (gateDigits.every(digit => /^[0-9]$/.test(digit))) void beginPlay('code', gateCode);
}

function enterPlay(record) {
  playSessionRevision++;
  conversationPlayer.stop();
  historyView = false;
  knownClueCount = null;
  knownUnlockedIds = null;
  multiSelectionOrder.clear();
  changingSession = true;
  state = restoreState(scenario, JSON.stringify(record.state));
  investigationSnapshot = [...state.solved];
  const savedView = state.selected === scenario.investigation.id && record.state.selected !== state.selected
    ? { investigationView: true, answerDrafts: record.view?.answerDrafts }
    : record.view;
  const view = restorePlayView(scenario, state, savedView, record.state.scenarioRevision ?? 0, record.state);
  ({ startView, yoiEndView, meiEndView = false, meiEndRoute = null, showVenueDirections, investigationView, investigationClosing = false, investigationScrollTop, investigationReturnId,
    repeatAnswer, composerExpanded, answerOrigin = null, sceneStart, displayedMessages, isPlaying, puzzleImageIndex,
    q9GuideSeen = false, selectedPuzzleAnswer, selectedSymbols, answerDrafts } = view);
  // Older saves already on the board have seen its completed entries.
  const completedEntries = scenario.investigation.entries.filter(id => investigationEntryStatus(id, state.solved) === 2);
  seenConclusions = view.seenConclusions ?? completedEntries.filter(id => investigationView
    || id !== state.selected && !scenario.problems.some(p => p.id === id && p.continueTo === state.selected));
  seenClueIds = new Set(view.seenClueIds ?? []);
  if (!answerDrafts.N1 && selectedPuzzleAnswer && (!state.solved.includes('N1') || repeatAnswer && state.selected === 'N1')) answerDrafts.N1 = [selectedPuzzleAnswer];
  if (selectedSymbols.some(Boolean) && !answerDrafts[state.selected] && (!state.solved.includes(state.selected) || repeatAnswer)) answerDrafts[state.selected] = [...selectedSymbols];
  if (record.code !== '000000') localRecord = record;
  gateVisible = false;
  gateBusy = false;
  gateError = '';
  menuExpanded = problemMenuExpanded = false;
  pageTurnRevealed = false;
  selectedSymbols = [...selectedSymbols];
  feedback = '';
  resetChatFollow();
  closePanel();
  const scene = isPlaying ? conversationMessages(state.messages.slice(sceneStart).filter(m => m.problemId === state.selected)) : [];
  novelPlayback = usesNovelBubbles(scene);
  cancelEpilogueMotion();
  epiloguePhase = null;
  if (novelPlayback) {
    const remaining = pendingConversation(state, view);
    preloadSceneImages(remaining);
    displayedMessages = scene.slice(0, scene.length - remaining.length);
    epiloguePhase = resumeEpiloguePhase(displayedMessages, remaining);
    const opening = !displayedMessages.length || isSceneNotice(displayedMessages.at(-1)) || (isInvestigation() && !remaining.length && current().autoOpenContinuation !== 'after-dialogue');
    if (epiloguePhase === 'title' || !opening) render();
    else advanceNovel(remaining);
  } else render();
  const chat = document.querySelector('.chat-area');
  if (chat) chat.scrollTop = view.chatScrollTop;
  const gallery = document.querySelector('.chat-area .travel-guide-gallery');
  if (answerOrigin && gallery) gallery.scrollLeft = answerOrigin.scrollLeft;
  changingSession = false;
  if (!isPlaying && !investigationView && !composerExpanded && !answerOrigin && current().autoOpenContinuation === 'after-dialogue') openAutomaticContinuation();
  if (isPlaying && !novelPlayback) {
    const remaining = pendingConversation(state, view);
    preloadSceneImages(remaining);
    conversationPlayer.play(remaining);
  }
  updateSaveStatus(playSaves.getStatus());
  if (!openFinishedPageTurn() && record.code && record.code !== '000000' && !announcedCode) {
    announcedCode = true;
    openPanel('save-info', { showStartButton: startView && !state.solved.length });
  }
  maybeShowQ9Guide();
}

// transitionToPlay と対にして、チャット画面も同じ向きで退場させる。
function transitionToEntry() {
  const shell = document.querySelector('.shell');
  if (shell?.classList?.contains && !shell.classList.contains('title-shell') && shell.animate && !reducedMotion()) {
    void animateSurface(shell, false, -12).finally(renderEntry);
    return;
  }
  renderEntry();
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
  // 保存先の応答を待つあいだに、これから見せる場面の画像を取りに行く。
  warmupEntryImages();
  if (automatic) renderResumeLoading();
  else renderEntry();
  try {
    let record;
    if (kind === 'continue') {
      record = playSaves.getRecord() ?? playSaves.readLocal();
      if (!record && legacyState) record = playSaves.adoptLegacy(legacyState, restorePlayView(scenario, legacyState, null));
      if (!record) throw new Error('このブラウザには保存された記録がありません。');
      if (record.code && !record.pending) {
        try {
          record = await playSaves.loadCode(record.code, {
            sinceRevision: record.revision, localState: record.state, localView: record.view,
          });
        } catch (error) { if (error.status && error.status < 500 && error.status !== 429) throw error; }
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
    if (automatic) {
      await animateFade(document.querySelector('.resume-loading'), false);
      enterPlay(record);
      animateFade(document.querySelector('.workspace'), true);
      viewportLayout.update();
    }
    else await transitionToPlay(record);
    if (requestedMinigame) {const id=requestedMinigame;requestedMinigame=null;if(id==='luminol')await openLuminol();else await openHexCube(id);}
    if (kind === 'continue') void playSaves.retry();
  } catch (error) {
    gateBusy = false;
    gateError = error.message || '読み込めませんでした。通信を確認して、もう一度お試しください。';
    if (gateVisible) {
      if (requestedMinigame) gateInput = true;
      renderEntry();
      if (gateInput) { shakeElement(panel.querySelector('.resume-digits')); haptics.trigger('error'); }
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
        <img src="${esc(step.preview)}" alt="${esc(step.imageAlt)}" decoding="async">${placeholder}
        <span class="travel-guide-zoom" aria-hidden="true">タップして拡大</span>
      </button>
      <figcaption class="travel-guide-copy">${esc(step.directions)}</figcaption>
    </figure>`).join('')}</div>`;
}

function normalizePageTurnText(text) {
  const stripped = String(text ?? '').replace(/^指示[：:]\s*/, '');
  if (stripped === 'テープを破って冊子の次のページへ進もう') return stripped;
  return /^(?:冊子の)?(?:次の)?ページ(?:をめくろう|[へに](?:いこう|行こう|進もう))[。！!]?$/u.test(stripped)
    ? '冊子の次のページをめくろう' : text;
}

function pageTurnLabel(problem) {
  const line = problem?.dialogue?.find(item => !item.speaker && isBookletTurn(item.text));
  const text = (line?.text ?? problem?.instruction ?? '').replace(/^指示[：:]\s*/, '');
  return normalizePageTurnText(text) || '冊子の次のページをめくろう';
}

function emphasizeEscaped(escaped, label, className) {
  const token = esc(label);
  if (!label || !escaped.includes(token)) return escaped;
  return escaped.replaceAll(token, `<strong class="${className}">${token}</strong>`);
}

function destinationInstruction(guide) {
  if (!guide?.placeName || !guide.approach || !guide.pageTurnText) return '';
  return `${guide.placeName}へ${guide.approach}。${guide.pageTurnText}`;
}

function instructionCardMarkup(text, { notice = false, warningText = '', guide = null, problemId = '' } = {}) {
  const instruction = (!notice && destinationInstruction(guide)) || text.replace(/^(?:指示|伝達)[：:]\s*/, '');
  if (!notice && normalizePageTurnText(instruction) === '冊子の次のページをめくろう') {
    return pageTurnCardMarkup('冊子の次のページをめくろう');
  }
  const label = notice ? 'ご案内' : '目的地に移動しよう';
  const body = esc(instruction);
  let copy = warningText ? body.replace(esc(warningText), `<strong class="message-warning">${esc(warningText)}</strong>`) : body;
  copy = emphasizeEscaped(copy, guide?.placeName, 'instruction-place');
  copy = emphasizeEscaped(copy, guide?.findLabel, 'instruction-find');
  return `<article class="instruction-card${notice ? ' instruction-card-notice' : ''}" aria-label="${label}"><div class="instruction-card-heading"><span class="instruction-card-icon" aria-hidden="true">${icon(notice ? 'info' : 'map')}</span><span>${label}</span></div><p class="instruction-card-copy">${copy}</p>${guide ? travelGuideMarkup(guide, problemId) : ''}</article>`;
}

function isBookletTurn(text) {
  const normalized = normalizePageTurnText(String(text ?? '').replace(/^指示[：:]\s*/, ''));
  return normalized === '冊子の次のページをめくろう' || normalized === 'テープを破って冊子の次のページへ進もう';
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
  // 暗転した場面にページをめくる案内だけを先に出し、ポップアップはタップで開く。
  if (kind === 'travel-next' && current().deferPageTurn) {
    document.querySelector('.page-turn-scene')?.focus({ preventScroll: true });
    return true;
  }
  openPanel(kind);
  return true;
}

function showsGuideStop(problem, repeating = repeatAnswer) {
  if (startView || isPlaying) return false;
  if (problem.id === 'Q1') return !displayedMessages.length;
  return Boolean((problem.travelGuide || hasStoryPageTurn(problem)) && state.solved.includes(problem.id) && !repeating);
}

function pageTurnCardMarkup(text = '次の問題を見つけたらページをめくろう', { action = '', buttonLabel = '', notice = '', emphasis = '' } = {}) {
  text = normalizePageTurnText(text);
  const body = emphasizeEscaped(esc(text), emphasis, 'page-turn-target');
  return `<article class="instruction-card instruction-card-page-turn" aria-label="${esc(text)}"><span class="page-turn-stop" aria-hidden="true">STOP</span><p class="page-turn-text"${action ? ' id="panel-title"' : ''}>${body}</p>${notice ? `<p class="page-turn-notice">${esc(notice)}</p>` : ''}${action ? `
    <button type="button" class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button>
    <button type="button" class="primary-button" data-action="${esc(action)}">${esc(buttonLabel)}</button>` : ''}</article>`;
}

function messageMarkup(m) {
  if (m.scene) return '';
  if (m.problemId === 'Q9' && !m.speaker && q9NarrationOnly()) return '';
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
  const duoNames = m.kind === 'dialogue' ? m.speaker.split('＆') : [m.speaker];
  if (duoNames.length > 1) {
    duoNames.sort((a, b) => (a === 'タツ' ? 1 : 0) - (b === 'タツ' ? 1 : 0));
    const sideMarkup = name => {
      const sidePortrait = scenario.portraits?.[name];
      return sidePortrait
        ? `<div class="character-speaker"><span class="avatar character-avatar" aria-hidden="true"><img src="${esc(sidePortrait)}" alt="" width="56" height="70"></span><span class="character-name">${esc(name)}</span></div>`
        : `<span class="avatar" aria-hidden="true">${esc(Array.from(name)[0])}</span>`;
    };
    return `<article class="message character-duo has-character">${sideMarkup(duoNames[0])}<div class="message-body"><div class="bubble">${formattedText}</div></div>${sideMarkup(duoNames.at(-1))}</article>`;
  }
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
      : field.symbol
      ? `<label class="answer-field answer-field-symbol"><span class="sr-only">${esc(field.label)}</span><span class="answer-field-symbol-mark" aria-hidden="true">${esc(field.symbol)}</span><span class="text-composer"><input id="answer${index ? `-${index}` : ''}" name="answer" type="text" inputmode="${esc(field.inputMode ?? 'text')}" placeholder="${esc(field.placeholder)}" autocomplete="off"${field.optional ? '' : ' required'}></span></label>`
      : `<label class="answer-field"><span class="${p.answerParts || row ? 'sr-only' : 'answer-field-label'}">${esc(field.label)}</span><span class="text-composer"><input id="answer${index ? `-${index}` : ''}" name="answer" type="text" inputmode="${esc(field.inputMode ?? 'text')}" placeholder="${esc(field.placeholder)}" autocomplete="off"${field.optional ? '' : ' required'}></span></label>`);
    const submit = `<button type="submit" class="send-button" aria-label="答えを送信">${icon('send')}</button>`;
    if (p.answerFieldsLayout === 'pairs') {
      const symbols = p.fields.some(field => field.symbol);
      const pairs = [];
      for (let index = 0; index < inputs.length; index += 2) {
        pairs.push(`<div class="answer-field-pair">${inputs.slice(index, index + 2).join('')}${symbols || index + 2 < inputs.length ? '' : submit}</div>`);
      }
      return `<form id="answer-form" class="multi-field-answer" data-fields-layout="pairs"${symbols ? ' data-symbol-fields="true"' : ''}><div class="answer-fields" role="group" aria-label="${esc(label)}">${pairs.join('')}</div>${symbols ? submit : ''}</form>`;
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

const MEI_ENDING_MARKS = { 'god-returned': 'A', 'world-saved': 'B', 'all-saved': 'C' };
const MEI_ENDING_TITLES = { 'god-returned': 'それでも、前を向いて', 'world-saved': '残酷な旅の果てに', 'all-saved': '余燼' };

function meiEndings() {
  const problem = scenario.problems.find(item => item.id === 'Q9');
  const debug = playSaves?.getStatus().mode === 'debug';
  return (problem?.answerBranches ?? []).map(branch => {
    const mark = MEI_ENDING_MARKS[branch.id] ?? '';
    const caption = MEI_ENDING_TITLES[branch.id];
    return {
      id: branch.id,
      answer: branch.answer,
      survey: mark ? `${mark}エンド${caption ? `「${caption}」` : ''}` : '',
      menuLabel: debug && mark ? `冥 終幕 ${mark}` : '冥 終幕',
      dialogue: branch.dialogue ?? [],
    };
  });
}

function visibleMeiEndings() {
  const endings = meiEndings();
  if (playSaves?.getStatus().mode === 'debug') return endings;
  const played = state.branches?.Q9;
  if (!state.solved.includes('Q9') || !played) return [];
  return endings.filter(item => item.id === played);
}

function activeMeiEnding() {
  return meiEndings().find(item => item.id === meiEndRoute) ?? null;
}

function meiEndingMenuMarkup() {
  return visibleMeiEndings().map(item => `<button data-action="mei-end" data-id="${esc(item.id)}" ${meiEndRoute === item.id ? 'aria-current="step"' : ''}><span>${esc(item.menuLabel)}</span></button>`).join('');
}

function showMeiEnding(routeId) {
  if (!visibleMeiEndings().some(item => item.id === routeId)) return;
  conversationPlayer.stop();
  isPlaying = false;
  epiloguePhase = null;
  cancelEpilogueMotion();
  composerExpanded = false;
  selectProblem('Q9', { meiEnding: routeId });
  document.querySelector('#mei-completion-title')?.focus({ preventScroll: true });
  animateSurface(document.querySelector('.mei-completion'), true, 8);
}

function problemNavigationMarkup() {
  const ending = activeMeiEnding();
  const label = ending ? ending.menuLabel : yoiEndView ? '宵 終幕' : startView ? 'スタート' : investigationView ? scenario.investigation.id : problemLabel(current());
  return `<button class="problem-toggle" data-action="toggle-problems" aria-label="問題番号を選択：${esc(label)}" aria-expanded="${problemMenuExpanded}" aria-controls="problem-menu"><span>問題番号 <strong>${esc(label)}</strong></span>${icon('chevron')}</button><nav id="problem-menu" class="problem-menu" aria-label="問題番号" ${problemMenuExpanded ? '' : 'hidden'}><button data-action="start" ${startView ? 'aria-current="step"' : ''}><span>スタート</span></button>${navigationProblems().map(p => `<button data-action="select" data-id="${esc(p.id)}" ${canOpenProblem(p, state) ? '' : 'disabled'} ${!startView && !yoiEndView && !ending && (p.id === state.selected || isInvestigation(state.selected) && p.id === scenario.investigation.id) ? 'aria-current="step"' : ''} aria-label="${esc(p.id)}${(p.id === scenario.investigation.id ? investigationComplete(scenario, state) : state.solved.includes(p.id)) ? ' 解答済み' : ''}"><span>${esc(p.id)}</span>${(p.id === scenario.investigation.id ? investigationComplete(scenario, state) : state.solved.includes(p.id)) ? icon('check') : ''}</button>${p.completionScreen === 'yoi' && (state.solved.includes(p.id) || playSaves?.getStatus().mode === 'debug') ? `<button data-action="yoi-end" ${yoiEndView ? 'aria-current="step"' : ''}><span>宵 終幕</span></button>` : ''}${p.id === 'Q9' ? meiEndingMenuMarkup() : ''}`).join('')}</nav>`;
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

function headerActionsMarkup() {
  return composerExpanded
    ? `<button class="hint-button header-actions" data-action="history" aria-label="会話履歴">${icon('history')}<span>履歴</span></button>`
    : '<span class="header-spacer header-actions" aria-hidden="true"></span>';
}

// 問題の展開・解除だけでは全面を再描画しないので、ヘッダー右端だけを差し替える。
function updateHeaderActions() {
  const slot = document.querySelector('.play-header .header-actions');
  if (slot && slot.matches('button') !== composerExpanded) slot.outerHTML = headerActionsMarkup();
  const hints = document.querySelector('#navigation-menu [data-action="hints"]');
  if (hints) hints.hidden = !composerExpanded;
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
  if (expanded) revealItems(':scope > button', menu);
  animatePop(menu, expanded).then(finished => {
    if (finished && !problemMenuExpanded && menu.isConnected) menu.hidden = true;
  });
  if (expanded) document.querySelector('.problem-toggle')?.focus({ preventScroll: true });
}

function composerContentMarkup(p) {
  const heading = `<div class="answer-composer-heading"><h2>${esc(problemLabel(p))}</h2><div class="answer-composer-actions">${ritualGuideButton(p)}<button class="composer-hint" data-action="hints" aria-label="ヒント">${icon('hint')}<span>ヒント</span></button></div></div>`;
  if (p.type === 'pending') return `${heading}<div class="answer-problem"><p>${esc(p.prompt)}</p></div>`;
  const content = (p.diagram || p.image || p.images) ? puzzleCardMarkup(p) : `<div class="answer-problem" data-problem-id="${esc(p.id)}"><p>${problemPromptMarkup(p)}</p>${p.answerTemplate ? `<p class="answer-template">${esc(p.answerTemplate)}</p>` : ''}${p.wordBank && p.showWordBank !== false ? `<div class="word-bank"><span>${esc(p.wordBankLabel ?? '語群')}</span><p>${p.wordBank.map(esc).join('、')}</p></div>` : ''}</div>
    ${answerFormMarkup(p)}
    ${['text', 'fields'].includes(p.type) ? '' : `<div class="composer-meta"><span>${p.type === 'multiple' ? p.selectionCount ? `${p.selectionCount}つ選んでください。` : '当てはまるものをすべて選んでください。' : 'ひとつ選んでください。'}</span></div>`}`;
  return `${heading}${content}<div id="answer-readiness" class="answer-readiness" role="status"></div><div id="answer-error" class="answer-error" role="status"></div><div class="feedback" role="status">${esc(feedback || storageWarning)}</div>`;
}

function puzzleTextMarkup(text) {
  const source = String(text);
  const pattern = /\{blank\}|\{stain\}|\{(red|gold|green)\}([\s\S]*?)\{\/\1\}/g;
  let html = '';
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    html += esc(source.slice(last, match.index));
    if (match[0] === '{blank}') html += '<span class="puzzle-blank">？</span>';
    else if (match[0] === '{stain}') html += '<span class="ink-stain" role="img" aria-label="赤い汚れで隠れた文字"></span>';
    else html += `<span class="ink-${match[1]}">${esc(match[2])}</span>`;
    last = match.index + match[0].length;
  }
  return html + esc(source.slice(last));
}

function puzzleImages(p = current()) {
  return p.images ?? (p.diagram || p.image ? [{ src: p.diagram ?? p.image, alt: p.diagramAlt ?? p.imageAlt ?? `${problemLabel(p)}の問題図` }] : []);
}

function ritualGuideImages(problem = current()) {
  return problem?.guideImages ?? [];
}

function ritualGuideButton(problem) {
  if (problem.id !== 'Q9' || !problem.guideImages?.length) return '';
  return `<button type="button" class="composer-hint" data-action="ritual-guide" aria-haspopup="dialog" aria-controls="panel" aria-label="ルール説明">${icon('book')}<span>ルール説明</span></button>`;
}

function ritualGuidePageButtons() {
  return ritualGuideImages().map((image, index) => `<button type="button" data-action="ritual-guide-page" data-index="${index}" aria-label="${esc(image.label)}を表示" aria-pressed="${index === q9GuideIndex}"><span>${index + 1}</span></button>`).join('');
}

function ritualGuidePagesMarkup() {
  return ritualGuideImages().length > 1 ? `<nav class="puzzle-gallery-pages" aria-label="ルール説明の切り替え">${ritualGuidePageButtons()}</nav>` : '';
}

function q9AnswerVisible() {
  return current()?.id === 'Q9' && composerExpanded && !meiEndView && !meiEndRoute && !isPlaying && !investigationView && !startView && !gateVisible;
}

// 回答欄を初めて開いたときだけ、冊子の儀式シートを画像ポップアップで見せる。
function maybeShowQ9Guide() {
  if (q9GuideSeen || !q9AnswerVisible() || !ritualGuideImages().length) return;
  if (panel.open && !panel.classList.contains('is-closing')) return;
  q9GuideSeen = true;
  q9GuideIndex = 0;
  save();
  openPanel('ritual-guide');
}

function openRitualGuide() {
  if (current()?.id !== 'Q9' || !ritualGuideImages().length || isPlaying) return;
  q9GuideIndex = 0;
  openPanel('ritual-guide');
}

function dismissRitualGuideNow() {
  if (!panel.open || panel.dataset?.kind !== 'ritual-guide') return;
  panelRevision++;
  imageViewer?.dispose();
  imageViewer = null;
  sheetDismiss?.dispose();
  sheetDismiss = null;
  panel.classList.remove('is-closing');
  panel.inert = false;
  panel.close();
  syncNavigation();
}

function setRitualGuidePage(index) {
  const images = ritualGuideImages();
  if (!panel.open || panel.dataset?.kind !== 'ritual-guide') return;
  if (!Number.isInteger(index) || index < 0 || index >= images.length || index === q9GuideIndex) return;
  const pageHadFocus = document.activeElement?.dataset?.action === 'ritual-guide-page';
  const direction = index > q9GuideIndex ? 1 : -1;
  q9GuideIndex = index;
  const image = panel.querySelector('.puzzle-full-image');
  imageViewer?.reset();
  if (image) {
    image.src = images[index].src;
    image.alt = images[index].alt;
    animatePuzzleImage(image, direction);
  }
  const pages = panel.querySelector('.puzzle-gallery-pages');
  if (pages) pages.innerHTML = ritualGuidePageButtons();
  if (pageHadFocus) panel.querySelector(`[data-action="ritual-guide-page"][data-index="${index}"]`)?.focus({ preventScroll: true });
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

const CLEAR_POST_URL = {
  yoi: 'https://x.gd/1KNjU',
  'god-returned': 'https://x.gd/XVrD3',
  'world-saved': 'https://x.gd/j4SMC',
  'all-saved': 'https://x.gd/JyINx',
};

function clearPostMarkup(url) {
  if (!url) return '';
  return `<div class="clear-post"><a class="clear-post-line" href="${esc(url)}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg><span>クリアをポスト</span><span class="sr-only">。新しいタブで開きます</span></a></div>`;
}

// 宵の終幕アンケートのあとに開く編集後記。冥のA・Bエンドはノーマルエンドの編集後記。トゥルーエンドは別途。
const AFTERWORD_PARAGRAPHS = [
  '宵をクリアされた方へ',
  'こちらのメッセージをご覧の皆さま。宵のクリアに加え、アンケートにもご回答いただき、誠にありがとうございます。皆さまからのお言葉を真摯に受け止め、作品の質の向上に必ずつなげていきたいと思います。',
  'アンケートのお礼としまして、ささやかではございますが、「編集後記」と題して、宵の裏事情を少しお話ししようと思います。分かりやすいように、問題ごとに書いていきたいと思います。',
  'N1： 実は、N1は一番最初にできた問題でもあり、一番改良を重ねた問題でもあります。当初は「赤、青、白」の表記が「R、G、W」だったり、Helloを話す人ではなく「E」という文字だけだったり、ロシアを表す「露」のイラストを入れたりと、いろいろ迷走していました。しかし、テストプレイをしてくださった方がかなりここでつまずいたため、NFの1週間前に大胆な易化を施しました。',
  'N2： N2は、筆者が作った際に手応えを感じた問題であります。2回つなげるという発想は面白かったのではないかと自負しております。しかし、「百、正、西、北」の文字群から、百万遍門と正門に馴染みのある京大生のテストプレイヤーは、すぐに解いていました……。皆さんには苦戦してもらえていたら嬉しいのですが……。',
  'N3： N3は、実は吉田南へと移動してもらうためのクッション謎であります。少し簡単だったかなと思っております。',
  'N4： N4は、これまた筆者イチ押しの問題であります。これまでは問題用紙の前で謎を解いてから次の問題へ移動する、というステップだったため、「問題を解きながら移動する」という発想が出てくるかどうかが肝だったでしょうか。',
  'N5： N5は、筆者の友人が「コナンの『ホームズの黙示録』の話みたいな謎を作りたい」と言ったところからスタートしました。余裕がある方は、コナンのその話を読んでみてください。ちなみに筆者は読んでいません。',
  'さて、雑記はここら辺にしましょうか。本当は『冥』に向けた伏線がそこかしこに張られていて、それについて触れたいのですが……。まだ詳しくは言えません（笑）と、『冥』の宣伝をさらっとしておきました。',
  '仕切り直して真面目に書きますと、『冥』はこの「11月の救祭」の後編であり、タツたちの物語の完結編であります。プレイしていただいて、絶対に後悔しないようなクオリティを保証いたします。京都大学以外のお好きな場所でも、いつでもプレイできますので、まだご購入されていない方は、ぜひともプレイをおすすめいたします。',
  'それでは、ここまで読んでいただき、ありがとうございました。編集後記でした。',
  '『冥』も最後までクリアしていただき、アンケートにご回答いただくと、全体の編集後記をご用意しております！！',
];

// 冥のAエンド・Bエンド（ノーマルエンド）をクリアし、アンケートを送ったあとに開く編集後記。
const MEI_AB_AFTERWORD_PARAGRAPHS = [
  '冥をクリア(エンドA,Bに到達)された方へ',
  'こちらのメッセージをご覧の皆さま。冥のクリアに加え、アンケートにもご回答いただき、誠にありがとうございます。皆さまからのお言葉を真摯に受け止め、作品の質の向上に必ずつなげていきたいと思います。',
  'アンケートのお礼としまして、ささやかではございますが、「編集後記」と題して、作品の裏事情を少しお話ししようと思います。',
  'さて、ここまでプレイしてくださった方々は、宵と冥に貼られてきた数々の伏線を回収してくれたとは思いますが、皆様が見逃しそうかつ作中で回収するには小ネタすぎる伏線をいくつか消化していきたいと思います。',
  '①　N1の色が変：実は最初の謎からハナの色覚異常についての伏線は貼られていました。N1をもう一度確認してみると、太陽のイラストの赤色が変ですよね...。',
  '②　末席同好会の貼り紙の色が変：こちらは、覚えている方は少ないと思いますが、末席同好会のチラシに使われている色も少し変でした。ハナは堂々と赤色と思って使った色が...ということです。',
  '③　N5の問題文が「最『期』の場所へ向かえ」になっている。正しい漢字は「最『後』」ですよね。ここもハナのお茶目心で、「あんた次の行ったところで死にまっせ」みたいな意味合いだったんですね。誤植だと思われたみなさん、違います！！！(大声)。タツたちは、「最期」の漢字を普通に「最後」と捉えて会話を進めていましたね...。気づいたところで、まさか行ったら殺されるなんて気づかず、誤植だと思うだけですが...。',
  '④　実は、N5のタイトル「Navigate to Fear」は、恐怖への誘い、もっとストレートに言うと、「お化け屋敷への誘い」だったんですよね。ほとんどの皆様が、タイトルが「NF縛り」なのは気づかれたと思うんですけど、N5のタイトルから、勘の良い人は問題を解かずとも最期の場所はお化け屋敷と気づきそうです(気づきましたか？)。これを書いていて思い出しましたが、N3のタイトル「Notice of Fortune　幸運のお告げ」はおみくじのことを暗喩しています。',
  '⑤　サダヲは本当にお腹が弱いだけ。サダヲは、犯人候補の4人のうち、唯一、何も後ろめたいことがない人です。なのに、一番疑われて...不憫なキャラです（笑）。',
  '⑥　マヤの持ち物「紙切れ」には、実は金庫の開け方が書いてあるという設定がありました。わざわざ作中で回収する程でもなく、ミスリーディング要員で置いておきました。同様にアツヤのライトに名前の刻印があるのも特に意味はありません。攪乱要員です。',
  '⑦　ハナが冥の冒頭、ミサメの死体を急に見たときに「血ってこんなスミレ色なの！？」って言ってたのは演技＆色覚異常の伏線です。隠し部屋が発見された時の、ハナの「信じられない！ありえない！」みたいな会話も彼女の演技でした。名演ですよね。作中で、タツに「演技上手かったぜ」みたいなのを最後に言わせたかったのですが、思ったより最後の展開がシリアスになってしまい、そんな余裕はありませんでした（笑）。',
  'と思い出せる主要な小ネタはこれくらいです。他にも色々散りばめた気がするので(思い出せない)、もう1度読み返してみると、色んな伏線に気づいて面白いと思いますよ！！',
  'さて、ここまでダラダラと小ネタについて書いてきましたが、もっと核心的な話を最後に書こうと思います。実は、本作は皆さん薄っすらとお気づきの通り、マルチエンドとなっております。これを読んでいる皆さんが到達されたのは「ＡエンドかＢエンド」です。はい。実は「ノーマルエンド」です。ということは...トゥルーエンドが...??　これから言うのは独り言なので聞き流してください。',
  '「宵から冊子を隅々まで読み直すと、今なら気づく伏線があるかも...。」',
  'という意味深な言葉を残して、〆にしたいと思います。ここまで読んでくださりありがとうございます！長時間のプレイありがとうございました！！',
];

const TRUE_AFTERWORD_PARAGRAPHS = [
  '冥をクリア(Trueエンドに到達)された方へ',
  'こちらのメッセージをご覧の皆さま。冥のクリアに加え、アンケートにもご回答いただき、誠にありがとうございます。こちらは、3つ目のエンド、Trueエンドのあとがきとなっております。初見でこちらにたどり着いた方は素晴らしい慧眼の持ち主です。ぜひ、あとで他2つのエンディングもご確認ください。メニューバーから再度Q9をプレイすることが可能です。',
  'せっかくなのでこちらのあとがきでは、制作秘話をお話したいと思います。我ら、Team.KusuNoKiの大文字の4文字は、昨年「クスノキが枯れた日」を発表した際のメンバー4人の名前を取ったものなのですが、今年はそこに2人を加えた6人体制で制作を行いました。（新規メンバー2人のアルファベットが刻まれていないのは文字が足りないから）',
  '私（2人目のK）は、ウェブサイト、WeBot、そして本編の3つのエンディングを担当したのですが、このワンオペ作業は非常に苦しかったです笑。学生の本分たる勉学の草鞋を脱ぎ捨て、バイトと謎解き開発に邁進した結果がこれになります。',
  '昨年は回答入力用にLineボットを使用していたのですが、使いづらさが目立ち、回答入力だけでなく、より柔軟な表現や入力などができるようにウェブアプリを構築しました。使い勝手のほどはいかがでしたでしょうか？開発において大変だったのが、やはりデザイン面とバグの解消です。私自身がこだわり派の人間なこともあり、見やすい、滑らかに動く、わかりやすい統一的なデザインを模索したため、構築に非常に時間を要してしまいました。この程度の小さいアプリでもバグは結構出るもので、テストプレイ段階で画像の差し替えや動作不良が続々と見つかりまして、その都度求められる修正作業が必要でした。',
  '私は謎づくりのセンスはまったくないのですが、チームメンバーには才能を持つものが何人かいまして、彼らの作る謎を一般人の視点でレビューしておりました。特に私の評価が高いのはN4の標識の謎とQ9の儀式の工作の謎です。去年にはなかったテイストの謎であり、テストプレイをして感動しました。',
  'そして3つのエンディングですが、ぜひ感想を伺いたく思います。3つのエンディングは1本あたり4時間近く思考して書き上げています。Xなどで好きなエンディングを答えていただけると幸いです。個人的な好みはA。',
  '前作ではシナリオを担当したものの、今作ではウェブアプリの構築や最終的に断念したもののNFで販売予定だった別の作品に取り組んでいたこともあってエンディングに専念させていただきました。3つのエンドは「選択」をテーマとして、中でもノーマルエンドの2つは、選択のもたらす結末への向き合い方について2つのパターンを示すエンドにしたつもりです。やはり、物語的で綺麗な結末なのは中断ルート（ルートA）で、私の実際の思考に近いのは続行ルート（ルートB）かなと思っています。約束の伏線はルートAを書き上げたあとに物語内に仕込みました。そしてこのTrueルートは、2つのルート完成後に、既存の約束を発展させつつタツの強い決意を引き出すため、多くを語らなかったミサメの行動原理に触れ、最終的に約束を叶えた暁に未来につながる新しい約束を結ぶという展開を構想した次第です。',
  'このエンドの末文「窓の外はあの日のような宵の空。落日の深青に漂う茜色の余燼が冒険の終わりと次なる旅路を予感させた。」は私のお気に入りです。余燼（よじん）とは焚き火のあとで炎が消え、赤くくすぶって燃え残っている火のことを指します。この単語から終わりだけでなく同時に次の日の出立＝これからの未来を連想し、この結末にピッタリの表現だと考え採用しました。',
  '最後となりますが、ここまでプレイしていただきありがとうございました。去年できなかったことをやりたいという思いから、今年はウェブアプリの導入、周遊要素を増した謎、工作をする謎、マルチエンディングなど新しい挑戦を多数導入しました。至らぬところは多々あったと思いますが楽しんでいただけたら光栄です。まだ他のエンドを見ていないという方はぜひそちらもお楽しみください。来年の出展はまだ予定しておりませんが、皆様の声が励みとなります。公式Xのフォローもよろしくお願いします。この度はありがとうございました',
];

const TRUE_AFTERWORD_NOTES = [
  '①　N1の色が変：実は最初の謎からハナの色覚異常についての伏線は貼られていました。N1をもう一度確認してみると、太陽のイラストの赤色が変ですよね...。',
  '②　末席同好会の貼り紙の色が変：こちらは、覚えている方は少ないと思いますが、末席同好会のチラシに使われている色も少し変でした。ハナは堂々と赤色と思って使った色が...ということです。',
  '③　N5の問題文が「最『期』の場所へ向かえ」になっている。正しい漢字は「最『後』」ですよね。ここもハナのお茶目心で、「あんた次の行ったところで死にまっせ」みたいな意味合いだったんですね。誤植だと思われたみなさん、違います！！！(大声)。タツたちは、「最期」の漢字を普通に「最後」と捉えて会話を進めていましたね...。気づいたところで、まさか行ったら殺されるなんて気づかず、誤植だと思うだけですが...。',
  '④　実は、N5のタイトル「Navigate to Fear」は、恐怖への誘い、もっとストレートに言うと、「お化け屋敷への誘い」だったんですよね。ほとんどの皆様が、タイトルが「NF縛り」なのは気づかれたと思うんですけど、N5のタイトルから、勘の良い人は問題を解かずとも最期の場所はお化け屋敷と気づきそうです(気づきましたか？)。これを書いていて思い出しましたが、N3のタイトル「Notice of Fortune　幸運のお告げ」はおみくじのことを暗喩しています。',
  '⑤　サダヲは本当にお腹が弱いだけ。サダヲは、犯人候補の4人のうち、唯一、何も後ろめたいことがない人です。なのに、一番疑われて...不憫なキャラです（笑）。',
  '⑥　マヤの持ち物「紙切れ」には、実は金庫の開け方が書いてあるという設定がありました。わざわざ作中で回収する程でもなく、ミスリーディング要員で置いておきました。同様にアツヤのライトに名前の刻印があるのも特に意味はありません。攪乱要員です。',
  '⑦　ハナが冥の冒頭、ミサメの死体を急に見たときに「血ってこんなスミレ色なの！？」って言ってたのは演技＆色覚異常の伏線です。隠し部屋が発見された時の、ハナの「信じられない！ありえない！」みたいな会話も彼女の演技でした。名演ですよね。作中で、タツに「演技上手かったぜ」みたいなのを最後に言わせたかったのですが、思ったより最後の展開がシリアスになってしまい、そんな余裕はありませんでした（笑）。',
  '最後の儀式シートは去年初めて謎解きを作成した段階からずっと組み込みたいと思っていた仕様でした。今回初めての試みだということでかなり難しく、理不尽な出来になってしまい申し訳ありませんでした。ただ、自分の作りたいものが作れたのかなと満足している部分もあります。この謎で特に意識したのは「動き」と「立体」です。紙をただ折るのではなくそこに動きと奥行きを加える事で紙をただの平面に留まらず、より高い次元で見て頂けるのではないかと期待しました。その分難しくなってしまいましたが笑',
];

function afterwordParagraphs(texts) {
  return texts.filter(text => typeof text === 'string' && text.trim()).map(text => `<p>${esc(text)}</p>`).join('');
}

function afterwordMarkup() {
  const trueEnding = meiEndRoute === 'all-saved';
  const paragraphs = meiEndRoute === 'god-returned' || meiEndRoute === 'world-saved'
    ? MEI_AB_AFTERWORD_PARAGRAPHS
    : trueEnding ? TRUE_AFTERWORD_PARAGRAPHS
    : !meiEndView && !meiEndRoute ? AFTERWORD_PARAGRAPHS : [];
  const letter = afterwordParagraphs(paragraphs);
  const notes = trueEnding ? afterwordParagraphs(TRUE_AFTERWORD_NOTES) : '';
  const note = notes
    ? `<details class="afterword-note"><summary>制作者より一言${icon('chevron')}</summary><div class="afterword-note-body"><p class="afterword-note-heading">冥の謎について</p>${notes}</div></details>`
    : '';
  const body = letter || note
    ? `${letter}${note}`
    : '<p class="afterword-placeholder">あとがきの本文は、ここに表示されます。</p>';
  return `<section class="afterword" aria-labelledby="panel-title">
    <button class="icon-button afterword-close" data-action="close" aria-label="閉じる">${icon('close')}</button>
    <header class="afterword-heading">
      <h1 id="panel-title" class="afterword-kicker" tabindex="-1">11月の救祭</h1>
      <div class="afterword-rule" aria-hidden="true"></div>
    </header>
    <div class="afterword-scroll" tabindex="0">${body}</div>
    <div class="afterword-actions">
      <button type="button" class="secondary-button" data-action="close">終幕に戻る</button>
    </div>
  </section>`;
}

function yoiCompletionMarkup() {
  return `<section class="yoi-completion" aria-labelledby="yoi-completion-title">
    <div class="yoi-completion-copy"><p class="yoi-completion-label">11月の救祭</p><h1 id="yoi-completion-title" tabindex="-1">宵</h1><p class="yoi-completion-end">終幕</p><p>「11月の救祭 宵」はここで終了です。<br>遊んでいただきありがとうございました。</p>${clearPostMarkup(CLEAR_POST_URL.yoi)}<p class="yoi-completion-follow">冊子後半、「11月の救祭 冥」は会場でもご自宅でもお好きな場所、お好きな時間にプレイすることが可能です。</p></div>
    <div class="yoi-completion-actions" role="group" aria-label="続きの遊び方">
      ${meiPlayChoiceVisible ? `
      <button class="primary-button yoi-venue-button" data-action="continue-at-venue"><span>会場でプレイする</span></button>
      <button class="secondary-button yoi-online-button" data-action="continue-online"><span>オンラインでプレイする</span></button>
      ` : `
      <button class="primary-button yoi-venue-button" data-action="play-mei"><span>11月の救祭 冥 をプレイする</span></button>
      `}
      <button class="secondary-button yoi-online-button" data-action="tour-thanks"><span>周遊版をご購入の方はこちら</span></button>
    </div>
    ${storageWarning ? `<p class="feedback" role="status">${esc(storageWarning)}</p>` : ''}
  </section>`;
}

function meiCompletionMarkup() {
  const clearPostUrl = CLEAR_POST_URL[meiEndRoute] ?? '';
  const clearPostNote = clearPostUrl ? `<p class="yoi-completion-follow">今後の参考にするためアンケートにご協力ください。（1分）</p><p class="yoi-completion-follow">ご回答いただいた方には、ささやかなお礼として、制作の裏話を綴ったあとがきを公開しております。</p><p class="yoi-completion-follow yoi-completion-replay">メニューバーから再度Q9をプレイ可能です。</p>` : '';
  return `<section class="yoi-completion mei-completion" aria-labelledby="mei-completion-title" data-mei-ending="${esc(meiEndRoute)}">
    <div class="yoi-completion-copy"><p class="yoi-completion-label">11月の救祭</p><h1 id="mei-completion-title" tabindex="-1">冥</h1><p class="yoi-completion-end">終幕</p><p>「11月の救祭 冥」はここで終了です。<br>遊んでいただきありがとうございました。</p>${clearPostMarkup(clearPostUrl)}${clearPostNote}</div>
    <div class="yoi-completion-actions" role="group" aria-label="終了後の案内">
      <button class="primary-button" data-action="mei-survey"><span>アンケートに答える</span></button>
    </div>
    ${storageWarning ? `<p class="feedback" role="status">${esc(storageWarning)}</p>` : ''}
  </section>`;
}

function surveyEndingAnswer() {
  return activeMeiEnding()?.answer ?? '';
}

function surveyFormMarkup() {
  const code = normalizePlayCode(playSaves.getRecord()?.code);
  const legend = (label, required = true, note = '') => `<legend class="survey-legend">${esc(label)}<span class="${required ? 'survey-required' : 'survey-optional'}">${required ? '必須' : '任意'}</span></legend>${note ? `<p class="survey-note">${esc(note)}</p>` : ''}`;
  const ending = activeMeiEnding();
  const choices = (name, values, disabled = false, selected = '') => `<div class="survey-choices">${values.map(value => `<label class="option"><input type="radio" name="${name}" value="${esc(value)}" required ${disabled ? 'disabled' : ''} ${value === selected ? 'checked' : ''}><span>${esc(value)}</span></label>`).join('')}</div>`;
  const scale = (name, low, high, disabled = false) => `<div class="survey-scale${disabled ? ' is-disabled' : ''}">
    <div class="survey-scale-labels"><span>${esc(low)}</span><span>${esc(high)}</span></div>
    <div class="survey-scale-track" data-scale-track role="slider" tabindex="${disabled ? -1 : 0}" aria-valuemin="1" aria-valuemax="5" aria-valuetext="未選択" aria-label="${esc(`${low}から${high}まで`)}" aria-disabled="${disabled ? 'true' : 'false'}" data-low="${esc(low)}" data-high="${esc(high)}">
      <div class="survey-scale-rail" aria-hidden="true"><div class="survey-scale-fill"></div><span class="survey-scale-dots"><i></i><i></i><i></i><i></i><i></i></span></div>
      <div class="survey-scale-thumb" aria-hidden="true"></div>
      <span class="survey-scale-hint">横に動かして選ぶ</span>
    </div>
    <p class="survey-scale-readout" aria-hidden="true"></p>
    <input class="survey-scale-input" type="hidden" name="${esc(name)}" value="" ${disabled ? 'disabled' : ''}>
  </div>`;
  return `<form id="survey-form">
    <p class="panel-intro">本日はクスノキの謎解きにご参加いただき、ありがとうございました。今後の参考にさせていただきますので、ご協力をお願いします。</p>
    ${code ? '' : '<p class="feedback" role="alert">再開番号がまだ発行されていません。通信状態を確認してから開き直してください。</p>'}
    <fieldset class="survey-field">${legend('今回はどこまでプレイされましたか？')}${choices('progress', ['宵', '宵と冥'], false, ending ? '宵と冥' : '')}</fieldset>
    <fieldset class="survey-field">${legend('所属を教えてください')}${choices('affiliation', ['小学生', '中学生', '高校生', '大学生', '社会人', 'その他'])}</fieldset>
    <fieldset class="survey-field">${legend('宵（謎解き）のボリューム', true, '1＝少ない、3＝丁度良い、5＝多い')}${scale('yoiVolume', '少ない', '多い')}</fieldset>
    <fieldset class="survey-field">${legend('宵（謎解き）の難易度', true, '1＝簡単、3＝丁度良い、5＝難しい')}${scale('yoiDifficulty', '簡単', '難しい')}</fieldset>
    <div id="survey-mei" ${ending ? '' : 'hidden'}>
      <fieldset class="survey-field">${legend('冥（推理）のボリューム', true, '1＝少ない、3＝丁度良い、5＝多い')}${scale('meiVolume', '少ない', '多い', !ending)}</fieldset>
      <fieldset class="survey-field">${legend('冥（推理）の難易度', true, '1＝簡単、3＝丁度良い、5＝難しい')}${scale('meiDifficulty', '簡単', '難しい', !ending)}</fieldset>
      <fieldset class="survey-field">${legend('最初に辿り着いた結末はどれですか？')}${choices('ending', meiEndings().map(item => item.survey).filter(Boolean), !ending, ending?.survey ?? '')}</fieldset>
    </div>
    <fieldset class="survey-field">${legend('ご感想やご意見をお聞かせください。', false)}<textarea name="feedback" class="survey-textarea" rows="4"></textarea></fieldset>
    <p id="survey-error" class="survey-error" role="alert" hidden></p>
    <button class="primary-button full" type="submit" ${code ? '' : 'disabled'}>送信する</button>
  </form>`;
}

function contactFormMarkup() {
  const field = (id, label, required, control) => `<div class="contact-field"><label for="${id}">${esc(label)}<span class="${required ? 'survey-required' : 'survey-optional'}">${required ? '必須' : '任意'}</span></label>${control}</div>`;
  return `<form id="contact-form">
    <p class="panel-intro">作品やアプリへのご質問・ご感想をお送りください。送信内容はTeam.KusuNoKi宛のメールになります。</p>
    ${field('contact-name', 'お名前', true, '<input id="contact-name" name="name" type="text" required maxlength="100" autocomplete="name">')}
    ${field('contact-email', 'メールアドレス', true, '<input id="contact-email" name="email" type="email" required maxlength="320" autocomplete="email" inputmode="email">')}
    ${field('contact-subject', '件名', false, '<input id="contact-subject" name="subject" type="text" maxlength="200">')}
    ${field('contact-message', 'お問い合わせ内容', true, '<textarea id="contact-message" name="message" class="survey-textarea" rows="6" required maxlength="8000"></textarea>')}
    <div class="contact-hp" aria-hidden="true"><label>ウェブサイト<input name="website" type="text" tabindex="-1" autocomplete="off"></label></div>
    <p id="contact-error" class="survey-error" role="alert" hidden></p>
    <button class="primary-button full" type="submit">送信する</button>
  </form>`;
}

function showChapterTransition() {
  if (reducedMotion()) return;
  syncPlayChrome();
  const workspace = document.querySelector('.workspace');
  workspace?.insertAdjacentHTML('beforeend', '<div class="chapter-transition" role="presentation"></div>');
  const cover = document.querySelector('.chapter-transition');
  if (!cover?.animate) { cover?.remove(); return; }
  const animation = cover.animate([
    { opacity: 1, backgroundColor: '#24324f' },
    { opacity: 1, backgroundColor: '#121418', offset: .78 },
    { opacity: 0, backgroundColor: '#121418' },
  ], { duration: 2200, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'both' });
  void animation.finished.catch(() => {}).finally(() => { cover.remove(); animation.cancel(); });
}

function playBrandTitle() {
  return `${scenario.title} ${current()?.chapter === '第二章' ? '冥' : '宵'}`;
}

function historyProblems() {
  const solved = scenario.problems.filter(item => state.solved.includes(item.id) && !item.advanceTo);
  if (meiEndRoute && !solved.some(item => item.id === 'Q9')) {
    const endingProblem = scenario.problems.find(item => item.id === 'Q9');
    if (endingProblem) solved.push(endingProblem);
  }
  return solved.reverse();
}

function historyDialogueMarkup(item, visibleMessages) {
  if (item.id === 'Q9' && meiEndRoute) {
    const ending = activeMeiEnding();
    if (ending) return ending.dialogue.map(line => line.scene
      ? `<p class="narration">${line.speaker ? esc(line.speaker) : ''}${esc(line.text)}</p>`
      : messageMarkup({ ...line, kind: 'dialogue', problemId: 'Q9' })).join('');
  }
  return visibleMessages.filter(message => message.problemId === item.id && isConversationLine(message)).map(messageMarkup).join('');
}

function secondaryScreenHeader(backAction, { showHint = true, title, headingId } = {}) {
  const trailing = showHint
    ? `<button class="hint-button" data-action="hints" aria-label="ヒント">${icon('hint')}<span>ヒント</span></button>`
    : '<span class="header-spacer" aria-hidden="true"></span>';
  const titleId = headingId ?? (backAction === 'close' ? 'panel-title' : '');
  return `<header class="topbar clue-screen-header"><div class="brand"><button class="menu-button clue-back" data-action="${backAction}" aria-label="戻る">${icon('arrow')}</button><span${titleId ? ` id="${esc(titleId)}"` : ''}${headingId ? ' tabindex="-1"' : ''} class="brand-title">${esc(title ?? playBrandTitle())}</span></div>${trailing}</header>`;
}

function historyScreenMarkup() {
  const visibleMessages = isPlaying ? [...state.messages.slice(0, sceneStart), ...displayedMessages] : state.messages;
  const entries = historyProblems().map(item =>
    `<details class="history-entry" data-history-problem="${esc(item.id)}" ${historyOpenProblems.has(item.id) ? 'open' : ''}><summary><span class="history-question">${esc(problemLabel(item))}</span>${icon('chevron')}</summary><div class="history-messages">${historyDialogueMarkup(item, visibleMessages)}</div></details>`).join('');
  return `<section class="history-screen" aria-labelledby="history-heading">${secondaryScreenHeader('history-back', { showHint: false, title: '会話履歴', headingId: 'history-heading' })}<div class="history-body">${entries || '<div class="empty-state history-empty"><p>まだ会話履歴はありません。</p><p>問題に正解すると、ここに会話が届きます。</p></div>'}</div></section>`;
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

function restoreSceneNarration() {
  // 終幕を開いているときは、最後の場面を上に被せず宵の終幕と同じ画面を出す。
  if (meiEndView || meiEndRoute) {
    epiloguePhase = null;
    return;
  }
  if (gateVisible || historyView || startView || isPlaying || investigationView || epiloguePhase === 'blackout') return;
  const last = displayedMessages.at(-1);
  if (last?.epilogue && last.scene && last.problemId === current().id) {
    epiloguePhase = 'line';
    return;
  }
  if (epiloguePhase === 'line' && !last?.epilogue) epiloguePhase = null;
}

function render({ scroll = false, peelingConclusions = [] } = {}) {
  if (gateVisible) { renderEntry(); return; }
  restoreSceneNarration();
  if (historyView) historyScrollTop = document.querySelector('.history-body')?.scrollTop ?? historyScrollTop;
  const chatScrollTop = document.querySelector('.chat-area')?.scrollTop ?? 0;
  const previousComposer = document.querySelector('.composer-area');
  const previousComposerHeight = previousComposer && !previousComposer.hidden ? previousComposer.getBoundingClientRect?.().height : 0;
  const p = current();
  const solved = state.solved.includes(p.id);
  const sceneProblem = composerExpanded && answerOrigin ? scenario.problems.find(item => item.id === answerOrigin.problemId) : p;
  const inInvestigation = !startView && !investigationView && isInvestigation(sceneProblem.id);
  const investigationReturnVisible = inInvestigation && !composerExpanded && state.solved.includes(sceneProblem.id) && !isPlaying && !(answerOrigin?.repeatAnswer ?? repeatAnswer);
  const nextProblem = followingProblem(p);
  const resumedAnswer = !composerExpanded && answerOrigin?.problemId === p.id && scenario.problems.find(item => item.id === answerOrigin.answerId);
  const answerTarget = resumedAnswer || (!startView && !repeatAnswer && solved ? nextProblem ?? p : p);
  const guideNext = showsGuideStop(sceneProblem, answerOrigin?.repeatAnswer ?? repeatAnswer);
  const opensProblemList = answerTarget.id === scenario.investigation.id && !inInvestigation;
  const sectionFinished = solved && !nextProblem && !startView && !repeatAnswer;
  const completionPending = awaitingYoiPageTurn();
  const composerVisible = !investigationView && !yoiEndView && !meiEndRoute && (!solved || startView || repeatAnswer) && !isPlaying && composerExpanded;
  const boardBackground = !startView && p.conversationBackground === 'investigation';
  // 冊子をめくる暗転は、捜査一覧の背景より前面に出す。
  const deferredPageTurn = !isPlaying && !composerExpanded && !investigationView && !pageTurnRevealed && p.deferPageTurn && showsGuideStop(p);
  const showBoard = investigationView || boardBackground;
  // めくり指示の場面と、捜査が揃って「次へ」を促す場面では同じ暗さに落とす。
  const sceneDim = deferredPageTurn || (investigationView && investigationComplete(scenario, state));
  const sceneDimLate = sceneDim && peelingConclusions.length > 0;
  const answerPageVisible = p.answerPresentation === 'page' && composerVisible;
  const showStartGuide = startView || (p.id === 'N1' && !isPlaying && (!solved || repeatAnswer) && !displayedMessages.length);
  const inFinalEpilogue = Boolean(epiloguePhase) || displayedMessages.some(message => message.epilogue || message.scene);
  const showClues = p.chapter === '第二章' && !startView && !yoiEndView && !meiEndRoute && !meiEndView && !inFinalEpilogue;
  const clueCount = showClues ? unlockedCards(scenario, state).length : 0;
  const showDeductionGuide = ['Q1', 'Q1.1'].includes(sceneProblem.id) && !isPlaying && !displayedMessages.length;
  const characterScene = displayedMessages.some(message => message.speaker && message.kind === 'dialogue');
  const lastMessage = displayedMessages.at(-1);
  const lastScene = scenario.problems.find(item => item.id === lastMessage?.problemId);
  const storyBackdrop = !isPlaying && hasStoryPageTurn(lastScene);
  const heldNarration = !isPlaying && p.id === 'Q9' && q9NarrationOnly();
  // めくり暗転で締まる場面は、背景に案内を残さず最後の台詞だけを出す。
  const transcript = characterScene ? displayedMessages.filter(message =>
    isSceneNotice(message) && !storyBackdrop) : heldNarration ? [] : displayedMessages;
  const lastStoryLine = storyBackdrop && (lastScene === sceneProblem || !transcript.length)
    ? displayedMessages.findLast(m => m.problemId === lastScene.id && m.kind === 'dialogue' && !isSceneNotice(m)) : null;
  // 案内のない会話は、読了後も最後の台詞を表示する。
  const closingAvailable = canReadInvestigationClosing();
  const novel = !showBoard && (isPlaying ? novelPlayback : heldNarration || completionPending || deferredPageTurn || lastStoryLine || closingAvailable || characterScene && !transcript.length && !sceneProblem.instruction);
  const novelLine = completionPending
    ? displayedMessages.findLast(m => m.problemId === p.id && m.speaker) ?? p.dialogue.findLast(m => m.speaker)
    : lastStoryLine || lastMessage;
  const recalling = Boolean(lastMessage?.recall);
  const sceneSource = recalling ? null : displayedMessages.findLast(message => message.background || epilogueSceneArt[message.scene]);
  const sceneArt = meiEndView || yoiEndView ? '' : sceneSource?.background || epilogueSceneArt[sceneSource?.scene] || '';
  const showPetals = Boolean(displayedMessages.at(-1)?.flashback);
  const appearPortrait = !epiloguePhase && scenario.portraits?.[displayedMessages.at(-1)?.appear];
  const appearMarkup = appearPortrait ? `<span class="scene-appear" aria-hidden="true"><img src="${esc(appearPortrait)}" alt=""></span>` : '';
  const branchPending = solved && !isPlaying && !startView && p.branches && !state.branches[p.id];
  let workspace = document.querySelector('.workspace');
  if (!workspace) {
    app.innerHTML = '<div class="shell"><main id="main" class="workspace"></main></div>';
    workspace = document.querySelector('.workspace');
  }
  workspace.className = `workspace${novel ? ' novel-workspace' : ''}${p.chapter === '第二章' ? ' chapter-mei' : ''}${recalling ? ' recall' : ''}${historyView ? ' history-is-open' : ''}${sceneDim ? ' scene-dim' : ''}${sceneDimLate ? ' scene-dim-late' : ''}${sceneArt ? ' has-scene-art' : ''}`;
  workspace.inert = false;
  // 暗転中の再描画で黒を外すと、次の場面が一瞬見える。カバーは描き直した画面の上へ戻す。
  const heldBlackout = workspace.querySelector?.('.scene-blackout') ?? null;
  heldBlackout?.remove?.();
  workspace.innerHTML = `
      ${sceneArt ? `<div class="scene-art" style="background-image:url('${esc(sceneArt)}')">${showPetals ? sakuraFallMarkup() : ''}${appearMarkup}</div>` : ''}
      <header class="play-header"><div class="topbar"><div class="brand"><div class="navigation-menu"><button class="menu-button" data-action="toggle-menu" aria-label="メニュー" aria-controls="navigation-menu" aria-expanded="${menuExpanded}">${icon('menu')}</button><nav id="navigation-menu" class="menu-items" ${menuExpanded ? '' : 'hidden'} aria-label="メインメニュー"><button class="active" data-action="chat" aria-current="page">${icon('chat')}<span>トーク</span></button><button data-action="hints" ${composerExpanded ? '' : 'hidden'}>${icon('hint')}<span>ヒント</span></button>${showClues ? `<button data-action="clues">${icon('cards')}<span>手がかり</span>${clueCount ? `<small class="nav-badge">${clueCount}</small>` : ''}</button>` : ''}<button data-action="history">${icon('history')}<span>履歴</span></button><button data-action="save-info">${icon('numberTicket')}<span>再開番号</span></button><button data-action="trouble">${icon('warning')}<span>トラブル</span></button><button data-action="contact">${icon('mail')}<span>お問い合わせ</span></button><button data-action="save-title">${icon('home')}<span>タイトルに戻る</span></button>${replayMenuSection()}</nav></div><span class="brand-title">${esc(playBrandTitle())}</span></div>${headerActionsMarkup()}</div>
        <div class="play-toolbar">
          <div class="play-nav-group">
            <div id="problem-navigation" class="problem-navigation">${problemNavigationMarkup()}</div>
            ${inInvestigation && !investigationReturnVisible ? '<button class="investigation-back" data-action="investigation-back">問題一覧へ</button>' : ''}
          </div>
          <div class="play-actions">
            ${showClues ? `<button class="clue-button" data-action="clues" aria-label="手がかり">${icon('cards')}<span>手がかり</span></button>` : ''}
            ${investigationView ? `<button class="answer-fab investigation-next" data-action="investigation-next" ${investigationComplete(scenario, state) ? '' : 'disabled'} aria-describedby="investigation-next-status">${icon('edit')}<span>次へ</span></button>`
              : completionPending || p.type === 'pending' || isPlaying || branchPending || yoiEndView || meiEndRoute || meiEndView || sectionFinished || deferredPageTurn ? '' : guideNext
              ? `<button class="answer-fab" data-action="travel-next" aria-haspopup="dialog" aria-controls="panel" ${composerVisible ? 'disabled' : ''}>${icon('edit')}<span>次へ</span></button>`
              : `<button class="answer-fab" data-action="open-composer" ${composerVisible ? 'disabled' : ''} ${opensProblemList ? '' : `aria-controls="composer-area" aria-expanded="${composerExpanded}"`}>${icon('edit')}<span>次へ</span></button>`}
          </div>
        </div>
      </header>
      ${playSaves?.getStatus().mode === 'debug' ? '' : `<div class="save-status-strip${storageWarning ? ' save-warning' : ''}"><span data-save-status>${esc(playSaves?.getStatus().message ?? '')}</span></div>`}
      ${(meiEndRoute || meiEndView) ? meiCompletionMarkup() : yoiEndView ? yoiCompletionMarkup() : ''}
      ${p.type === 'pending' ? `<section class="q4-pending"><h1>${esc(p.title)}</h1><p>${esc(p.prompt)}</p><button class="primary-button" data-action="investigation-back">問題一覧へ戻る</button></section>` : ''}
      <section class="chat-area${novel ? ' novel-area' : ''}${showStartGuide ? ' start-view' : ''}${showBoard ? ' investigation-hub' : ''}${inInvestigation ? ' investigation-detail' : ''}" aria-label="${showStartGuide ? 'WeBotの使い方' : showDeductionGuide ? '推理パートの進め方' : showBoard ? '残された違和感の一覧' : '謎解き会話'}" tabindex="0" ${boardBackground && composerVisible ? 'inert' : ''} ${yoiEndView || meiEndRoute || meiEndView || p.type === 'pending' || answerPageVisible ? 'hidden' : ''}>
        ${showStartGuide ? `<article class="start-guide guide-card" aria-labelledby="start-guide-heading">
          <header class="guide-card-heading"><span class="guide-card-icon" aria-hidden="true">${icon('chat')}</span><h1 id="start-guide-heading">WeBotの使い方</h1></header>
          <p>「11月の救祭」では、謎の回答提出やヒントの閲覧、各地点への誘導などに独自開発のWebBot、通称「WeBot」を使用します。本アプリでは進行状況を記録するため、時間を空けて途中からプレイすることも可能です。</p>
          <p>別の端末で続きを遊ぶときは、タイトル画面で「続きから」を選び、6桁の再開番号を入力してください。</p>
          <div class="start-guide-menu">
            <img class="start-guide-menu-image" src="../assets/menu-guide-annotated.webp" width="1080" height="528" alt="画面左上の三本線メニューを丸と矢印で示した画像">
            <p>画面左上の三本線からメニューを開き、「再開番号」を選ぶと番号を確認できます。ヒントや会話の履歴を見たいときも、タイトルに戻りたいときも、このメニューを使います。</p>
          </div>
        </article>` : ''}
        ${showDeductionGuide && showVenueDirections ? `<article class="start-guide guide-card venue-guide" aria-labelledby="venue-guide-heading">
          <header class="guide-card-heading"><span class="guide-card-icon" aria-hidden="true">${icon('map')}</span><h1 id="venue-guide-heading">会場への行き方</h1></header>
          ${travelGuideMarkup(scenario.venueGuide, 'venue')}
          <p class="venue-guide-note">会場で印刷した資料を受け取ったら、下の「推理パートの進め方」をお読みください。</p>
        </article>` : ''}
        ${showDeductionGuide ? `<article class="start-guide guide-card" aria-labelledby="deduction-guide-heading">
          <header class="guide-card-heading"><span class="guide-card-icon" aria-hidden="true">${icon('hint')}</span><h1 id="deduction-guide-heading">推理パートの進め方</h1></header>
          <p>「11月の救祭 冥」では手がかりとなるカード等を用いて、事件の解決に取り組んでいただきます。</p>
          <div class="start-guide-menu deduction-guide-split">
            <figure class="deduction-guide-toolbar">
              <img src="../assets/q1-clue-toolbar.png" width="914" height="248" alt="WeBot上部の「手がかり」ボタン。画面上部の右側にあります。">
              <svg viewBox="0 0 914 248" aria-hidden="true"><rect x="455" y="147" width="190" height="86" rx="43" fill="none" stroke="currentColor" stroke-width="5"/><path d="M406 240 L462 209" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round"/><path d="M472 203 L455 225 L445 208 Z" fill="currentColor"/></svg>
            </figure>
            <div class="start-guide-menu-copy">
              <p>オンラインでプレイされる方は、画面上部の「手がかり」のボタンから、事件に関する資料を確認することが可能です。</p>
            </div>
          </div>
          <p>会場でプレイされる方は、画面上の「手がかり」ボタンに加えて、印刷した資料を会場で受け取ってプレイすることも可能です。</p>
        </article>` : ''}
        ${showBoard ? investigationMarkup(peelingConclusions) : ''}
        ${novel && novelLine ? novelSceneMarkup(novelLine) : `<div id="messages" class="messages" role="log" aria-label="会話" aria-live="polite" aria-relevant="additions text">${showBoard ? '' : transcript.map(messageMarkup).join('')}</div>`}
        ${branchPending ? `<div class="branch-options" aria-label="会話の選択肢">${p.branches.map(b => `<button data-action="branch" data-id="${esc(b.id)}">${esc(b.label)}</button>`).join('')}</div>` : ''}
        ${sceneProblem.instruction && !hasStoryPageTurn(sceneProblem) && state.solved.includes(sceneProblem.id) && !isPlaying && !startView && !displayedMessages.some(message => !message.speaker && normalizePageTurnText(message.text) === normalizePageTurnText(sceneProblem.instruction)) ? instructionCardMarkup(sceneProblem.instruction) : ''}
        ${(solved || isPlaying) && storageWarning ? `<div class="feedback" role="status">${esc(storageWarning)}</div>` : ''}
      ${investigationView ? `<p id="investigation-next-status" class="sr-only">${investigationComplete(scenario, state) ? 'すべての謎を解きました。' : 'すべての謎を解くと、次へ進めます。'}</p>` : ''}
      </section>
      ${deferredPageTurn ? `<button type="button" class="page-turn-scene" data-action="travel-next"><span class="page-turn-scene-icon" aria-hidden="true">${icon('book')}</span><span class="page-turn-scene-text">${esc(pageTurnLabel(p))}<span class="page-turn-scene-cue" aria-hidden="true">▷</span></span></button>` : ''}
      ${investigationReturnVisible && !closingAvailable ? '<button class="investigation-return" data-action="investigation-back">問題一覧へ戻る</button>' : ''}
      <button id="conversation-notice" class="conversation-notice" data-action="continue-conversation" aria-live="polite" aria-atomic="true" hidden>↓ 続きの会話</button>
      <section id="composer-area" class="composer-area${answerPageVisible ? ' answer-page' : ''}" aria-label="${answerPageVisible ? `${esc(p.id)}の回答画面` : '問題と回答'}" tabindex="-1" ${composerVisible ? '' : 'hidden'}>
        ${p.answerPresentation === 'page' && !composerVisible ? '' : composerContentMarkup(p)}
      </section>
      ${historyView ? historyScreenMarkup() : ''}`;
  if (sceneArt !== shownSceneArt) {
    if (sceneArt) animateFade(workspace.querySelector?.('.scene-art'), true, MOTION.state);
    shownSceneArt = sceneArt;
  }
  const pageTurnButton = workspace.querySelector?.('.page-turn-scene');
  if (pageTurnButton) {
    if (!pageTurnSceneArmed) {
      pageTurnSceneArmed = true;
      animateFade(pageTurnButton, true);
    }
  } else pageTurnSceneArmed = false;
  if (heldBlackout) workspace.append?.(heldBlackout);
  lockPlayContent(investigationClosing || Boolean(epiloguePhase));
  syncPlayChrome();
  const previousClosing = document.querySelector('.investigation-closing:not(.is-leaving)');
  if (previousClosing && !investigationClosing && previousClosing.animate && !reducedMotion()) {
    previousClosing.classList.add('is-leaving');
    previousClosing.inert = true;
    previousClosing.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.enter, easing: MOTION.ease, fill: 'forwards' })
      .finished.catch(() => {}).finally(() => previousClosing.remove());
  } else previousClosing?.remove();
  if (investigationClosing) mountWorkspaceCover(investigationClosingMarkup());
  mountEpilogue(workspace);
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
  if (showClues) {
    const unlocked = unlockedCards(scenario, state);
    const ids = new Set(unlocked.map(card => card.id));
    const previousIds = knownUnlockedIds;
    knownUnlockedIds = ids;
    knownClueCount = clueCount;
    if (previousIds && !panel.open) {
      const gained = unlocked.filter(card => !previousIds.has(card.id));
      const physical = gained.find(card => card.id === '404');
      if (physical) {
        const gallery = (scenario.clueGallery ?? []).find(card => card.requires?.card === '404');
        presentCardReward(gallery ?? physical, false);
      } else if (gained.length) announceNewClue(gained.length);
    }
  }
  syncNavigation();
  if (clueCount !== lastClueBadgeCount) {
    lastClueBadgeCount = clueCount;
    animateEmphasis(document.querySelector('.nav-badge'), reducedMotion());
  }
  save();
}
let knownClueCount = null;
let knownUnlockedIds = null;
const multiSelectionOrder = new Map();

// 上限を超えたら、いちばん先に選んだものを外して新しい選択を残す。
function capSelectionOrder(order, value, adding, limit) {
  const next = order.filter(item => item !== value);
  if (!adding) return next;
  next.push(value);
  return next.length > limit ? next.slice(-limit) : next;
}

function capMultiSelection(input) {
  const problem = current();
  const limit = problem?.selectionCount;
  if (problem?.type !== 'multiple' || !limit) return;
  const form = input.closest?.('#answer-form');
  if (!form?.querySelectorAll) return;
  const boxes = [...form.querySelectorAll('input[type="checkbox"][name="answer"]')];
  if (!boxes.length || boxes.some(box => typeof box.checked !== 'boolean')) return;
  const checked = new Set(boxes.filter(box => box.checked).map(box => box.value));
  const known = (multiSelectionOrder.get(problem.id) ?? []).filter(value => checked.has(value));
  const restored = [...checked].filter(value => !known.includes(value) && value !== input.value);
  const order = capSelectionOrder([...known, ...restored], input.value, Boolean(input.checked), limit);
  for (const box of boxes) box.checked = order.includes(box.value);
  multiSelectionOrder.set(problem.id, order);
}

function combineUnlocked() {
  if (playSaves?.getStatus().mode === 'debug') return true;
  return state.solved.includes('Q1');
}

function clueTabsAvailable() {
  return combineUnlocked() ? ['cards', 'characters', 'combine'] : ['cards', 'characters'];
}

function switchClueTab(nextTab) {
  const tabs = clueTabsAvailable();
  if (combinePicker || !tabs.includes(nextTab) || nextTab === clueTab) return;
  const direction = tabs.indexOf(nextTab) > tabs.indexOf(clueTab) ? 1 : -1;
  clueTab = nextTab;
  expandedCharacter = null;
  expandedClueId = null;
  combinePicker = false;
  combineReplaceAt = null;
  if (nextTab === 'combine') combineSelecting = false;
  haptics.trigger();
  const previousTab = panel.querySelector('.clue-tabs [aria-selected="true"]')?.getBoundingClientRect?.();
  openPanel('clues');
  animateSurface(panel.querySelector('#clue-tab-content'), true, direction * 40, 'X', MOTION.enter);
  slideTabIndicator(panel.querySelector(`#clue-tab-${clueTab}`), previousTab);
  panel.querySelector(`#clue-tab-${clueTab}`)?.focus({ preventScroll: true });
}

function switchHintTab(nextTab) {
  const tabs = hintTabs(activeHintSubject()) ?? [];
  const nextIndex = tabs.findIndex(tab => tab.id === nextTab);
  if (nextIndex < 0 || nextTab === hintTab) return;
  const direction = nextIndex > tabs.findIndex(tab => tab.id === hintTab) ? 1 : -1;
  hintTab = nextTab;
  haptics.trigger();
  const previousTab = panel.querySelector('.hint-tabs [aria-selected="true"]')?.getBoundingClientRect?.();
  openPanel('hints');
  animateSurface(panel.querySelector('#hint-tab-content'), true, direction * 40, 'X', MOTION.enter);
  slideTabIndicator(panel.querySelector(`#hint-tab-${hintTab}`), previousTab);
  panel.querySelector(`#hint-tab-${hintTab}`)?.focus({ preventScroll: true });
}

// 下線は ::after に描き、対応ブラウザだけ前のタブの位置から滑らせる。
function slideTabIndicator(tab, previousRect) {
  if (!tab?.animate || !previousRect?.width || reducedMotion() || !('pseudoElement' in (globalThis.KeyframeEffect?.prototype ?? {}))) return;
  const rect = tab.getBoundingClientRect();
  if (!rect.width) return;
  tab.animate([
    { transform: `translateX(${previousRect.left - rect.left}px) scaleX(${previousRect.width / rect.width})`, transformOrigin: 'left' },
    { transform: 'none', transformOrigin: 'left' },
  ], { duration: MOTION.enter, easing: MOTION.ease, pseudoElement: '::after' });
}

function clueGalleryItems() {
  const gallery = scenario.clueGallery ?? [];
  return playSaves?.getStatus().mode === 'debug' ? gallery : unlockedGalleryCards(scenario, state);
}

function clueIsNew(card) {
  return Boolean(card?.requires) && !seenClueIds.has(card.id);
}

function markClueSeen(id) {
  if (!id || seenClueIds.has(id)) return;
  if (!(scenario.clueGallery ?? []).some(card => card.id === id && card.requires)) return;
  seenClueIds.add(id);
  save();
}

function allPlayCards() {
  return [...(scenario.characterCards ?? []), ...clueGalleryItems()];
}

function clearCombineSelecting() {
  combineSelecting = false;
  combineSelection = [];
  combineReplaceAt = null;
}

// 長押しの指を離したときに発生する click を、その指が置かれていたカードに限って一度だけ無効化する。
// 再描画で click の target が消えると click が届かずフラグだけ残るため、カードIDと有効期限で判定する。
const combineClickSuppressed = id => id === combineSuppressCard && performance.now() < combineSuppressUntil;

function placeCombineCard(id) {
  combineSelection = capSelectionOrder(combineSelection, id, !combineSelection.includes(id), 2);
}

function toggleCombineCard(id) {
  if (!allPlayCards().some(card => card.id === id)) return false;
  placeCombineCard(id);
  combineSelecting = combineSelection.length > 0;
  return true;
}

function beginCombineSelecting(id) {
  if (!combineUnlocked() || !allPlayCards().some(card => card.id === id)) return false;
  combineSelecting = true;
  if (!combineSelection.includes(id) && combineSelection.length < 2) combineSelection = [...combineSelection, id];
  return true;
}

function combineOrderMark(id) {
  const index = combineSelection.indexOf(id);
  return index < 0 ? '' : ['①', '②'][index] ?? '';
}

function combineOrderBadge(id) {
  const index = combineSelection.indexOf(id);
  if (index < 0) return '';
  return `<span class="combine-order" aria-hidden="true">${index + 1}</span>`;
}

function refreshCombineSelection(changedId = null) {
  if (patchCombineSelection(changedId)) return;
  const hadBar = Boolean(panel.querySelector('.combine-select-bar'));
  openPanel('clues', { keepFocus: true });
  if (!hadBar) animateSurface(panel.querySelector('.combine-select-bar'), true, 16);
  if (changedId) popCombineBadge(changedId);
  if (combineSelection.length === 2) animateEmphasis(panel.querySelector('.combine-select-run'), reducedMotion());
}

function clueTileSpokenLabel(card) {
  const selected = combineSelecting && combineSelection.includes(card.id);
  const fresh = clueIsNew(card);
  const label = combineSelecting
    ? `${card.title}（手がかり番号 ${card.number}）${selected ? '、選択中' : 'を選択'}`
    : `${card.title}（手がかり番号 ${card.number}）を拡大`;
  const order = combineOrderMark(card.id);
  const selectedLabel = order ? `${card.title}（手がかり番号 ${card.number}）、${order}` : label;
  return `${fresh ? '新しい手がかり。' : ''}${combineSelecting ? selectedLabel : label}`;
}

function pickerSpokenLabel(card) {
  const selected = combineSelection.includes(card.id);
  const fresh = clueIsNew(card);
  const label = selected ? `${card.title}を入れ替える` : `${card.title}（手がかり番号 ${card.number}）`;
  const order = combineOrderMark(card.id);
  return `${fresh ? '新しい手がかり。' : ''}${order ? `${label}、${order}` : label}`;
}

function setOrderBadge(host, index, animate) {
  const badge = host.querySelector(':scope > .combine-order');
  if (index < 0) { badge?.remove(); return; }
  const text = String(index + 1);
  if (!badge) {
    host.insertAdjacentHTML('afterbegin', `<span class="combine-order${animate && !reducedMotion() ? ' is-appearing' : ''}" aria-hidden="true">${text}</span>`);
    return;
  }
  if (badge.textContent === text) return;
  badge.textContent = text;
  if (!animate || reducedMotion()) return;
  badge.classList.remove('is-appearing');
  void badge.offsetWidth;
  badge.classList.add('is-appearing');
}

function setSelectCheck(host, show) {
  const check = host.querySelector(':scope > .select-check');
  if (show && !check) host.insertAdjacentHTML('beforeend', '<span class="select-check" aria-hidden="true"></span>');
  else if (!show && check) check.remove();
}

function patchCombineControl(el, id, changedId) {
  const card = allPlayCards().find(item => item.id === id);
  if (!card || !el.setAttribute) return;
  const picker = el.dataset.action === 'combine-toggle';
  const selected = combineSelection.includes(id);
  if (combineSelecting || picker) el.setAttribute('aria-pressed', String(selected));
  else el.removeAttribute('aria-pressed');
  el.setAttribute('aria-label', picker ? pickerSpokenLabel(card) : el.matches?.('.clue-gallery-card')
    ? `${card.title}（手がかり番号 ${card.number}）${combineOrderMark(id) ? `、${combineOrderMark(id)}` : ''}`
    : clueTileSpokenLabel(card));
  const host = el.querySelector('.clue-card-thumb') ?? el;
  setOrderBadge(host, combineSelection.indexOf(id), id === changedId);
  setSelectCheck(host, (combineSelecting || picker) && !selected);
}

function patchCombineSelectBar() {
  const screen = panel.querySelector('.clue-screen-content');
  if (!screen || combinePicker || clueTab === 'combine') return;
  const existing = screen.querySelector('.combine-select-bar');
  if (!combineSelecting) { existing?.remove(); return; }
  if (!existing) {
    const anchor = screen.querySelector('.combine-tab-fab');
    const html = combineSelectBarMarkup();
    if (anchor) anchor.insertAdjacentHTML('beforebegin', html);
    else screen.insertAdjacentHTML('beforeend', html);
    animateSurface(screen.querySelector('.combine-select-bar'), true, 16);
    return;
  }
  const count = combineSelection.length;
  existing.classList.toggle('is-ready', count === 2);
  const thumbs = existing.querySelector('.combine-select-thumbs');
  if (thumbs) thumbs.innerHTML = combineSelection.map(id => {
    const card = allPlayCards().find(item => item.id === id);
    return card?.image ? `<img class="combine-select-thumb" src="${esc(card.image)}" alt="">` : '';
  }).join('');
  const text = existing.querySelector('.combine-select-text');
  if (text) text.innerHTML = `${count === 2 ? 'この2枚で合成できます' : count === 1 ? 'あと1枚選んでください' : 'カードを2枚選んでください'}<small>タップで選択・長押しで拡大</small>`;
  const run = existing.querySelector('.combine-select-run');
  if (run) {
    run.disabled = count !== 2;
    run.textContent = `合成 ${count}/2`;
  }
}

function patchCombinePickerFab() {
  const fab = panel.querySelector('[data-action="combine-confirm"]');
  if (!fab) return;
  const remaining = 2 - combineSelection.length;
  fab.disabled = remaining !== 0;
  const label = fab.querySelector('span');
  if (label) label.textContent = remaining === 0 ? '次へ' : `あと${remaining}枚`;
}

// 選択のたびに一覧を描き直すと、番号が飛び、見ていた位置が先頭に戻る。
function patchCombineSelection(changedId) {
  // 公開情報は選択を終えるとカルーセルに戻す。一覧の描き直しが必要。
  if (!combineSelecting && clueTab === 'characters' && !combinePicker) return false;
  const screen = panel.querySelector('.clue-screen-content');
  if (!screen?.classList?.toggle) return false;
  const tiles = [...(panel.querySelectorAll?.('[data-action="clue-card-open"][data-id], [data-action="combine-toggle"][data-id]') ?? [])];
  const galleries = [...(panel.querySelectorAll?.('.clue-gallery-card[data-combine-id]') ?? [])];
  if (!tiles.length && !galleries.length) return false;
  screen.classList.toggle('is-combine-selecting', Boolean(combineSelecting && !combinePicker && clueTab !== 'combine'));
  for (const tile of tiles) patchCombineControl(tile, tile.dataset.id, changedId);
  for (const card of galleries) patchCombineControl(card, card.dataset.combineId, changedId);
  patchCombineSelectBar();
  patchCombinePickerFab();
  if (combineSelection.length === 2) animateEmphasis(panel.querySelector('.combine-select-run'), reducedMotion());
  return true;
}

function popCombineBadge(id) {
  if (!combineSelection.includes(id)) return;
  const key = globalThis.CSS?.escape?.(id) ?? id;
  popElement(panel.querySelector(`[data-id="${key}"] .combine-order, [data-combine-id="${key}"] > .combine-order`));
}

function combineSelectBarMarkup() {
  if (!combineSelecting || combinePicker || clueTab === 'combine') return '';
  const count = combineSelection.length;
  const thumbs = combineSelection.map(id => {
    const card = allPlayCards().find(item => item.id === id);
    return card?.image ? `<img class="combine-select-thumb" src="${esc(card.image)}" alt="">` : '';
  }).join('');
  const status = count === 2 ? 'この2枚で合成できます' : count === 1 ? 'あと1枚選んでください' : 'カードを2枚選んでください';
  return `<div class="combine-select-bar${count === 2 ? ' is-ready' : ''}" role="group" aria-label="合成するカードを選択中">
    <button type="button" class="icon-button combine-select-cancel" data-action="combine-select-cancel" aria-label="選択をやめる">${icon('close')}</button>
    <div class="combine-select-status" aria-live="polite"><span class="combine-select-thumbs" aria-hidden="true">${thumbs}</span><span class="combine-select-text">${status}<small>タップで選択・長押しで拡大</small></span></div>
    <button type="button" class="primary-button combine-select-run" data-action="combine-select-run" ${count === 2 ? '' : 'disabled'} aria-label="選択したカードを合成">合成 ${count}/2</button>
  </div>`;
}

// 合成タブの合成ボタンはスクロール領域の外に浮かせて、常に画面内に収める。
function combineFabMarkup() {
  if (clueTab !== 'combine' || combinePicker) return '';
  return `<button type="button" class="answer-fab combine-tab-fab" data-action="combine-pick">${icon('cards')}<span>合成</span></button>`;
}

function combinationRewardCard(result) {
  return (scenario.clueGallery ?? []).find(card => card.requires?.combination === result.id) ?? null;
}

function paperCardPickupNote(card) {
  const number = String(card?.number ?? card?.mark ?? '');
  if (!/^(400|401|402|403|404)$/.test(number)) return '';
  return `会場でプレイされる方へ：紙のカードをご希望の方は、『${number}』を取りにお越しください`;
}

function presentCardReward(card, already, note = '') {
  pendingReward = { card, already, note };
  openPanel('hex-reward');
}

function combineOutcomeMarkup() {
  if (combineOutcome?.kind === 'failure') {
    return `<dialog class="hex-failure combine-outcome" aria-labelledby="combine-failure-title"><h2 id="combine-failure-title">失敗</h2><p>この組み合わせからは、新しい手がかりは出てきません。</p><button type="button" class="primary-button" data-action="combine-outcome-next">戻る</button></dialog>`;
  }
  if (combineOutcome?.kind === 'success') {
    return `<dialog class="hex-success combine-outcome" aria-labelledby="hex-success-title"><div class="hex-confetti" aria-hidden="true"></div><div class="hex-success-card"><h2 id="hex-success-title">成功</h2><button type="button" class="primary-button" data-action="combine-outcome-next">次へ</button></div></dialog>`;
  }
  return '';
}

function burstCombineConfetti(layer) {
  if (!layer?.append || !layer.animate) return;
  const colors = ['#f0782b', '#e8691d', '#ffd0ae', '#aa4008', '#cecece', '#fff'];
  const { width, height } = layer.getBoundingClientRect();
  for (const direction of [1, -1]) {
    for (let i = 0; i < 38; i++) {
      const paper = document.createElement('i');
      paper.style.background = colors[i % colors.length];
      paper.style.left = direction === 1 ? '0' : '100%';
      paper.style.width = `${5 + Math.random() * 5}px`;
      paper.style.height = `${8 + Math.random() * 8}px`;
      layer.append(paper);
      const travel = direction * width * (.22 + Math.random() * .62);
      const lift = height * (.32 + Math.random() * .48);
      const spin = direction * (180 + Math.random() * 640);
      const frames = Array.from({ length: 21 }, (_, step) => {
        const t = step / 20;
        const x = travel * t * (1.65 - .65 * t);
        const y = -4 * lift * t * (1 - t) + height * .48 * t * t;
        return { transform: `translate(${x}px,${y}px) rotate(${spin * t}deg) scaleX(${.3 + .7 * Math.abs(Math.cos(t * 12 + i))})` };
      });
      const flight = paper.animate(frames, { duration: 1500 + Math.random() * 650, delay: Math.random() * 160 });
      flight.onfinish = () => paper.remove();
    }
  }
}

function mountCombineOutcome() {
  const dialog = panel.querySelector('dialog.combine-outcome');
  if (!dialog) return;
  combineOutcomeDialog = dialog;
  const success = dialog.classList.contains('hex-success');
  if (success) ensureHexSuccessCss();
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    event.stopPropagation();
    if (combineOutcome?.kind === 'failure') finishCombineOutcome();
  });
  if (dialog.parentElement !== document.body) document.body.append(dialog);
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  if (success && !reducedMotion()) {
    dialog.querySelector('.hex-success-card')?.animate?.(
      [{ opacity: 0, transform: 'scale(.86) translateY(8px)' }, { opacity: 1, transform: 'scale(1.03)', offset: .7 }, { opacity: 1, transform: 'none' }],
      { duration: 420, delay: 60, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
    );
    burstCombineConfetti(dialog.querySelector('.hex-confetti'));
  } else if (!success) animateScale(dialog, true, .94);
  dialog.querySelector('button')?.focus({ preventScroll: true });
}

function finishCombineOutcome() {
  if (combineOutcomeClosing) return;
  const outcome = combineOutcome;
  const dialog = combineOutcomeDialog ?? panel.querySelector('dialog.combine-outcome');
  const card = dialog?.querySelector('.hex-success-card');
  const proceed = () => {
    combineOutcomeClosing = false;
    combineOutcome = null;
    combineOutcomeDialog = null;
    if (dialog?.open) dialog.close();
    dialog?.remove();
    if (outcome?.kind === 'success' && outcome.card) {
      presentCardReward(outcome.card, outcome.already);
      return;
    }
    openPanel('clues');
  };
  if (outcome?.kind !== 'success' || reducedMotion() || !card?.animate) {
    // 失敗ダイアログだけ、出すときと同じ縮小で閉じる。動かせない環境では即時に閉じる。
    if (outcome?.kind === 'failure' && !reducedMotion() && dialog?.animate) {
      combineOutcomeClosing = true;
      dialog.classList.add('is-closing');
      void animateScale(dialog, false, .96).finally(proceed);
      return;
    }
    proceed();
    return;
  }
  combineOutcomeClosing = true;
  dialog.classList.add('is-closing');
  card.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }],
    { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' })
    .finished.catch(() => {}).finally(proceed);
}

function applyCombineResult(ids, returnTab = clueTab) {
  const result = findCombination(scenario, ids);
  if (!result) {
    haptics.trigger('error');
    clueTab = returnTab;
    clearCombineSelecting();
    combinePicker = false;
    expandedClueId = null;
    expandedCharacter = null;
    combineOutcome = { kind: 'failure' };
    openPanel('clues');
    return false;
  }
  const already = state.combinations.includes(result.id);
  if (!already) {
    state.combinations.push(result.id);
    if (knownUnlockedIds) for (const card of unlockedCards(scenario, state)) knownUnlockedIds.add(card.id);
    if (knownClueCount !== null) knownClueCount = unlockedCards(scenario, state).length;
    save();
  }
  haptics.trigger('success');
  const card = combinationRewardCard(result);
  clearCombineSelecting();
  if (!card) return true;
  combineOutcome = { kind: 'success', card, already };
  openPanel('clues');
  return true;
}

function combineGuideMarkup() {
  return `<article class="start-guide guide-card combine-guide">
    <header class="guide-card-heading"><span class="guide-card-icon" aria-hidden="true">${icon('cards')}</span><h1>合成</h1></header>
    <p>合成とは2枚の手がかりカードから新しいカードを手に入れることのできるシステムです。関連のありそうな2枚のカードを選択してください。</p>
    <p>会場でプレイされる方は2枚のカードを会場スタッフに提示するのでも構いません。</p>
    <div class="start-guide-menu">
      <figure class="deduction-guide-toolbar combine-number-callout">
        <img src="../assets/combine-number-callout.webp" width="900" height="264" alt="手がかりカード下部の数字。この例では102">
        <svg viewBox="0 0 900 264" aria-hidden="true"><ellipse cx="827" cy="208" rx="56" ry="36" fill="none" stroke="#fff" stroke-width="12"/><ellipse cx="827" cy="208" rx="56" ry="36" fill="none" stroke="#e10600" stroke-width="6"/><path d="M590 64 L740 160" fill="none" stroke="#fff" stroke-width="14" stroke-linecap="round"/><path d="M590 64 L740 160" fill="none" stroke="#e10600" stroke-width="7" stroke-linecap="round"/><path d="M768 178 L743 177 L757 155 Z" fill="#fff" stroke="#fff" stroke-width="8" stroke-linejoin="round"/><path d="M768 178 L743 177 L757 155 Z" fill="#e10600"/></svg>
      </figure>
      <div class="start-guide-menu-copy">
        <p>手がかり番号は、カード下部の数字となります。</p>
      </div>
    </div>
    <p>手がかり番号はカードだけではなく公開情報にも書かれてあります。見落とさないようご注意ください。</p>
  </article>`;
}

function clueCardMarkup(card) {
  const selected = combineSelecting && combineSelection.includes(card.id);
  const fresh = clueIsNew(card);
  const spoken = clueTileSpokenLabel(card);
  const check = combineSelecting && !selected ? '<span class="select-check" aria-hidden="true"></span>' : '';
  const badge = fresh ? '<span class="clue-new">New</span>' : '';
  return `<button type="button" class="clue-card-tile" data-action="clue-card-open" data-id="${esc(card.id)}"${combineSelecting ? ` aria-pressed="${selected}"` : ''} aria-label="${esc(spoken)}">
    <span class="clue-card-thumb">${badge}${combineOrderBadge(card.id)}${check}<span class="press-ring" aria-hidden="true"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" pathLength="100"/></svg></span><img src="${esc(card.image)}" alt="" decoding="async"></span>
  </button>`;
}

function hexReplayMenuItem() {
  const solved = state.minigames?.includes('hex-cube');
  if (!solved && playSaves?.getStatus().mode !== 'debug') return '';
  return `<button data-action="hex-replay">${icon('reset')}<span>控室の問題をもう一度解く</span></button>`;
}

function canReplayQ9() {
  if (playSaves?.getStatus().mode === 'debug') return true;
  return state.solved.includes('Q9') && Boolean(state.branches?.Q9);
}

function q9ReplayMenuItem() {
  if (!canReplayQ9()) return '';
  return `<button data-action="replay-q9">${icon('reset')}<span>Q9をもう一度解く</span></button>`;
}

function replayMenuSection() {
  const items = `${q9ReplayMenuItem()}${hexReplayMenuItem()}`;
  return items ? `<hr class="menu-divider">${items}` : '';
}

function replayQ9() {
  if (!canReplayQ9() || isPlaying) return;
  conversationPlayer.stop();
  isPlaying = false;
  epiloguePhase = null;
  cancelEpilogueMotion();
  composerExpanded = true;
  selectProblem('Q9', { answering: true });
}

function hexEntryLocked() {
  return playSaves.getStatus().mode !== 'debug' && state.minigames?.includes('hex-cube');
}

function hexEntryButton() {
  const locked = hexEntryLocked();
  return `<button type="button" class="clue-hex-entry" data-action="hex-open"${locked ? ' disabled' : ''} aria-label="${locked ? '控室のパズルは解答済み' : '控室のパズルを解く'}"></button>`;
}

function luminolEntryButton() {
  return '<button type="button" class="clue-luminol-entry" data-action="luminol-open" aria-label="ルミノール検査を始める"></button>';
}

function cluePhotoCardMarkup(card, { current = false } = {}) {
  const selected = combineSelecting && combineSelection.includes(card.id);
  const order = combineOrderMark(card.id);
  const check = combineSelecting && !selected ? '<span class="select-check" aria-hidden="true"></span>' : '';
  return `<article class="clue-gallery-card clue-photo-card" data-combine-id="${esc(card.id)}"${current ? ' aria-current="true"' : ''}${combineSelecting ? ` aria-pressed="${selected}"` : ''} aria-label="${esc(card.title)}（手がかり番号 ${esc(card.number)}）${order ? `、${order}` : ''}">${combineOrderBadge(card.id)}${check}<span class="press-ring" aria-hidden="true"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" pathLength="100"/></svg></span><img src="${esc(card.image)}" alt="${esc(card.title)}（手がかり番号 ${esc(card.number)}）" decoding="async">${card.puzzle === 'hex-cube' ? hexEntryButton() : ''}${card.puzzle === 'luminol' ? luminolEntryButton() : ''}</article>`;
}

function clueCardExpandedMarkup(gallery, index) {
  const cards = gallery.map((card, i) => cluePhotoCardMarkup(card, { current: i === index })).join('');
  return `<div class="clue-card-expanded">
    <div class="clue-card-expanded-header">
      <button type="button" class="icon-button" data-action="clue-card-close" aria-label="カード一覧に戻る">${icon('close')}</button>
    </div>
    <div class="clue-carousel" tabindex="0" role="region" aria-label="手がかりカード。横スクロールで前後のカードに切り替え">${cards}</div>
  </div>`;
}

// 拡大カードはボックスより画像が大きいので、見た目どおり img の位置でつなぐ。
const cardImageRect = el => (el?.querySelector?.('img') ?? el)?.getBoundingClientRect?.();

function closeClueCardPreview() {
  const id = expandedClueId;
  const sourceRect = cardImageRect(panel.querySelector('.clue-gallery-card[aria-current="true"]'));
  expandedClueId = null;
  openPanel('clues');
  const tile = panel.querySelector(`[data-action="clue-card-open"][data-id="${globalThis.CSS?.escape?.(id) ?? id}"]`);
  tile?.focus({ preventScroll: true });
  animateCardFrom(tile, sourceRect);
}

// 押したカードの位置から拡大して開き、閉じるときは一覧の位置へ戻す。
function animateCardFrom(element, sourceRect) {
  if (!element?.animate || !sourceRect?.width || reducedMotion()) return;
  animateFade(panel.querySelector('#clue-tab-content'), true, MOTION.state);
  const targetRect = cardImageRect(element);
  if (!targetRect?.width || !targetRect?.height) return;
  const panelRect = panel.getBoundingClientRect();
  const ghost = element.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.classList.add('clue-card-ghost');
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
  const sourceRect = cardImageRect(panel.querySelector('.clue-gallery-card[aria-current="true"]'));
  expandedCharacter = null;
  openPanel('clues');
  const tile = panel.querySelector(`[data-action="character-open"][data-index="${index}"]`);
  tile?.focus({ preventScroll: true });
  animateCardFrom(tile, sourceRect);
}

function hexEntryOpensReward(id) {
  return playSaves.getStatus().mode !== 'debug' && state.minigames?.includes(id);
}

// 裏向きのまま回転して中央へ飛び出し、一瞬止まってから表へ返す。
function playHexRewardReveal() {
  const card = panel.querySelector('.hex-reward-card');
  const spin = card?.querySelector('.hex-reward-spin');
  if (!card || !spin || card.dataset.settled === 'true') return;
  if (reducedMotion() || typeof card.animate !== 'function' || typeof spin.animate !== 'function') {
    card.dataset.settled = 'true';
    return;
  }
  // 画像の復号を回転中に踏むと、そこで一フレーム止まる。
  const image = spin.querySelector('img');
  if (image?.decode) image.decode().catch(() => {});
  const start = () => {
    if (!card.isConnected || card.dataset.settled === 'true') return;
    // 拡大とY回転を同じ transform に混ぜると、途中の角度で行列が分解されて一瞬カクつく。
    // Y回転は180度以内の区間に分け、最短経路へ折り返さないようにする。
    const motion = { duration: 1180, easing: 'linear', fill: 'both' };
    card.animate([
      { offset: 0, transform: 'translate3d(0, 36px, 0) rotateZ(-18deg) scale(.12)' },
      { offset: .24, transform: 'translate3d(0, 8px, 0) rotateZ(-6deg) scale(.55)' },
      { offset: .48, transform: 'translate3d(0, -8px, 0) rotateZ(14deg) scale(1.18)' },
      { offset: .6, transform: 'translate3d(0, 0, 0) rotateZ(12deg) scale(1.04)' },
      { offset: .72, transform: 'translate3d(0, 0, 0) rotateZ(10deg) scale(1)' },
      { offset: .9, transform: 'translate3d(0, 0, 0) rotateZ(0deg) scale(1.06)' },
      { offset: 1, transform: 'translate3d(0, 0, 0) rotateZ(0deg) scale(1)' },
    ], motion);
    const spinning = spin.animate([
      { offset: 0, transform: 'rotateY(-720deg)' },
      { offset: .12, transform: 'rotateY(-550deg)' },
      { offset: .24, transform: 'rotateY(-380deg)' },
      { offset: .36, transform: 'rotateY(-202deg)' },
      { offset: .48, transform: 'rotateY(-24deg)' },
      { offset: .6, transform: 'rotateY(0deg)' },
      { offset: .72, transform: 'rotateY(0deg)' },
      { offset: .81, transform: 'rotateY(90deg)' },
      { offset: .9, transform: 'rotateY(180deg)' },
      { offset: 1, transform: 'rotateY(180deg)' },
    ], motion);
    panel.querySelector('.hex-reward-flash')?.animate?.([
      { offset: 0, opacity: 0 },
      { offset: .42, opacity: 0 },
      { offset: .5, opacity: .8 },
      { offset: .62, opacity: 0 },
      { offset: .82, opacity: 0 },
      { offset: .9, opacity: .9 },
      { offset: 1, opacity: 0 },
    ], motion);
    for (const element of panel.querySelectorAll('.hex-reward-message, .hex-reward-actions')) {
      element.animate?.([
        { opacity: 0, transform: 'translateY(16px)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 340, delay: 980, easing: MOTION.ease, fill: 'both' });
    }
    spinning.finished?.then(() => {
      if (!card.isConnected) return;
      card.dataset.settled = 'true';
      for (const animation of [...card.getAnimations(), ...spin.getAnimations()]) animation.cancel();
    }).catch(() => {});
  };
  // パネルを開いたフレームで回すと、最初の合成で一拍止まる。
  requestAnimationFrame(() => requestAnimationFrame(start));
}
let resolvedMountHexCube = null;
let resolvedMountLuminol = null;
function ensureHexSuccessCss() {
  if (typeof document?.createElement !== 'function') return;
  if (document.querySelector('link[data-hex-success-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // app/index.html からの相対パス。テストVMでは import.meta が使えない。
  link.href = '../hex-success.css';
  link.dataset.hexSuccessCss = '1';
  document.head.appendChild(link);
}
// packaging-ref: new URL('./hex-success.css', import.meta.url)
async function ensureHexCube() {
  ensureHexSuccessCss();
  if (resolvedMountHexCube) return resolvedMountHexCube;
  // テストハーネスは mountHexCube を注入する。本番は初回だけ動的 import する。
  if (typeof mountHexCube === 'function') {
    resolvedMountHexCube = mountHexCube;
    return resolvedMountHexCube;
  }
  resolvedMountHexCube = (await import('./hex-cube.js')).mountHexCube;
  return resolvedMountHexCube;
}
async function openHexCube(id='hex-cube', { replay = false } = {}) {
  if(gateVisible)return;
  if(!(scenario.minigames??[]).some(game=>game.id===id))return;
  miniRewardAlready=Boolean(state.minigames?.includes(id));
  expandedCharacter=null;
  if (playSaves.getStatus().phase === 'conflict') return;
  const panelKind = !replay && hexEntryOpensReward(id) ? hexRewardPanel() : 'hex-cube';
  if (panelKind === 'hex-cube' && !resolvedMountHexCube) {
    const triggers = [...document.querySelectorAll('[data-action="hex-open"]')];
    triggers.forEach(button => { button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true'); });
    try { await ensureHexCube(); }
    finally { triggers.forEach(button => { button.classList.remove('is-loading'); button.removeAttribute('aria-busy'); }); }
  } else if (panelKind === 'hex-cube') await ensureHexCube();
  if (gateVisible || playSaves.getStatus().phase === 'conflict') return;
  pendingReward = null;
  openPanel(panelKind);
}
async function openLuminol() {
  if (gateVisible) return;
  if (!resolvedMountLuminol) {
    // テストハーネスは mountLuminol を注入する。本番は初回だけ動的 import する。
    if (typeof mountLuminol === 'function') resolvedMountLuminol = mountLuminol;
    else resolvedMountLuminol = (await import('./luminol.js')).mountLuminol;
  }
  if (gateVisible) return;
  openPanel('luminol');
}
function hexRewardPanel() {
  if(playSaves.getStatus().phase==='conflict')return 'hex-pending';
  return playSaves.getStatus().mode!=='debug'&&playSaves.getRecord()?.pending?'hex-pending':'hex-reward';
}
function returnFromHexReplay() {
  miniView?.destroy();
  miniView = null;
  if (!panel.open || panel.classList.contains('is-closing')) return;
  panelRevision++;
  surfaceAnimations.get(panel)?.cancel();
  surfaceAnimations.delete(panel);
  panel.classList.remove('is-closing', 'hex-cube-panel', 'hex-reward-panel');
  panel.inert = false;
  panel.close();
  syncNavigation();
}
async function confirmHexReward(feedbackFinished) {
  const session=playSessionRevision;
  const revision=panelRevision;
  await Promise.all([playSaves.flush(), feedbackFinished]);
  if(gateVisible||playSessionRevision!==session||panelRevision!==revision)return;
  if (hexReturnToChat) { hexReturnToChat=false; returnFromHexReplay(); return; }
  pendingReward = null;
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
    miniRewardAlready=result.status==='already-solved';
    hexReturnToChat=miniRewardAlready;
    // 再クリアは同じ手がかりを足さない。保存も会話の描き直しもしない。
    if (!miniRewardAlready) { state=result.state; save(); render(); }
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
    if (position) position.textContent = `${activeIndex + 1} / ${cards.length}`;
    panel.querySelectorAll('.character-dot').forEach((dot, index) => {
      const on = index === activeIndex;
      if (dot.getAttribute('aria-selected') !== String(on)) dot.setAttribute('aria-selected', String(on));
    });
    if (clueTab === 'characters') expandedCharacter = activeIndex;
    if (clueTab === 'cards' && expandedClueId !== null) {
      const id = clueGalleryItems()[activeIndex]?.id;
      if (id) {
        expandedClueId = id;
        markClueSeen(id);
      }
    }
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

function bindCombineCardGestures() {
  const root = panel.querySelector('#clue-tab-content');
  if (!root || root.dataset.combineGestures === '1') return;
  root.dataset.combineGestures = '1';
  const longPressMs = 480;
  const moveCancelPx = 12;
  let press = null;

  const targetFromEvent = event => {
    if (event.target?.closest?.('[data-action="clue-card-close"], .combine-select-bar, .clue-tabs, .icon-button')) return null;
    const tile = event.target?.closest?.('[data-action="clue-card-open"][data-id]');
    if (tile) return { id: tile.dataset.id, kind: 'tile', el: tile };
    const card = event.target?.closest?.('.clue-gallery-card[data-combine-id]');
    // 公開情報タブは常時拡大表示なので、タップのプレス演出（拡大）をカードに付けない。
    if (card) return clueTab === 'characters' && !combineSelecting ? null : { id: card.dataset.combineId, kind: 'gallery', el: card };
    return null;
  };

  const clearPress = () => {
    if (press?.timer) clearTimeout(press.timer);
    press?.el?.classList.remove('is-pressing');
    press = null;
  };

  root.addEventListener('pointerdown', event => {
    if (event.button != null && event.button !== 0) return;
    const target = targetFromEvent(event);
    if (!target) return;
    clearPress();
    combineSuppressPointer = null;
    press = {
      id: target.id,
      el: target.el,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      timer: setTimeout(() => {
        const id = press?.id;
        const pointerId = press?.pointerId;
        press = null;
        target.el?.classList.remove('is-pressing');
        if (!id) return;
        if (combineSelecting) {
          // 選択モード中の長押しはカードの拡大プレビューを開く（公開情報タブは常時拡大表示のため対象外）
          const card = clueTab === 'cards' ? clueGalleryItems().find(item => item.id === id) : null;
          if (!card || expandedClueId) return;
          expandedClueId = card.id;
          expandedCharacter = null;
          combineSuppressPointer = { id, pointerId };
          haptics.trigger();
          openPanel('clues');
          panel.querySelector('[data-action="clue-card-close"]')?.focus({ preventScroll: true });
          return;
        }
        if (!beginCombineSelecting(id)) return;
        combineSuppressPointer = { id, pointerId };
        haptics.trigger();
        refreshCombineSelection(id);
      }, longPressMs),
    };
    target.el?.classList.add('is-pressing');
  });

  root.addEventListener('pointermove', event => {
    if (!press || event.pointerId !== press.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > moveCancelPx) clearPress();
  });

  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    root.addEventListener(name, event => {
      if (combineSuppressPointer && (event.pointerId == null || event.pointerId === combineSuppressPointer.pointerId)) {
        combineSuppressCard = combineSuppressPointer.id;
        combineSuppressUntil = performance.now() + 800;
        combineSuppressPointer = null;
      }
      if (!press || (event.pointerId != null && event.pointerId !== press.pointerId)) return;
      clearPress();
    });
  }

  root.addEventListener('click', event => {
    const target = targetFromEvent(event);
    if (target && combineClickSuppressed(target.id)) {
      event.preventDefault();
      event.stopPropagation();
      combineSuppressCard = null;
      return;
    }
    if (!combineSelecting) return;
    if (!target || target.kind !== 'gallery') return;
    event.preventDefault();
    event.stopPropagation();
    if (!toggleCombineCard(target.id)) return;
    haptics.trigger();
    refreshCombineSelection(target.id);
  }, true);

  root.addEventListener('contextmenu', event => {
    if (targetFromEvent(event)) event.preventDefault();
  });
}


function hintAnswerBack(explanation) {
  return explanation ? `<div class="hint-ema hint-ema-back" aria-hidden="true"><p class="hint-ema-answer">${esc(explanation)}</p></div>` : '';
}

function hintTabs(subject) {
  return subject?.hintTabs?.length ? subject.hintTabs : null;
}

function activeHintSubject() {
  return hintContext === 'hex-cube' ? scenario.minigames.find(game => game.id === 'hex-cube') : current();
}

// タブ付きヒントは「問題id:タブid」をキーに既読位置をタブごとに記録する。
function hintSubjectView(subject) {
  const tabs = hintTabs(subject);
  if (!tabs) return subject;
  const tab = tabs.find(t => t.id === hintTab) ?? tabs[0];
  hintTab = tab.id;
  return { ...subject, id: `${subject.id}:${tab.id}`, hints: tab.hints };
}

function hintTabsMarkup(subject) {
  const tabs = hintTabs(subject);
  if (!tabs) return '';
  return `<div class="hint-tabs" role="tablist" aria-label="儀式のヒント">${tabs.map(tab => `<button id="hint-tab-${esc(tab.id)}" role="tab" data-action="hint-tab" data-tab="${esc(tab.id)}" aria-selected="${hintTab === tab.id}" aria-controls="hint-tab-content" tabindex="${hintTab === tab.id ? 0 : -1}">${esc(tab.label)}</button>`).join('')}</div>`;
}

function hintReaderMarkup(subject) {
  const { hints, explanation } = subject;
  const count = hints.length;
  const index = Math.max(0, (state.hints[subject.id] || 1) - 1);
  const answer = explanation ? `<details class="answer-reveal hint-answer"${index + 1 < count ? ' hidden' : ''}><summary>解答を見る</summary><p>${esc(explanation)}</p></details>` : '';
  const back = hintAnswerBack(explanation);
  const tabpanel = hintTabs(subject) ? ` id="hint-tab-content" role="tabpanel" aria-labelledby="hint-tab-${esc(hintTab)}"` : '';
  if (!count) {
    return `<div class="hint-reader hint-reader-empty"${tabpanel}><div class="hint-shrine" aria-hidden="true"></div><div class="hint-ema-stage"><div class="hint-ema-flip"><div class="hint-ema hint-ema-front"><p class="hint-ema-empty">この問題のヒントはまだありません。</p></div>${back}</div></div>${answer}</div>`;
  }
  const cards = hints.map((hint, i) => `<section class="hint-card"${i === index ? '' : ' inert'}><p>${esc(hint)}</p><span class="eyebrow">ヒント ${i + 1} / ${count}</span></section>`).join('');
  return `<div class="hint-reader"${tabpanel}><div class="hint-shrine" aria-hidden="true"></div><div class="hint-pager"><button type="button" class="hint-prev" aria-label="前のヒント"${index === 0 ? ' disabled' : ''}>${icon('chevron')}</button><div class="hint-ema-stage"><div class="hint-ema-flip"><div class="hint-ema hint-ema-front"><div class="hint-window"><div class="hint-track" style="transform:translateX(-${index * 100}%)">${cards}</div></div></div>${back}</div></div><button type="button" class="hint-next" aria-label="次のヒント"${index === count - 1 ? ' disabled' : ''}>${icon('chevron')}</button></div><span class="sr-only" role="status"></span>${answer}</div>`;
}

function setHintConfirm(popup, open) {
  if (!popup) return;
  const card = popup.querySelector('.hint-confirm-card');
  if (open) {
    popup.hidden = false;
    popup.inert = false;
    animateFade(popup, true, MOTION.state);
    animateScale(card, true, .94);
    return;
  }
  if (popup.hidden) return;
  if (!popup.animate || reducedMotion()) { popup.hidden = true; return; }
  popup.inert = true;
  Promise.all([animateFade(popup, false), animateScale(card, false, .96)]).then(([finished]) => {
    if (!finished) return;
    popup.hidden = true;
    popup.inert = false;
  });
}

let hintCueTimer;
function armHintCue(pager) {
  if (!pager) return;
  clearTimeout(hintCueTimer);
  pager.classList.remove('is-quiet');
  const begin = () => {
    if (reducedMotion()) { pager.classList.add('is-quiet'); return; }
    hintCueTimer = setTimeout(() => { if (pager.isConnected) pager.classList.add('is-quiet'); }, 2400);
  };
  const disclosure = pager.closest('details');
  if (disclosure && !disclosure.open) {
    disclosure.addEventListener('toggle', () => { if (disclosure.open) begin(); }, { once: true });
    return;
  }
  begin();
}

function bindHintReader(subject) {
  const reader = panel.querySelector('.hint-reader');
  if (!reader) return;
  const track = reader.querySelector('.hint-track');
  const prev = reader.querySelector('.hint-prev');
  const next = reader.querySelector('.hint-next');
  const answer = reader.querySelector('.hint-answer');
  if (!track || !prev || !next) return;
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
    panel.querySelector('.hint-confirm')?.toggleAttribute('hidden', true);
    panel.querySelector('.hint-ema-flip')?.classList.remove('is-flipped', 'is-turning');
    panel.querySelector('.hint-ema-back')?.setAttribute('aria-hidden', 'true');
    const reveal = panel.querySelector('.hint-answer-button');
    if (reveal) {
      const revealWasHidden = reveal.hidden;
      reveal.hidden = !answer || answer.hidden;
      if (revealWasHidden && !reveal.hidden) animateSurface(reveal, true, -4, 'Y', MOTION.state);
      reveal.setAttribute('aria-expanded', String(Boolean(answer?.open)));
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
  const scroller = reader.querySelector('.hint-window');
  if (scroller?.addEventListener) {
    let drag = null;
    let wheelTimer = null;
    const swipeThreshold = () => {
      const width = scroller.clientWidth || 0;
      return width ? Math.min(72, width * 0.22) : 48;
    };
    const releaseDrag = dx => {
      track.style.transition = '';
      track.getBoundingClientRect?.();
      const delta = Math.abs(dx) >= swipeThreshold() ? (dx < 0 ? 1 : -1) : 0;
      const target = index + delta;
      if (delta && target >= 0 && target < subject.hints.length) move(delta);
      else track.style.transform = `translateX(-${index * 100}%)`;
    };
    scroller.addEventListener('pointerdown', event => {
      if (event.button != null && event.button !== 0) return;
      if (event.target?.closest?.('button, a, summary')) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, locked: false };
    });
    scroller.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id || drag.locked === 'drop') return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.locked) {
        if (Math.hypot(dx, dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) { drag.locked = 'drop'; return; }
        drag.locked = 'x';
        scroller.setPointerCapture?.(event.pointerId);
      }
      if (reducedMotion()) return;
      track.style.transition = 'none';
      track.style.transform = `translateX(calc(-${index * 100}% + ${dx}px))`;
    });
    scroller.addEventListener('pointerup', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const horizontal = drag.locked === 'x';
      drag = null;
      if (horizontal) releaseDrag(dx);
    });
    scroller.addEventListener('pointercancel', event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      track.style.transition = '';
      track.style.transform = `translateX(-${index * 100}%)`;
    });
    scroller.addEventListener('wheel', event => {
      const axis = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : (event.shiftKey ? event.deltaY : 0);
      if (!axis) return;
      event.preventDefault?.();
      if (wheelTimer !== null) return;
      wheelTimer = setTimeout(() => { wheelTimer = null; }, 450);
      move(axis > 0 ? 1 : -1);
    }, { passive: false });
  }
  armHintCue(reader.querySelector('.hint-pager'));
  const disclosure = reader.closest('details');
  if (disclosure) {
    disclosure.addEventListener('toggle', () => { if (disclosure.open) markRead(); });
  } else markRead();
}

function openPanel(kind, { keepFocus = false, revealSelector = null, showStartButton = false, travelId = '', travelIndex = 0, imageTrigger = null, continuation = false } = {}) {
  const parkingHost = kind === 'hints' && hintContext === 'hex-cube' && panel.dataset?.kind === 'hex-cube'
    ? panel.querySelector('#hex-cube-host') : null;
  const returningHex = kind === 'hex-cube' && parkedMiniHost && miniView;
  if (parkingHost) {
    parkedMiniHost = parkingHost;
    parkingHost.remove();
  } else if (!returningHex) {
    miniView?.destroy();miniView=null;
    parkedMiniHost = null;
  }
  panelRevision++;
  const wasOpen = panel.open;
  const previousPanelKind = panel.dataset?.kind;
  const isImagePanel = ['puzzle-image', 'travel-image', 'ritual-guide'].includes(kind);
  const imageLabel = kind === 'travel-image' ? '案内写真' : kind === 'ritual-guide' ? 'ルール説明' : '問題画像';
  const imageOrigin = (kind === 'puzzle-image' ? document.querySelector('.puzzle-preview') : imageTrigger)?.getBoundingClientRect?.();
  imageReturnElement = isImagePanel ? kind === 'puzzle-image' ? document.querySelector('.puzzle-preview') : imageTrigger : null;
  if (!wasOpen) {
    panelReturnFocus = document.activeElement;
    panelReturnAction = panelReturnFocus?.dataset?.action ?? null;
  }
  imageViewer?.dispose(); imageViewer = null;
  sheetDismiss?.dispose(); sheetDismiss = null;
  panel.style?.removeProperty('--sheet-drag');
  if (panel.dataset) panel.dataset.kind = kind;
  const scrollTop = panel.scrollTop;
  const bodyScrollTop = panel.querySelector('.panel-body')?.scrollTop ?? 0;
  const pickerScrollTop = panel.querySelector('.combine-picker .clue-card-grid')?.scrollTop ?? 0;
  surfaceAnimations.get(panel)?.cancel();
  surfaceAnimations.delete(panel);
  panel.classList.remove('is-closing');
  panel.classList.toggle('image-viewer', isImagePanel);
  panel.classList.toggle('clue-gallery', kind === 'clues');
  panel.classList.toggle('hex-cube-panel', kind === 'hex-cube' || kind === 'luminol');
  panel.classList.toggle('hex-reward-panel', kind === 'hex-reward');
  panel.classList.toggle('hint-panel', kind === 'hints');
  panel.classList.toggle('answer-choice-dialog', ['answer-choices', 'symbol-choices'].includes(kind));
  panel.classList.toggle('symbol-choice-dialog', kind === 'symbol-choices');
  panel.classList.toggle('resume-sheet', kind === 'resume');
  panel.classList.toggle('start-answer-dialog', kind === 'start-answer');
  const pageTurnDialog = kind === 'travel-next' || kind === 'yoi-page-turn';
  panel.classList.toggle('page-turn-dialog', pageTurnDialog);
  const tourThanksDialog = kind === 'tour-thanks';
  panel.classList.toggle('tour-thanks-dialog', tourThanksDialog);
  const afterwordDialog = kind === 'afterword';
  panel.classList.toggle('afterword-dialog', afterwordDialog);
  const surveyDialog = kind === 'survey';
  panel.classList.toggle('survey-sheet', surveyDialog);
  panel.classList.toggle('survey-mei', surveyDialog && Boolean(meiEndView || meiEndRoute));
  const saveInfo = kind === 'save-info';
  panel.classList.toggle('save-info-sheet', saveInfo);
  panel.inert = false;
  const focusedId = keepFocus ? document.activeElement?.id : null;
  let title = '';
  let content = '';
  const p = current();
  const hintSubject = activeHintSubject();
  const hintView = hintSubjectView(hintSubject);
  if (kind === 'clues' && clueTab === 'combine' && !combineUnlocked()) {
    clueTab = 'cards';
    combinePicker = false;
    combineSelecting = false;
    combineSelection = [];
  }
  panel.classList.toggle('image-gallery', (kind === 'puzzle-image' && puzzleImages(p).length > 1) || (kind === 'ritual-guide' && ritualGuideImages().length > 1));
  if (kind === 'hex-cube') {
    title = '控室の問題';
    content = `<div id="hex-cube-host"></div>`;
  } else if (kind === 'hex-reward') {
    const card = pendingReward?.card ?? minigameReward(scenario, 'hex-cube');
    const already = pendingReward ? pendingReward.already : miniRewardAlready;
    const showReplay = !pendingReward && playSaves.getStatus().mode === 'debug';
    title = already ? '取得済みの手がかり' : '手がかりを手に入れた';
    const message = already ? 'この手がかりは取得済みです。' : `新しい手がかり「${esc(card.title)}」を手に入れた。`;
    const noteText = pendingReward?.note || (!already ? paperCardPickupNote(card) : '');
    const note = noteText ? `<strong class="hex-reward-note">${esc(noteText)}</strong>` : '';
    content = `<div class="hex-reward-stage"><div class="hex-reward-flash" aria-hidden="true"></div><div class="hex-reward-card"${already ? ' data-settled="true"' : ''}><div class="hex-reward-spin"><div class="hex-reward-face hex-reward-back" aria-hidden="true"></div><div class="hex-reward-face hex-reward-front"><img src="${esc(card.image)}" alt="${esc(card.title)}（手がかり番号 ${esc(card.number)}）" decoding="async"></div></div></div></div><p class="hex-reward-message" role="status">${message}${note}</p><div class="hex-reward-actions"><button class="primary-button" data-action="hex-card">手がかりを見る</button>${showReplay ? '<button class="secondary-button" data-action="hex-open">もう一度解く</button>' : ''}</div>`;
  } else if (kind === 'hex-pending') {
    title='システム';content='<p role="status">クリアしました。手がかりの保存を確認しています。通信が戻ったら、もう一度確認してください。</p><button class="primary-button full" data-action="hex-save-retry">保存を確認する</button>';
  } else if (kind === 'luminol') {
    title = 'ルミノール検査';
    content = '<div id="luminol-host"></div>';
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
  } else if (kind === 'ritual-guide') {
    title = 'ルール説明';
    const image = ritualGuideImages()[q9GuideIndex] ?? ritualGuideImages()[0];
    content = image ? `<img class="puzzle-full-image" src="${esc(image.src)}" alt="${esc(image.alt)}" draggable="false">` : '';
  } else if (kind === 'puzzle-image') {
    title = `${problemLabel(p)}の問題`;
    const image = puzzleImages(p)[puzzleImageIndex] ?? puzzleImages(p)[0];
    content = `<img class="puzzle-full-image" src="${esc(image.src)}" alt="${esc(image.alt)}" draggable="false">`;
  } else if (kind === 'contact') {
    title = 'お問い合わせ';
    contactStatus = 'idle';
    content = contactFormMarkup();
  } else if (kind === 'trouble') {
    title = 'トラブル';
    content = `<section class="trouble-guide"><header class="trouble-guide-heading"><h3>N5の現地資料が見られないとき</h3><p>会場の4箇所を、貼ってある位置のまま確認できます。写真をタップすると拡大します。</p></header><div class="trouble-photos">${travelGuideMarkup(scenario.troubleGuide, 'trouble')}</div></section>`;
  } else if (kind === 'travel-image') {
    const guide = travelId === 'trouble' ? scenario.troubleGuide
      : travelId === 'venue' ? scenario.venueGuide : scenario.problems.find(item => item.id === travelId)?.travelGuide;
    const step = Number.isInteger(travelIndex) && guide?.steps[travelIndex];
    if (!step) return;
    title = `${guide.destination}の案内写真${travelIndex + 1}`;
    content = `<img class="puzzle-full-image" src="${esc(step.image)}" alt="${esc(step.imageAlt)}" draggable="false">`;
  } else if (kind === 'hints') {
    title = 'ヒント';
    content = hintReaderMarkup(hintView);
  } else if (kind === 'clues' && clueTab === 'cards') {
    title = '手がかり';
    const gallery = clueGalleryItems();
    const openedIndex = gallery.findIndex(card => card.id === expandedClueId);
    if (openedIndex >= 0) {
      markClueSeen(gallery[openedIndex].id);
      content = clueCardExpandedMarkup(gallery, openedIndex);
    } else {
      content = `<div class="clue-card-grid" role="list">${gallery.map(card => `<div role="listitem">${clueCardMarkup(card)}</div>`).join('')}</div>`;
    }
  } else if (kind === 'clues' && clueTab === 'characters') {
    title = '手がかり';
    const people = scenario.characterCards ?? [];
    if (combineSelecting) {
      content = `<div class="clue-card-grid character-grid" role="list">${people.map(card => `<div role="listitem">${clueCardMarkup(card)}</div>`).join('')}</div>`;
    } else {
      const index = Math.max(0, Math.min(people.length - 1, expandedCharacter ?? 0));
      content = `<div class="clue-card-expanded character-sheet"><div class="clue-carousel" tabindex="0" role="region" aria-label="公開情報。横スクロールで切り替え">${people.map((card, i) => cluePhotoCardMarkup(card, { current: i === index })).join('')}</div><div class="character-dots" role="tablist" aria-label="公開情報の位置">${people.map((card, i) => `<button type="button" class="character-dot" data-action="character-dot" data-index="${i}" role="tab" aria-selected="${i === index}" aria-label="${esc(card.title)}"></button>`).join('')}</div></div>`;
    }
  } else if (kind === 'clues' && combinePicker) {
    title = '手がかり';
    const catalog = allPlayCards();
    const remaining = 2 - combineSelection.length;
    content = `<div class="combine-picker"><div class="clue-card-grid" role="list">${catalog.map(card => {
      const selected = combineSelection.includes(card.id);
      const fresh = clueIsNew(card);
      const label = selected ? `${card.title}を入れ替える` : `${card.title}（手がかり番号 ${card.number}）`;
      const order = combineOrderMark(card.id);
      const badge = fresh ? '<span class="clue-new">New</span>' : '';
      return `<div role="listitem"><button type="button" class="clue-card-tile" data-action="combine-toggle" data-id="${esc(card.id)}" aria-pressed="${selected}" aria-label="${esc(`${fresh ? '新しい手がかり。' : ''}${order ? `${label}、${order}` : label}`)}"><span class="clue-card-thumb">${badge}${combineOrderBadge(card.id)}${selected ? '' : '<span class="select-check" aria-hidden="true"></span>'}<img src="${esc(card.image)}" alt="" decoding="async"></span></button></div>`;
    }).join('')}</div><button type="button" class="answer-fab" data-action="combine-confirm" ${remaining === 0 ? '' : 'disabled'}>${icon('edit')}<span>${remaining === 0 ? '次へ' : `あと${remaining}枚`}</span></button></div>`;
  } else if (kind === 'clues') {
    title = '手がかり';
    content = combineGuideMarkup();
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
    const bookletEnd = p.completionScreen === 'booklet' && !followingProblem(p);
    const bookletTarget = !p.travelGuide && !bookletEnd ? (state.solved.includes(p.id) ? followingProblem(p) : null) ?? p : null;
    const bookletLabel = bookletTarget ? (bookletTarget.id === scenario.investigation.id ? scenario.investigation.id : problemLabel(bookletTarget)) : '';
    const bookletQuestion = bookletTarget?.id === 'Q1' ? '確認しましたか？' : '見つけましたか？';
    content = pageTurnCardMarkup(bookletTarget ? `冊子で問題${bookletLabel}を${bookletQuestion}` : storyTurn ? '冊子の次のページをめくろう' : '次の問題を見つけたらページをめくろう', {
      action: bookletEnd ? 'close' : 'travel-found',
      buttonLabel: bookletEnd ? 'ページをめくった' : bookletTarget ? '問題を確認した' : '問題を見つけた',
      notice: notice?.text,
      emphasis: bookletLabel,
    });
  } else if (kind === 'yoi-page-turn') {
    content = pageTurnCardMarkup(p.pageTurnText, { action: 'yoi-next', buttonLabel: '宵の最後まで読んだら次へ' });
  } else if (kind === 'tour-thanks') {
    title = '周遊版のアンケート';
    content = `<h2 id="panel-title" class="sr-only">${title}</h2><button class="icon-button tour-thanks-close" data-action="close" aria-label="閉じる">${icon('close')}</button><div class="tour-thanks"><p>周遊版をプレイしてくださり、ありがとうございました。謎の内容、難易度などはいかがでしたでしょうか？ お時間よろしければアンケートにご回答ください。（所要1分）ご回答いただいた方には、ささやかなお礼として、制作の裏話を綴ったあとがきを公開しております。</p><div class="tour-thanks-book"><img src="../assets/book-mei.webp" width="721" height="1024" alt="11月の救祭 冥 冊子"><div class="tour-thanks-book-info"><p class="tour-thanks-book-title">11月の救祭 冥</p><p class="tour-thanks-book-price">800円</p><p class="tour-thanks-book-note">クスノキ北西 (附属図書館前)で販売中</p></div></div><button type="button" class="primary-button" data-action="tour-survey">アンケートはこちら</button></div>`;
  } else if (kind === 'survey') {
    title = 'アンケート';
    surveyStatus = 'idle';
    content = surveyFormMarkup();
  } else if (kind === 'afterword') {
    title = 'あとがき';
    content = afterwordMarkup();
  } else if (kind === 'clear-post') {
    title = 'クリア';
    const ending = !continuation ? activeMeiEnding() : null;
    const intro = continuation ? '「11月の救祭 宵」をクリアしました。' : ending ? `「${ending.answer}」の結末を迎えました。` : 'すべての謎を解き明かしました。';
    content = `<p class="panel-intro">${esc(intro)}</p>`;
    if (continuation) content += `<div class="yoi-completion-actions clear-post-actions" role="group" aria-label="続きの遊び方"><button class="primary-button yoi-venue-button" data-action="continue-at-venue"><span>会場でプレイする</span></button><button class="secondary-button yoi-online-button" data-action="continue-online"><span>オンラインでプレイする</span></button></div>`;
  } else if (kind === 'start-answer') {
    title = '「次へ」ボタンについて';
    content = '<p class="panel-intro">「次へ」を押すと問題と回答欄が表示されます。問題に回答するときに押してください。</p><div class="reset-actions"><button class="secondary-button" data-action="close">戻る</button><button class="primary-button" data-action="start-answer-confirm">理解した</button></div>';
  } else if (kind === 'reset') {
    title = 'はじめからやり直す';
    content = '<p class="panel-intro">新しい番号で最初から始めます。元の番号の記録は残ります。元の番号は、プレイ中のメニューにある「再開番号」で確認できます。</p><div class="reset-actions"><button class="secondary-button" data-action="close">キャンセル</button><button class="primary-button" data-action="confirm-reset">新しいプレイを始める</button></div>';
  }
  const clueTabs = [['cards', 'カード'], ['characters', '公開情報'], ...(combineUnlocked() ? [['combine', '合成']] : [])];
  panel.innerHTML = kind === 'clues'
    ? `${secondaryScreenHeader('close', { showHint: false })}<div class="clue-screen-bg" aria-hidden="true"></div><div class="clue-screen-content${combineSelecting && !combinePicker && clueTab !== 'combine' ? ' is-combine-selecting' : ''}">${combinePicker ? '' : `<div class="clue-tabs" role="tablist" aria-label="手がかりの表示">${clueTabs.map(([id, label]) => `<button id="clue-tab-${id}" role="tab" data-action="clue-tab" data-tab="${id}" aria-selected="${clueTab === id}" aria-controls="clue-tab-content" tabindex="${clueTab === id ? 0 : -1}">${label}</button>`).join('')}</div>`}<div id="clue-tab-content" class="panel-body" role="tabpanel"${combinePicker ? '' : ` aria-labelledby="clue-tab-${clueTab}"`}>${content}</div>${combineSelectBarMarkup()}${combineFabMarkup()}</div>${combineOutcomeMarkup()}`
    : tourThanksDialog || afterwordDialog ? content
    : pageTurnDialog ? content
    : ['answer-choices', 'symbol-choices'].includes(kind)
    ? `<div class="answer-choice-header"><h2 id="panel-title">${title}</h2><button class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button></div>${content}`
    : isImagePanel
    ? `<h2 id="panel-title" class="sr-only">${title}</h2><button class="icon-button image-viewer-close" data-action="close" aria-label="${imageLabel}を閉じる">${icon('close')}</button><div class="image-viewer-stage" tabindex="0" aria-label="${imageLabel}。ピンチまたはプラス・マイナスで拡大縮小。拡大中はドラッグで移動できます。">${content}</div><div class="image-zoom-controls" role="group" aria-label="画像の拡大縮小"><button data-action="image-zoom-out" aria-label="画像を縮小">−</button><button data-action="image-zoom-reset" aria-label="画像の倍率をリセット"><span data-zoom-label>100%</span></button><button data-action="image-zoom-in" aria-label="画像を拡大">＋</button></div>${kind === 'puzzle-image' ? puzzlePagesMarkup(p) : kind === 'ritual-guide' ? ritualGuidePagesMarkup() : ''}`
    : kind === 'hex-reward'
    ? `<h2 id="panel-title" class="sr-only">${title}</h2><button class="icon-button hex-reward-close" data-action="close" aria-label="閉じる">${icon('close')}</button><div class="panel-body hex-reward-body">${content}</div>`
    : `<div class="panel-header"><div><h2 id="panel-title"${saveInfo ? ' tabindex="-1"' : ''}>${title}</h2></div>${kind === 'hints' ? (hintView?.explanation ? `<button type="button" class="hint-answer-button" data-action="hint-answer" aria-expanded="false"${!hintView.hints.length || (state.hints[hintView.id] || 1) >= hintView.hints.length ? '' : ' hidden'}>解答を見る</button>` : '') : kind === 'hex-cube' ? `<div class="panel-header-actions"><button type="button" class="composer-hint" data-action="hex-hints" aria-label="ヒント">${icon('hint')}<span>ヒント</span></button><button class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button></div>` : `<button class="icon-button" data-action="close" aria-label="閉じる">${icon('close')}</button>`}${kind === 'hints' ? hintTabsMarkup(hintSubject) : ''}</div><div class="panel-body">${content}</div>`;
  const draggableSheet = !isImagePanel && !pageTurnDialog && !tourThanksDialog && !afterwordDialog && !['start-answer', 'answer-choices', 'symbol-choices', 'clues', 'hex-cube', 'hex-reward', 'luminol'].includes(kind);
  panel.classList.toggle('draggable-sheet', draggableSheet);
  if (draggableSheet) {
    const header = panel.querySelector('.panel-header');
    header?.insertAdjacentHTML?.('afterbegin', '<button class="sheet-handle" type="button" data-action="close" aria-label="パネルを閉じる。下に引いて閉じることもできます"><span></span></button>');
    sheetDismiss = bindSheetDismiss(panel, { onDismiss() { haptics.trigger('dismiss'); closePanel(); }, canDismiss: () => !gateBusy, motion: reducedMotion, onThreshold: () => haptics.trigger(), onStart() { surfaceAnimations.get(panel)?.cancel(); surfaceAnimations.delete(panel); } });
  }
  if (kind === 'hints') {
    const summary = panel.querySelector('.hint-answer summary');
    summary?.setAttribute('tabindex', '-1');
    summary?.setAttribute('aria-hidden', 'true');
    if (hintSubject?.explanation) panel.insertAdjacentHTML?.('beforeend', `<div class="hint-confirm" hidden><div class="hint-confirm-card" role="dialog" aria-modal="true" aria-labelledby="hint-confirm-title"><button type="button" class="icon-button hint-confirm-close" data-action="hint-answer-cancel" aria-label="閉じる">${icon('close')}</button><div class="panel-header"><div><h2 id="hint-confirm-title">解答を見る</h2></div></div><div class="panel-body"><p class="panel-intro">絵馬を裏返して、答えを表示します。</p><div class="reset-actions"><button type="button" class="primary-button" data-action="hint-answer-confirm">解答を見る</button></div></div></div></div>`);
  }
  if (!panel.open) panel.showModal();
  syncNavigation();
  if (isImagePanel) {
    imageViewer = bindImageViewer(panel, {
      win: window, onPage: delta => {
        if (kind === 'puzzle-image') setPuzzleImage(puzzleImageIndex + delta);
        else if (kind === 'ritual-guide') setRitualGuidePage(q9GuideIndex + delta);
      },
      motion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      onInteract() {
        const image = panel.querySelector('.puzzle-full-image');
        surfaceAnimations.get(image)?.cancel(); surfaceAnimations.delete(image);
      },
    });
    imageViewer?.revealFrom(imageOrigin);
    // 起点のない画像パネル（儀式ガイドなど）にも、中央への出入りを付ける。
    if (!imageOrigin) animateScale(panel, true, .94);
  }
  if (kind === 'hex-cube') {
    if (parkedMiniHost) {
      panel.querySelector('#hex-cube-host')?.replaceWith(parkedMiniHost);
      parkedMiniHost = null;
    } else {
      if (!resolvedMountHexCube) throw new Error('六角形の装置を読み込めていません。');
      miniView=resolvedMountHexCube(panel.querySelector('#hex-cube-host'),{onComplete:finishHexCube,onFailure:recordHexFailure,canInteract:()=>!gateVisible&&!miniSaving&&playSaves.getStatus().phase!=='conflict'});
    }
  }
  if (kind === 'luminol') {
    if (!resolvedMountLuminol) throw new Error('ルミノール検査を読み込めていません。');
    miniView = resolvedMountLuminol(panel.querySelector('#luminol-host'), { canInteract: () => !gateVisible, onDone() { closePanel(); } });
  }
  if (kind === 'hex-reward') playHexRewardReveal();
  if (kind === 'hints') bindHintReader(hintView);
  if (kind === 'clues' && clueTab === 'cards' && expandedClueId && panel.querySelector('.clue-carousel')) {
    bindClueCarousel(Math.max(0, clueGalleryItems().findIndex(card => card.id === expandedClueId)));
  } else if (kind === 'clues' && clueTab === 'characters' && panel.querySelector('.clue-carousel')) bindClueCarousel(Math.max(0, expandedCharacter ?? 0));
  if (kind === 'clues' && clueTab === 'combine' && !combinePicker) animateSurface(panel.querySelector('.combine-tab-fab'), true, 16);
  if (kind === 'clues' && ['cards', 'characters'].includes(clueTab) && !combinePicker) bindCombineCardGestures();
  viewportLayout.schedule();
  const centeredDialog = pageTurnDialog || tourThanksDialog || afterwordDialog || ['start-answer', 'answer-choices', 'symbol-choices'].includes(kind);
  if (kind === 'clues') {
    if (revealSelector) animateSurface(panel.querySelector(revealSelector), true, 8);
    else if (!wasOpen) animateSurface(panel, true, 16, 'X');
    else if (previousPanelKind !== kind) animateSurface(panel.querySelector('.clue-screen-content'), true, 0, 'Y', MOTION.state);
  } else if (centeredDialog && !wasOpen) {
    const fromTrigger = ['answer-choices', 'symbol-choices'].includes(kind) && animateFromRect(panel, panelReturnFocus?.getBoundingClientRect?.());
    if (!fromTrigger) animateScale(panel, true, .94);
  } else if (kind !== 'hex-reward' && !isImagePanel && (kind !== 'resume' || !wasOpen) && (!wasOpen || previousPanelKind !== kind || revealSelector)) {
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
  if (kind === 'clues' && combineOutcome) mountCombineOutcome();
  if (wasOpen && keepFocus) {
    panel.scrollTop = scrollTop;
    const body = panel.querySelector('.panel-body');
    if (body) body.scrollTop = bodyScrollTop;
    const pickerGrid = panel.querySelector('.combine-picker .clue-card-grid');
    if (pickerGrid) pickerGrid.scrollTop = pickerScrollTop;
  }
}

function selectProblem(id, { start = false, openOverScene = false, preserveConversation = openOverScene, answering = false, investigationDetail = false, meiEnding = null } = {}) {
  const nextProblem = scenario.problems.find(p => p.id === id);
  if (!nextProblem) return;
  if (panel.dataset?.kind === 'ritual-guide' && (id !== 'Q9' || meiEnding)) dismissRitualGuideNow();
  const slideIn = !openOverScene || (current().autoOpenContinuation && current().continueTo === id);
  const switchingProblem = state.selected !== id;
  rememberAnswerDraft();
  if (historyView) closeHistoryScreen();
  if (!canOpenProblem(nextProblem, state)) { showInvestigation(); return; }
  if (id === scenario.investigation.id && !investigationDetail) { showInvestigation(); return; }
  answerOrigin = openOverScene ? {
    problemId: state.selected, answerId: id, repeatAnswer,
    scrollTop: document.querySelector('.chat-area').scrollTop,
    scrollLeft: document.querySelector('.chat-area .travel-guide-gallery')?.scrollLeft ?? 0,
  } : null;
  if (!openOverScene) pageTurnRevealed = false;
  investigationView = investigationClosing = false;
  if (nextProblem.type === 'pending') composerExpanded = false;
  if (!preserveConversation && (nextProblem.answerPresentation === 'page' || nextProblem.openAnswerOnEntry === true)) composerExpanded = answering && nextProblem.openAnswerOnEntry === true;
  if (!openOverScene && !answering && nextProblem.openAnswerOnEntry === false) composerExpanded = false;
  if (!preserveConversation || state.selected !== id) {
    selectedSymbols = nextProblem.answerSlots ? [...(answerDrafts[id] ?? Array(nextProblem.answerSlots).fill(''))] : [];
    activeSymbolSlot = 0;
  }
  if (!preserveConversation || current().images !== nextProblem.images) puzzleImageIndex = 0;
  conversationPlayer.stop(); isPlaying = false;
  if (switchingProblem) {
    epiloguePhase = null;
    cancelEpilogueMotion();
  }
  problemMenuExpanded = false;
  const resetBackground = !preserveConversation || (!openOverScene && nextProblem.conversationBackground === 'empty');
  if (resetBackground) resetChatFollow();
  startView = start;
  yoiEndView = meiPlayChoiceVisible = false;
  meiEndRoute = meiEnding;
  meiEndView = Boolean(meiEnding);
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
    if (switchingProblem && !preserveConversation) {
      animateFade(document.querySelector('.chat-area'), true, MOTION.state);
      animateSurface(document.querySelector('#problem-navigation'), true, -4, 'Y', MOTION.state);
    }
    animateSurface(document.querySelector('.q4-pending'), true, 8);
  }
  if (resetBackground) document.querySelector('.chat-area').scrollTop = nextProblem.conversationBackground === 'investigation' ? investigationScrollTop : 0;
  if (!preserveConversation && displayedMessages.length) animateSurface(document.querySelector('#messages'), true, 8);
  if (start && !preserveConversation) animateSurface(document.querySelector('.start-guide'), true, 8);
  if (composerExpanded) animateSurface(document.querySelector('.composer-area'), true, slideIn ? 12 : 0);
  else if (!isPlaying) animateSurface(document.querySelector('.answer-fab'), true, 8);
  if (composerExpanded) document.querySelector('.composer-area')?.focus({ preventScroll: true });
  maybeShowQ9Guide();
}

// 複数欄・複数選択・スロット入力の問題では、間違えた部分だけを揺らす対象を返す。
function incorrectAnswerTargets(problem, value) {
  const form = document.querySelector('#answer-form');
  if (!form) return [];
  if (problem.type === 'fields' && Array.isArray(value) && !problem.answerCombos) {
    const elements = [...form.querySelectorAll('.answer-field, fieldset.answer-options, .room-word-input')];
    return problem.fields.map((field, index) => {
      const wrong = !field.answers.some(item => normalizeAnswer(item) === normalizeAnswer(value[index]));
      // 空欄のまま揺らすと「この欄は矛盾なし」と明かしてしまう問題があるため、空欄は揺らさない。
      return wrong && normalizeAnswer(value[index]) ? elements[index] : null;
    }).filter(Boolean);
  }
  if (problem.type === 'multiple' && Array.isArray(value)) {
    const selected = new Set(value);
    const options = form.querySelectorAll('.option');
    return problem.options.map((option, index) => selected.has(option.id) && !problem.answers.includes(option.id) ? options[index] : null).filter(Boolean);
  }
  if (problem.answerSlots && typeof value === 'string') {
    const submitted = [...normalizeAnswer(value)];
    const answers = problem.answers.map(item => [...normalizeAnswer(item)]);
    return [...form.querySelectorAll('.symbol-slot-button')].filter((element, index) =>
      answers.every(answer => (answer[index] ?? '') !== (submitted[index] ?? '')));
  }
  return [];
}

function setAnswerError(incorrect, value = null) {
  answerErrorAnimations.forEach(animation => animation.cancel());
  answerErrorAnimations = [];
  const form = document.querySelector('#answer-form');
  if (!form) return;
  const targets = incorrect ? incorrectAnswerTargets(current(), value) : [];
  // 未記入が不正解でも、欄を塗ると記入すべき場所が分かる。記入した誤りの欄が無いときは全体にも色を付けない。
  const concealUnfilled = incorrect && current().concealBlankFields && !targets.length;
  form.classList.toggle('is-incorrect', incorrect && !targets.length && !concealUnfilled);
  form.querySelectorAll('.is-incorrect').forEach(element => element.classList.remove('is-incorrect'));
  form.querySelectorAll('input:not([type="hidden"]), select, .answer-choice-trigger, .symbol-slot-fields, .symbol-slot-button, .answer-options').forEach(field => {
    if (incorrect && !targets.length && !concealUnfilled) field.setAttribute('aria-invalid', 'true');
    else field.removeAttribute('aria-invalid');
  });
  for (const target of targets) {
    target.classList.add('is-incorrect');
    const controls = target.matches?.('input, select, button')
      ? [target]
      : [...(target.querySelectorAll?.('input:not([type="hidden"]), select, button') ?? [])];
    controls.forEach(control => control.setAttribute('aria-invalid', 'true'));
  }
  const status = document.querySelector('#answer-error');
  if (status) status.textContent = incorrect ? '答えが違います。もう一度回答してください。' : '';
  if (!incorrect || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const shake = element => element?.animate?.(
    [0, -6, 6, -5, 5, -2, 0].map(x => ({ transform: `translateX(${x}px)` })),
    { duration: 380, easing: 'ease-in-out' },
  );
  const animated = targets.length
    ? targets.map(shake)
    : concealUnfilled
      ? []
      : [shake(form.querySelector('.answer-fields, .text-composer, .answer-choice-trigger, .symbol-slot-fields, .answer-options'))];
  answerErrorAnimations = animated.filter(Boolean);
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
  let replayStart = start;
  if (result.status === 'correct') {
    const milestone = !wasSolved && (problem.completionScreen || (!investigationWasComplete && investigationComplete(scenario, result.state)));
    haptics.trigger(milestone ? 'complete' : 'success');
  }
  else if (result.status === 'progress') haptics.trigger('success');
  else if (['incorrect', 'empty'].includes(result.status)) haptics.trigger('error');
  if (startView || repeatAnswer) {
    let messages = result.state.messages;
    // 正解の再回答は、同じ問題の会話を積み増さず新しい一回分に置き換える。
    if (result.status === 'correct' && messages.length > start) {
      const added = messages.slice(start);
      const kept = state.messages.filter(message => message.problemId !== problem.id);
      messages = [...kept, ...added];
      replayStart = kept.length;
    }
    result.state = { ...result.state, solved: [...new Set([...state.solved, ...result.state.solved])], messages };
  }
  state = result.state;
  // フォームが閉じ・差し替えになる送信ではフォーカスを外してキーボードを確実に下げる。
  // フォーカス済み入力の削除だけではキーボードが閉じず、可視領域の高さが戻らない端末があるため。
  if (result.status !== 'empty' && !(result.status === 'incorrect' && !result.response)) document.activeElement?.blur?.();
  if (result.status === 'correct' || result.status === 'progress') { repeatAnswer = false; delete answerDrafts[problem.id]; }
  if (result.status === 'correct' && problem.advanceTo && answerOrigin) answerOrigin.answerId = state.selected;
  feedback = result.status === 'empty' ? problem.answerSlots ? `${problem.answerSlots}つすべての空欄を選択してください。` : '答えを入力・選択してください。' : '';
  save();
  if (result.status === 'incorrect') {
    if (result.response) {
      setAnswerError(false);
      playConversation(replayStart);
      return { status: result.status, problemId: problem.id };
    }
    const feedbackArea = document.querySelector('.composer-area .feedback');
    if (feedbackArea) feedbackArea.textContent = storageWarning;
    setAnswerError(true, value);
    return { status: result.status, problemId: problem.id };
  }
  if (result.status === 'progress') {
    setAnswerError(false);
    const composer = document.querySelector('.composer-area');
    if (composer) {
      composer.innerHTML = composerContentMarkup(problem);
      bindPuzzleSubmitLayout();
      prepareAnswerForm();
      composer.scrollTop = 0;
      const focusTarget = problem.answerChoices || problem.fields?.some(field => field.answerChoices) || problem.answerControl === 'select'
        ? composer : document.querySelector('#answer') ?? composer.querySelector?.('#answer-form input');
      focusTarget?.focus({ preventScroll: true });
      animateQuestionAdvance(composer);
    }
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
  else if (result.status === 'correct') playConversation(replayStart, { fromCorrectAnswer: true });
  else render();
  return { status: result.status, problemId: problem.id };
}

document.addEventListener('click', event => {
  const summary = event.target.closest('summary');
  if (summary?.parentElement?.matches('.history-entry, .answer-reveal:not(.hint-answer), .trouble-photos, .afterword-note') && toggleDisclosure(summary.parentElement, reducedMotion())) {
    event.preventDefault();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (event.target.classList?.contains('hint-confirm')) {
    setHintConfirm(event.target, false);
    panel.querySelector('.hint-answer-button')?.focus({ preventScroll: true });
    return;
  }
  if (button?.disabled || button?.closest?.('[inert]')) return;
  const action = button?.dataset.action;
  if ((!event.target.closest('.navigation-menu') && !event.target.closest('#navigation-menu')) || event.target.closest('.menu-items [data-action]')) setMenuExpanded(false);
  if (!event.target.closest('.problem-navigation')) setProblemMenuExpanded(false);
  if (!button) return;
  if (['toggle-menu', 'toggle-problems', 'open-composer', 'travel-found', 'select', 'investigation-closing', 'investigation-back', 'investigation-next', 'investigation-open', 'yoi-next', 'yoi-end', 'yoi-page-turn', 'mei-end', 'mei-survey', 'continue-at-venue', 'continue-online', 'play-mei', 'end-play', 'tour-thanks', 'tour-survey', 'history', 'history-back', 'hints', 'hex-hints', 'clues', 'chat', 'trouble', 'contact', 'save-info', 'save-delete-confirm', 'puzzle-image', 'travel-image', 'answer-choices', 'symbol-slot', 'continue-conversation', 'next', 'replay', 'branch', 'start', 'start-answer-confirm', 'confirm-reset', 'puzzle-page', 'ritual-guide', 'ritual-guide-page', 'image-zoom-in', 'image-zoom-out', 'image-zoom-reset', 'hex-open', 'hex-replay', 'replay-q9', 'hex-card', 'hex-save-retry', 'luminol-open', 'save-continue', 'save-new', 'save-start', 'save-entry', 'save-retry', 'save-delete', 'hint-answer', 'hint-answer-cancel'].includes(action)) haptics.trigger();
  if (['close', 'close-menu', 'save-entry-back'].includes(action)) haptics.trigger('dismiss');
  if (action === 'hex-open') { if (!hexEntryLocked()) openHexCube(); return; }
  if (action === 'hex-hints') { hintContext = 'hex-cube'; openPanel('hints'); return; }
  if (action === 'luminol-open') { void openLuminol(); return; }
  if (action === 'hex-replay') { openHexCube('hex-cube', { replay: true }); return; }
  if (action === 'replay-q9') { replayQ9(); return; }
  if (action === 'hex-save-retry') {if(!miniSaving){miniSaving=true;hexReturnToChat=false;void confirmHexReward().finally(()=>{miniSaving=false;});}return;}
  if (action === 'hex-card') {
    const rewardId = pendingReward?.card?.id ?? null;
    pendingReward = null;
    clueTab = 'cards';
    expandedCharacter = null;
    expandedClueId = rewardId && (scenario.clueGallery ?? []).some(card => card.id === rewardId) ? rewardId : null;
    clearCombineSelecting();
    openPanel('clues');
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
    // 開始直後は使い方案内だけを見せ、N1の回答欄は「次へ」から開く。
    closePanel();
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
  else if (action === 'save-title' || (action === 'end-play' && yoiEndView)) {
    save(); conversationPlayer.stop(); isPlaying = false; closePanel();
    gateVisible = true; gateInput = false; gateError = ''; gateCode = ''; gateDigits = Array(6).fill('');
    const leavingDebug = playSaves.getStatus().mode === 'debug';
    if (leavingDebug) playSaves.leaveSession();
    localRecord = playSaves.getRecord() ?? playSaves.readLocal();
    void transitionToEntry();
    if (!leavingDebug) void playSaves.flush();
    return;
  }
  else if (action === 'save-entry') {
    save(); conversationPlayer.stop(); isPlaying = false; closePanel(); gateVisible = true; gateInput = true; gateError = ''; gateCode = ''; gateDigits = Array(6).fill(''); playSaves.leaveSession(); localRecord = playSaves.readLocal(); void transitionToEntry(); return;
  }
  else if (action === 'save-retry') { void playSaves.retry().then(() => openPanel('save-info')).catch(error => { gateError = error.message; openPanel('save-info'); }); return; }
  else if (action === 'save-delete') {
    if (saveMutationBusy) return;
    saveMutationBusy = true;
    button.disabled = true;
    conversationPlayer.stop(); isPlaying = false;
    void playSaves.deleteCurrent().then(deleted => { if (!deleted) { openPanel('save-info'); return; } conversationPlayer.stop(); isPlaying = false; legacyState = null; localRecord = null; gateVisible = true; gateInput = false; gateError = ''; gateCode = ''; gateDigits = Array(6).fill(''); closePanel(); void transitionToEntry(); }).catch(error => { gateError = error.message; openPanel('save-info'); }).finally(() => { saveMutationBusy = false; }); return;
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
  else if (action === 'mei-end') {
    const routeId = button.dataset.id || state.branches.Q9;
    if (routeId && visibleMeiEndings().some(item => item.id === routeId)) {
      showMeiEnding(routeId);
      return;
    }
    if (state.solved.includes('Q9') || playSaves?.getStatus().mode === 'debug') {
      composerExpanded = false; selectProblem('Q9');
      meiEndView = true; resetChatFollow(); render();
      document.querySelector('#mei-completion-title')?.focus({ preventScroll: true });
      animateSurface(document.querySelector('.mei-completion'), true, 8);
    }
    return;
  }
  else if (action === 'mei-survey' && (meiEndRoute || meiEndView)) {
    openPanel('survey');
    return;
  }
  else if (action === 'yoi-end' && (state.solved.includes(scenario.problems.find(p => p.completionScreen === 'yoi')?.id) || playSaves?.getStatus().mode === 'debug')) {
    composerExpanded = false; selectProblem(scenario.problems.find(p => p.completionScreen === 'yoi').id);
    yoiEndView = true; meiPlayChoiceVisible = false; resetChatFollow(); render();
    document.querySelector('#yoi-completion-title')?.focus({ preventScroll: true });
    animateSurface(document.querySelector('.yoi-completion'), true, 8);
  }
  else if (action === 'yoi-page-turn' && awaitingYoiPageTurn()) openPanel('yoi-page-turn');
  else if (action === 'yoi-next' && awaitingYoiPageTurn() && panel.open && panel.dataset.kind === 'yoi-page-turn') {
    closePanel();
    yoiEndView = true; meiPlayChoiceVisible = false; resetChatFollow(); render();
    document.querySelector('#yoi-completion-title')?.focus({ preventScroll: true });
    animateSurface(document.querySelector('.yoi-completion'), true, 8);
  }
  else if (action === 'tour-thanks' && yoiEndView) {
    openPanel('tour-thanks');
    return;
  }
  else if (action === 'tour-survey') {
    openPanel('survey');
    return;
  }
  else if (action === 'play-mei' && yoiEndView && state.solved.includes(current().id)) {
    openPanel('clear-post', { continuation: true });
    return;
  }
  else if (['continue-at-venue', 'continue-online'].includes(action) && yoiEndView && state.solved.includes(current().id)) {
    if (panel.open) closePanel();
    showVenueDirections = action === 'continue-at-venue';
    meiPlayChoiceVisible = false;
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
    // 暗転しためくり指示は一度だけの合図。ポップアップ以降は直前の会話を背景に戻す。
    if (current().deferPageTurn) {
      pageTurnRevealed = true;
      const turnButton = document.querySelector('.page-turn-scene');
      render();
      // ボタンは再描画で消えるので、戻してから退場させる。
      if (turnButton && !reducedMotion()) {
        turnButton.inert = true;
        document.querySelector('.workspace')?.append(turnButton);
        void animateFade(turnButton, false, MOTION.exit).finally(() => turnButton.remove());
      }
    }
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
  else if (action === 'ritual-guide') openRitualGuide();
  else if (action === 'ritual-guide-page' && panel.open && panel.dataset.kind === 'ritual-guide') setRitualGuidePage(Number(button.dataset.index));
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
      animateSurface(panel.querySelector(`#picker-symbol-slot-${activeSymbolSlot}`), true, 3);
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
    const sourceRect = cardImageRect(button);
    expandedCharacter = index;
    expandedClueId = null;
    haptics.trigger();
    openPanel('clues');
    panel.querySelector('.clue-carousel')?.focus({ preventScroll: true });
    animateCardFrom(panel.querySelector('.clue-gallery-card[aria-current="true"]'), sourceRect);
  }
  else if (action === 'character-dismiss' && !event.target.closest('.clue-gallery-card')) {
    closeCharacterPreview();
  }
  else if (action === 'clue-card-open' && (clueTab === 'cards' || (clueTab === 'characters' && combineSelecting))) {
    if (combineClickSuppressed(button.dataset.id)) {
      combineSuppressCard = null;
      return;
    }
    if (combineSelecting) {
      if (!toggleCombineCard(button.dataset.id)) return;
      haptics.trigger();
      refreshCombineSelection(button.dataset.id);
      return;
    }
    const card = clueGalleryItems().find(item => item.id === button.dataset.id);
    if (!card) return;
    const sourceRect = cardImageRect(button);
    expandedClueId = card.id;
    expandedCharacter = null;
    haptics.trigger();
    openPanel('clues');
    panel.querySelector('[data-action="clue-card-close"]')?.focus({ preventScroll: true });
    animateCardFrom(panel.querySelector('.clue-gallery-card[aria-current="true"]'), sourceRect);
  }
  else if (action === 'clue-card-close' && clueTab === 'cards') {
    haptics.trigger();
    closeClueCardPreview();
  }
  else if (action === 'clue-tab' && ['cards', 'characters', 'combine'].includes(button.dataset.tab)) {
    switchClueTab(button.dataset.tab);
  }
  else if (action === 'hint-tab') {
    switchHintTab(button.dataset.tab);
  }
  else if (action === 'combine-pick' && clueTab === 'combine' && combineUnlocked()) {
    combinePicker = true;
    combineReplaceAt = null;
    haptics.trigger();
    openPanel('clues');
    animateSurface(panel.querySelector('.combine-picker'), true, 24);
  }
  else if (action === 'combine-picker-close' && combinePicker) {
    combinePicker = false;
    combineReplaceAt = null;
    haptics.trigger();
    openPanel('clues');
    animateFade(panel.querySelector('#clue-tab-content'), true, MOTION.state);
  }
  else if (action === 'combine-toggle' && combinePicker) {
    const id = button.dataset.id;
    if (!allPlayCards().some(card => card.id === id)) return;
    placeCombineCard(id);
    combineReplaceAt = null;
    haptics.trigger();
    refreshCombineSelection(id);
  }
  else if (action === 'character-dot' && clueTab === 'characters' && !combineSelecting) {
    const index = Number(button.dataset.index);
    const track = panel.querySelector('.clue-carousel');
    const cards = [...(track?.querySelectorAll('.clue-gallery-card') ?? [])];
    const card = cards[index];
    if (!track || !card) return;
    expandedCharacter = index;
    track.style.scrollSnapType = 'none';
    track.scrollLeft = card.offsetLeft + card.offsetWidth / 2 - track.clientWidth / 2;
    track.style.scrollSnapType = '';
    track.dispatchEvent(new Event('scroll'));
  }
  else if (action === 'combine-select-cancel' && combineSelecting) {
    clearCombineSelecting();
    haptics.trigger();
    openPanel('clues', { keepFocus: true });
  }
  else if (action === 'combine-outcome-next') { haptics.trigger(); finishCombineOutcome(); return; }
  else if (action === 'combine-confirm' && combinePicker && combineSelection.length === 2) {
    const ids = [...combineSelection];
    const returnTab = clueTab;
    combinePicker = false;
    combineReplaceAt = null;
    combineSelecting = false;
    applyCombineResult(ids, returnTab);
  }
  else if (action === 'combine-select-run' && combineSelecting && combineSelection.length === 2) {
    const ids = [...combineSelection];
    const returnTab = clueTab;
    combineSelecting = false;
    combinePicker = false;
    combineReplaceAt = null;
    expandedClueId = null;
    expandedCharacter = null;
    applyCombineResult(ids, returnTab);
  }
  else if (['hints', 'clues', 'trouble', 'contact', 'save-info', 'save-delete-confirm', 'puzzle-image', 'answer-choices'].includes(action)) {
    if (action === 'hints') hintContext = null;
    if (action === 'clues') {
      clueTab = 'cards';
      expandedCharacter = null;
      expandedClueId = null;
      combinePicker = false;
      clearCombineSelecting();
    }
    openPanel(action);
  }
  else if (action === 'close') closePanel();
  else if (action === 'hint-answer') {
    const popup = panel.querySelector('.hint-confirm');
    if (!popup || panel.querySelector('.hint-answer')?.hidden) return;
    setHintConfirm(popup, true);
    popup.querySelector('[data-action="hint-answer-confirm"]')?.focus({ preventScroll: true });
  }
  else if (action === 'hint-answer-cancel') {
    setHintConfirm(panel.querySelector('.hint-confirm'), false);
    panel.querySelector('.hint-answer-button')?.focus({ preventScroll: true });
  }
  else if (action === 'hint-answer-confirm') {
    haptics.trigger('paper');
    setHintConfirm(panel.querySelector('.hint-confirm'), false);
    const flip = panel.querySelector('.hint-ema-flip');
    const back = panel.querySelector('.hint-ema-back');
    const headerButton = panel.querySelector('.hint-answer-button');
    if (headerButton) headerButton.hidden = true;
    if (!flip) return;
    back?.removeAttribute('aria-hidden');
    if (reducedMotion()) { flip.classList.add('is-flipped'); return; }
    const front = flip.querySelector('.hint-ema-front');
    const finish = () => {
      front?.removeEventListener('transitionend', finish);
      flip.classList.add('is-flipped');
      flip.classList.remove('is-turning');
    };
    front?.addEventListener('transitionend', finish);
    flip.classList.add('is-turning');
  }
  else if (action === 'continue-conversation') {
    resetChatFollow(); updateConversationNotice(); scrollConversationToEnd(true);
  }
  else if (action === 'scene-blackout' && epilogueBlackoutActive && isPlaying && !historyView && !gateVisible) {
    return;
  }
  else if (action === 'epilogue-next' && epiloguePhase && !historyView && !gateVisible) {
    if (epiloguePhase === 'blackout' || epilogueBlackoutActive || epilogueBlackoutVisible()) return;
    if (!isPlaying) {
      if (current()?.id === 'Q9' && state.branches.Q9) showMeiEnding(state.branches.Q9);
      return;
    }
    // 題字の表示はタップで早送りしない。
    if (epiloguePhase === 'title' || epilogueFading) return;
    haptics.trigger('dialogue');
    advanceNovel();
  }
  else if (action === 'novel-next' && isPlaying && novelPlayback && !historyView && !gateVisible) {
    if (epilogueBlackoutActive || epilogueBlackoutVisible()) return;
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
  if (!combinePicker && event.target?.dataset?.action === 'clue-tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = clueTabsAvailable();
    const index = tabs.indexOf(clueTab);
    switchClueTab(tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]);
    return;
  }
  if (event.target?.dataset?.action === 'hint-tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    const tabs = (hintTabs(activeHintSubject()) ?? []).map(tab => tab.id);
    if (!tabs.length) return;
    event.preventDefault();
    const index = Math.max(0, tabs.indexOf(hintTab));
    switchHintTab(tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]);
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
  } else if (composerExpanded) answerAreaBack();
});
for (const name of ['input', 'change']) {
  document.addEventListener(name, event => {
    if (name === 'change' && event.target.matches?.('input[type="checkbox"]') && event.target.closest?.('#answer-form')) capMultiSelection(event.target);
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
function surveyScaleMeaning(track, value) {
  const low = track.dataset.low ?? '';
  const high = track.dataset.high ?? '';
  if (value === 1) return low;
  if (value === 5) return high;
  if (value === 3) return '丁度良い';
  if (value === 2) return `やや${low}`;
  return `やや${high}`;
}

function surveyScaleFromX(track, clientX) {
  const rail = track.querySelector('.survey-scale-rail');
  const rect = rail.getBoundingClientRect();
  const ratio = rect.width ? (clientX - rect.left) / rect.width : 0;
  return 1 + Math.round(Math.min(1, Math.max(0, ratio)) * 4);
}

function setSurveyScale(input, value) {
  const next = String(value);
  const changed = input.dataset.set !== 'true' || input.value !== next;
  input.value = next;
  input.dataset.set = 'true';
  const scale = input.closest('.survey-scale');
  const track = scale?.querySelector('[data-scale-track]');
  if (!scale || !track) return;
  scale.style.setProperty('--scale', String((Number(next) - 1) / 4));
  scale.classList.add('is-set');
  scale.classList.remove('is-missing');
  const meaning = surveyScaleMeaning(track, Number(next));
  const thumb = scale.querySelector('.survey-scale-thumb');
  const readout = scale.querySelector('.survey-scale-readout');
  if (thumb) thumb.textContent = next;
  if (readout) readout.textContent = `${next}　${meaning}`;
  track.setAttribute('aria-valuenow', next);
  track.setAttribute('aria-valuetext', `${next}、${meaning}`);
  if (changed) haptics.trigger('selection');
}

function resetSurveyScale(input) {
  input.value = '';
  delete input.dataset.set;
  const scale = input.closest('.survey-scale');
  const track = scale?.querySelector('[data-scale-track]');
  scale?.classList.remove('is-set', 'is-missing');
  scale?.style.setProperty('--scale', '0');
  const thumb = scale?.querySelector('.survey-scale-thumb');
  const readout = scale?.querySelector('.survey-scale-readout');
  if (thumb) thumb.textContent = '';
  if (readout) readout.textContent = '';
  track?.removeAttribute('aria-valuenow');
  track?.setAttribute('aria-valuetext', '未選択');
}

function endSurveyScaleDrag(event) {
  if (!surveyScaleDrag || event.pointerId !== surveyScaleDrag.id) return;
  surveyScaleDrag.track.releasePointerCapture?.(event.pointerId);
  surveyScaleDrag = null;
}

async function submitSurvey(form) {
  if (surveyStatus === 'sending') return;
  const code = normalizePlayCode(playSaves.getRecord()?.code);
  const errorNode = form.querySelector('#survey-error');
  const submit = form.querySelector('[type="submit"]');
  const fail = message => {
    surveyStatus = 'idle';
    if (submit) { submit.disabled = false; submit.textContent = '送信する'; submit.removeAttribute('aria-busy'); }
    if (errorNode) { errorNode.textContent = message; errorNode.hidden = false; }
    haptics.trigger('error');
  };
  if (!code) { fail('再開番号がまだ発行されていません。通信状態を確認してから開き直してください。'); return; }
  const missing = [...(form.querySelectorAll?.('.survey-scale-input') ?? [])].find(input => !input.disabled && input.dataset.set !== 'true');
  if (missing) {
    const scale = missing.closest('.survey-scale');
    scale?.classList.add('is-missing');
    fail('横にスライドして、ボリュームと難易度を選んでください。');
    scale?.querySelector('[data-scale-track]')?.focus();
    return;
  }
  surveyStatus = 'sending';
  if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); submit.textContent = '送信中…'; }
  if (errorNode) errorNode.hidden = true;
  const data = new FormData(form);
  const params = new URLSearchParams();
  params.set(SURVEY_ENTRIES.code, code);
  for (const [name, entry] of Object.entries({ progress: SURVEY_ENTRIES.progress, affiliation: SURVEY_ENTRIES.affiliation, yoiVolume: SURVEY_ENTRIES.yoiVolume, yoiDifficulty: SURVEY_ENTRIES.yoiDifficulty, meiVolume: SURVEY_ENTRIES.meiVolume, meiDifficulty: SURVEY_ENTRIES.meiDifficulty, feedback: SURVEY_ENTRIES.feedback })) {
    const value = data.get(name);
    if (typeof value === 'string' && value) params.set(entry, value);
  }
  const ending = surveyEndingAnswer();
  if (ending) params.set(SURVEY_ENTRIES.ending, ending);
  // 分岐するフォームは通過したページを pageHistory で送らないと、2ページ目以降の回答が記録されない。
  params.set('pageHistory', ending ? '0,1,2' : '0,2');
  const revision = panelRevision;
  try {
    await fetch(SURVEY_ENDPOINT, { method: 'POST', mode: 'no-cors', body: params });
  } catch {
    if (panel.open && panel.dataset?.kind === 'survey' && panelRevision === revision) fail('送信できませんでした。通信状態を確認して、もう一度お試しください。');
    else surveyStatus = 'idle';
    return;
  }
  if (!panel.open || panel.dataset?.kind !== 'survey' || panelRevision !== revision) return;
  surveyStatus = 'done';
  haptics.trigger('success');
  const body = panel.querySelector('.panel-body');
  if (body) {
    body.innerHTML = '<div class="survey-thanks" role="status"><p>ご回答ありがとうございました。</p><p class="muted">まもなくあとがきを開きます。</p></div>';
    animateSurface(body.querySelector('.survey-thanks'), true, 8);
  }
  setTimeout(() => { if (panel.open && panel.dataset?.kind === 'survey' && panelRevision === revision) openPanel('afterword'); }, 1800);
}

async function submitContact(form) {
  if (contactStatus === 'sending') return;
  const errorNode = form.querySelector('#contact-error');
  const submit = form.querySelector('[type="submit"]');
  const fail = message => {
    contactStatus = 'idle';
    if (submit) { submit.disabled = false; submit.textContent = '送信する'; submit.removeAttribute('aria-busy'); }
    if (errorNode) { errorNode.textContent = message; errorNode.hidden = false; }
    haptics.trigger('error');
  };
  contactStatus = 'sending';
  if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); submit.textContent = '送信中…'; }
  if (errorNode) errorNode.hidden = true;
  const data = new FormData(form);
  const revision = panelRevision;
  try {
    const res = await fetch(CONTACT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: data.get('name'),
        email: data.get('email'),
        subject: data.get('subject'),
        message: data.get('message'),
        website: data.get('website'),
        page: location.pathname,
        resumeCode: normalizePlayCode(playSaves.getRecord()?.code) || undefined,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      fail(json.message || '送信できませんでした。時間をおいてもう一度お試しください。');
      return;
    }
  } catch {
    if (panel.open && panel.dataset?.kind === 'contact' && panelRevision === revision) fail('送信できませんでした。通信状態を確認して、もう一度お試しください。');
    else contactStatus = 'idle';
    return;
  }
  if (!panel.open || panel.dataset?.kind !== 'contact' || panelRevision !== revision) return;
  contactStatus = 'done';
  haptics.trigger('success');
  const body = panel.querySelector('.panel-body');
  if (body) {
    body.innerHTML = '<div class="survey-thanks" role="status"><p>送信しました。ありがとうございます。</p><p class="muted">内容を確認して、必要に応じてご返信します。</p></div>';
    animateSurface(body.querySelector('.survey-thanks'), true, 8);
  }
}

document.addEventListener('change', event => {
  if (event.target.name !== 'progress' || panel.dataset?.kind !== 'survey') return;
  const section = panel.querySelector('#survey-mei');
  if (!section) return;
  const enabled = event.target.value === '宵と冥';
  section.hidden = !enabled;
  if (enabled) animateSurface(section, true, 8);
  section.querySelectorAll('input').forEach(input => {
    input.disabled = !enabled;
    if (!enabled) {
      if (input.classList.contains('survey-scale-input')) resetSurveyScale(input);
      else input.checked = false;
    }
  });
  section.querySelectorAll('[data-scale-track]').forEach(track => {
    track.tabIndex = enabled ? 0 : -1;
    track.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  });
});

document.addEventListener('pointerdown', event => {
  const track = event.target.closest?.('[data-scale-track]');
  if (!track || panel.dataset?.kind !== 'survey' || track.getAttribute('aria-disabled') === 'true' || event.pointerType === 'mouse' && event.button !== 0) return;
  const input = track.parentElement?.querySelector('.survey-scale-input');
  if (!input || input.disabled) return;
  event.preventDefault();
  track.setPointerCapture?.(event.pointerId);
  track.focus({ preventScroll: true });
  surveyScaleDrag = { id: event.pointerId, track, input };
  setSurveyScale(input, surveyScaleFromX(track, event.clientX));
});
document.addEventListener('pointermove', event => {
  if (!surveyScaleDrag || event.pointerId !== surveyScaleDrag.id) return;
  setSurveyScale(surveyScaleDrag.input, surveyScaleFromX(surveyScaleDrag.track, event.clientX));
});
document.addEventListener('pointerup', endSurveyScaleDrag);
document.addEventListener('pointercancel', endSurveyScaleDrag);
document.addEventListener('keydown', event => {
  const track = event.target.closest?.('[data-scale-track]');
  if (!track || track.getAttribute('aria-disabled') === 'true') return;
  const input = track.parentElement?.querySelector('.survey-scale-input');
  if (!input || input.disabled) return;
  const current = input.dataset.set === 'true' ? Number(input.value) : null;
  let next = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current == null ? 3 : Math.min(5, current + 1);
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current == null ? 3 : Math.max(1, current - 1);
  else if (event.key === 'Home') next = 1;
  else if (event.key === 'End') next = 5;
  else return;
  event.preventDefault();
  setSurveyScale(input, next);
});

document.addEventListener('submit', event => {
  if (event.target.id === 'resume-form') {
    event.preventDefault();
    if (gateBusy) return;
    gateCode = gateDigits.join('');
    void beginPlay('code', gateCode);
  } else if (event.target.id === 'survey-form') {
    event.preventDefault();
    void submitSurvey(event.target);
  } else if (event.target.id === 'contact-form') {
    event.preventDefault();
    void submitContact(event.target);
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
    applyCombineResult(new FormData(event.target).getAll('card'));
  }
});
panel.addEventListener('click', event => { const rect = panel.getBoundingClientRect(); if (event.target === panel && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) { haptics.trigger('dismiss'); closePanel(); } });
panel.addEventListener('cancel', event => { event.preventDefault(); haptics.trigger('dismiss'); closePanel(); });
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
      void transitionToEntry();
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

// 未読込の画像だけ短く隠す。キャッシュ済みは挿入時点で complete なので、その場で出す。
// load/error はバブルしないがキャプチャで拾えるので、後から挿入される画像にも効く。
(function watchImages() {
  const settle = img => {
    if (img?.tagName !== 'IMG' || img.classList.contains('is-loaded')) return;
    if (img.complete) img.classList.add('is-loaded');
    else img.classList.add('is-pending');
  };
  const scan = node => {
    if (node?.nodeType !== 1) return;
    if (node.tagName === 'IMG') settle(node);
    node.querySelectorAll?.('img').forEach(settle);
  };
  const mark = event => { if (event.target?.tagName === 'IMG') event.target.classList.add('is-loaded'); };
  document.addEventListener('load', mark, true);
  document.addEventListener('error', mark, true);
  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) scan(node);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  for (const img of document.images ?? []) settle(img);
})();
