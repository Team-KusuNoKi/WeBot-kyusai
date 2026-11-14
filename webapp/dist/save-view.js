// 保存した画面を、現在のシナリオで表示できる範囲に戻す。
import { restoreProblemId } from './engine.js';

// 古い保存データの会話位置を保ちながら、廃止したカード案内を表示から除く。
export function isConversationLine(message) {
  return !['answer', 'success', 'error'].includes(message.kind)
    && !(message.problemId === 'Q3.3' && !message.speaker && message.text.startsWith('追加カード404を取得'));
}

export function restorePlayView(scenario, state, raw, sourceRevision = state.scenarioRevision ?? 0, sourceState = null) {
  const rename = id => restoreProblemId(scenario, id, sourceRevision, sourceState?.version);
  const p = scenario.problems.find(item => item.id === state.selected) ?? scenario.problems[0];
  const number = (value, max) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : 0;
  const validMessage = m => m && typeof m.text === 'string' && m.text.length <= 32768
    && typeof m.speaker === 'string' && ['dialogue', 'answer', 'error', 'success'].includes(m.kind)
    && (!m.problemId || scenario.problems.some(item => item.id === m.problemId));
  // 削除された問いの表示位置と入力欄は、新Q4の画面に引き継がない。
  if (sourceState && p.id === 'Q4' && !rename(sourceState.selected)) {
    return { ...restorePlayView(scenario, state, null),
      answerDrafts: restoreAnswerDrafts(scenario, raw?.answerDrafts, sourceRevision, sourceState.version) };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const messages = state.messages.filter(m => m.problemId === p.id && isConversationLine(m));
    return { startView: !state.solved.length && p.id === scenario.problems[0].id,
      yoiEndView: false, showVenueDirections: false, investigationView: false,
      repeatAnswer: false, composerExpanded: p.openAnswerOnEntry !== false && !state.solved.includes(p.id) && !(!state.solved.length && p.id === scenario.problems[0].id), sceneStart: state.messages.length,
      displayedMessages: messages, isPlaying: false, investigationScrollTop: 0, investigationReturnId: null,
      puzzleImageIndex: 0, chatScrollTop: 0, selectedPuzzleAnswer: '', selectedSymbols: [], answerDrafts: {} };
  }
  const investigationView = Boolean(raw.investigationView) && scenario.investigation.problemIds.includes(p.id);
  const resumeMigratedDialogue = !raw.repeatAnswer && state.solved.includes(p.id)
    && (scenario.progressMigrations ?? []).some(m => sourceRevision < m.revision && m.completeDialogue?.includes(p.id))
    && !raw.displayedMessages?.some?.(m => m?.problemId && rename(m.problemId) === p.id);
  const firstDialogue = state.messages.findIndex(m => m.problemId === p.id && m.kind === 'dialogue');
  const resumeDialogue = resumeMigratedDialogue && firstDialogue >= 0;
  let sceneStart = number(raw.sceneStart, state.messages.length);
  if (resumeDialogue) sceneStart = firstDialogue;
  else if (sourceRevision < state.scenarioRevision && Array.isArray(sourceState?.messages)) {
    const oldStart = number(raw.sceneStart, sourceState.messages.length);
    sceneStart = sourceState.messages.slice(0, oldStart).filter(m => !m.problemId || rename(m.problemId)).length;
  }
  const scene = state.messages.slice(sceneStart).filter(m => m.problemId === p.id && isConversationLine(m));
  let displayedMessages = [];
  if (resumeDialogue) displayedMessages = [];
  else if (Number.isInteger(raw.displayedCount) && raw.displayedCount >= 0) {
    // 新形式: 表示件数だけを保存し、本文は state.messages から復元する。
    displayedMessages = scene.slice(0, Math.min(raw.displayedCount, scene.length, 2000));
  } else if (Array.isArray(raw.displayedMessages)) {
    displayedMessages = raw.displayedMessages.filter(m => !m?.problemId || rename(m.problemId)).map(m => m && m.problemId ? { ...m, problemId: rename(m.problemId) } : m).filter(validMessage).filter(isConversationLine).filter(m => p.conversationBackground !== 'empty' || m.problemId === p.id).filter(m => !m.problemId || scenario.problems.find(item => item.id === m.problemId)?.chapter === p.chapter).slice(0, 2000);
  }
  const answerDrafts = restoreAnswerDrafts(scenario, raw.answerDrafts, sourceRevision, sourceState?.version);
  const origin = raw.answerOrigin;
  const problemId = origin && rename(origin.problemId);
  const answerId = origin && rename(origin.answerId);
  const validId = id => scenario.problems.some(item => item.id === id);
  const answerOrigin = validId(problemId) && validId(answerId) && !raw.isPlaying && !resumeDialogue && !investigationView
    && (raw.composerExpanded ? answerId : problemId) === p.id
    ? { problemId, answerId, repeatAnswer: Boolean(origin.repeatAnswer) && state.solved.includes(problemId),
        scrollTop: number(origin.scrollTop, 1000000), scrollLeft: number(origin.scrollLeft, 1000000) } : null;
  return {
    answerDrafts, ...(answerOrigin ? { answerOrigin } : {}),
    startView: Boolean(raw.startView) && p.id === scenario.problems[0].id,
    showVenueDirections: raw.showVenueDirections === true,
    yoiEndView: Boolean(raw.yoiEndView) && p.completionScreen === 'yoi' && state.solved.includes(p.id),
    ...(Array.isArray(raw.seenConclusions) ? {
      seenConclusions: scenario.investigation.entries.filter(id => raw.seenConclusions.includes(id) && state.solved.includes(id)),
    } : {}),
    investigationClosing: raw.investigationClosing === true && !investigationView && !raw.isPlaying && !raw.composerExpanded && !raw.repeatAnswer
      && scenario.investigation.problemIds.includes(p.id) && !p.continueTo && state.solved.includes(p.id)
      && displayedMessages.at(-1)?.problemId === p.id,
    investigationView, repeatAnswer: Boolean(raw.repeatAnswer) && state.solved.includes(p.id),
    composerExpanded: Boolean(raw.composerExpanded) && !investigationView && !resumeDialogue,
    sceneStart, displayedMessages, isPlaying: (resumeDialogue || Boolean(raw.isPlaying)) && scene.length > 0 && !investigationView,
    investigationScrollTop: number(raw.investigationScrollTop, 1000000),
    investigationReturnId: scenario.investigation.problemIds.includes(raw.investigationReturnId) ? raw.investigationReturnId : null,
    puzzleImageIndex: number(raw.puzzleImageIndex, Math.max(0, (p.images?.length ?? 1) - 1)),
    chatScrollTop: number(raw.chatScrollTop, 1000000),
    selectedPuzzleAnswer: p.id === 'N1' && answerDrafts.N1 ? answerDrafts.N1[0] : p.options?.some(item => item.id === raw.selectedPuzzleAnswer) ? raw.selectedPuzzleAnswer : '',
    selectedSymbols: Array.from({ length: p.answerSlots ?? 0 }, (_, i) => p.symbolChoices?.includes(answerDrafts[p.id]?.[i] ?? raw.selectedSymbols?.[i]) ? (answerDrafts[p.id]?.[i] ?? raw.selectedSymbols[i]) : ''),
  };
}

export function pendingConversation(state, view) {
  if (!view.isPlaying) return [];
  const scene = state.messages.slice(view.sceneStart).filter(m => m.problemId === state.selected && isConversationLine(m));
  // 表示済みの件数を超えて、次の会話へ飛ばさない。
  let shown = 0;
  if (Number.isInteger(view.displayedCount) && view.displayedCount >= 0 && !view.displayedMessages?.length) {
    shown = Math.min(view.displayedCount, scene.length);
  } else {
    const displayed = view.displayedMessages ?? [];
    while (shown < displayed.length && shown < scene.length
      && scene[shown].text === displayed[shown].text && scene[shown].speaker === displayed[shown].speaker) shown++;
  }
  return scene.slice(shown);
}

// Keep unfinished answers separate from solved progress and validate against current controls.
export function sanitizeAnswerDraft(problem, raw) {
  if (!Array.isArray(raw)) return [];
  const text = value => typeof value === 'string' ? value.slice(0, 256) : '';
  const choice = (value, options) => options?.some(option => (typeof option === 'string' ? option : option.id) === value) ? value : '';
  if (problem.answerSlots) return Array.from({ length: problem.answerSlots }, (_, index) => choice(raw[index], problem.symbolChoices));
  if (problem.type === 'fields') return problem.fields.map((field, index) => {
    const value = raw[index];
    if (field.kanaChoices) return [...text(value)].filter(kana => kana === ' ' || field.kanaChoices.includes(kana)).slice(0, field.length).join('').trimEnd();
    if (field.answerChoices || field.options) return choice(value, field.answerChoices ?? field.options);
    // 手がかり番号の欄には数字だけを戻す（全角数字はそのまま残す）。
    return field.inputMode === 'numeric' ? text(value).replace(/[^\d０-９]/g, '') : text(value);
  });
  if (problem.type === 'multiple') return [...new Set(raw.slice(0, problem.options.length).map(value => choice(value, problem.options)).filter(Boolean))];
  if (problem.answerChoices || problem.answerControl === 'select' || problem.type === 'single') return [choice(raw[0], problem.answerChoices ?? problem.options)];
  return problem.type === 'text' ? [text(raw[0])] : [];
}

export function restoreAnswerDrafts(scenario, raw, sourceRevision = scenario.progressRevision, sourceVersion = 2) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const drafts = {};
  for (const [oldId, values] of Object.entries(raw).slice(0, 100)) {
    const id = restoreProblemId(scenario, oldId, sourceRevision, sourceVersion);
    const problem = scenario.problems.find(item => item.id === id);
    if (!problem) continue;
    const draft = sanitizeAnswerDraft(problem, values);
    if (draft.some(Boolean)) drafts[id] = draft;
  }
  return drafts;
}
