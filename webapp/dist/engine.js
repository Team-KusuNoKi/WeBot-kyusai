import { verifyPuzzleSolution } from './hex-cube-model.js';
export { readMinigameEntry } from './hex-cube-model.js';
export function normalizeAnswer(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('ja-JP');
}

export function checkAnswer(problem, answer) {
  if (problem.type === 'pending') return false;
  if (problem.type === 'fields') {
    if (!Array.isArray(answer) || answer.length !== problem.fields.length
      || answer.some(value => typeof value !== 'string')) return false;
    // 組み合わせ単位の正解がある場合は、欄ごとの候補の直積ではなく組だけを認める。
    if (Array.isArray(problem.answerCombos)) {
      return problem.answerCombos.some(combo => Array.isArray(combo) && combo.length === answer.length
        && combo.every((item, index) => normalizeAnswer(item) === normalizeAnswer(answer[index])));
    }
    return problem.fields.every((field, index) => field.answers.some(item => normalizeAnswer(item) === normalizeAnswer(answer[index])));
  }
  if (problem.type === 'text') return problem.answers.some(item => normalizeAnswer(item) === normalizeAnswer(answer));
  if (!Array.isArray(answer)) return false;
  const selected = new Set(answer);
  return selected.size === answer.length && selected.size === problem.answers.length && problem.answers.every(item => selected.has(item));
}

export function canOpenProblem(problem, state) {
  return (problem.requiresSolved ?? []).every(id => state.solved.includes(id));
}

export function investigationComplete(scenario, state) {
  return scenario.investigation.problemIds.every(id => state.solved.includes(id));
}

export function availableNavigationProblems(scenario, state) {
  const investigation = scenario.investigation;
  const entries = scenario.problems.filter(p => !investigation.problemIds.includes(p.id) || p.id === investigation.id);
  const next = entries.find(p => p.id === investigation.id ? !investigationComplete(scenario, state) : !state.solved.includes(p.id));
  const selected = investigation.problemIds.includes(state.selected) ? investigation.id : state.selected;
  return entries.filter(p => state.solved.includes(p.id) || p.id === next?.id || p.id === selected
    || p.id === investigation.id && investigation.problemIds.some(id => state.solved.includes(id)));
}

export function findCombination(scenario, ids) {
  if (ids.length !== 2 || ids[0] === ids[1]) return null;
  return scenario.combinations.find(item => item.cards.length === ids.length && item.cards.every(id => ids.includes(id))) ?? null;
}

export function initialState(scenario) {
  return { version: 2, scenarioRevision: scenario.progressRevision ?? 0, selected: scenario.problems[0].id, solved: [], branches: {}, hints: {}, combinations: [], minigames: [], hexCubeFailures: 0, messages: scenario.opening.map(line => ({ ...line, kind: 'dialogue' })) };
}

export function restoreProblemId(scenario, id, revision = 0, version = 2, { selection = false } = {}) {
  if (version === 1) id = scenario.legacyProblemIds?.[id] ?? id;
  for (const migration of scenario.progressMigrations ?? []) {
    if (revision >= migration.revision) continue;
    if (migration.retired.includes(id)) return selection ? migration.resumeAt ?? null : null;
    id = migration.renames[id] ?? id;
  }
  return id;
}

export function restoreState(scenario, raw) {
  try {
    const saved = JSON.parse(raw);
    if (![1, 2].includes(saved.version) || !Array.isArray(saved.messages)) return initialState(scenario);
    // 番号変更前の記録を一度だけ新番号へ移し、正解・会話を同じ問題に保つ。
    const revision = saved.scenarioRevision ?? 0;
    const rename = id => restoreProblemId(scenario, id, revision, saved.version);
    saved.selected = restoreProblemId(scenario, saved.selected, revision, saved.version, { selection: true });
    saved.solved = (saved.solved ?? []).map(rename).filter(Boolean);
    for (const key of ['branches', 'hints']) saved[key] = Object.fromEntries(Object.entries(saved[key] ?? {}).map(([id, value]) => [rename(id), value]).filter(([id]) => id));
    saved.messages = saved.messages.filter(message => !message.problemId || rename(message.problemId)).map(message => ({ ...message, ...(message.problemId ? { problemId: rename(message.problemId) } : {}) }));
    const validIds = new Set(scenario.problems.map(p => p.id));
    const solved = [...new Set((saved.solved ?? []).filter(id => validIds.has(id)))];
    const branches = {};
    const hints = {};
    for (const p of scenario.problems) {
      if (solved.includes(p.id) && p.branches?.some(b => b.id === saved.branches?.[p.id])) branches[p.id] = saved.branches[p.id];
    }
    for (const p of [...scenario.problems, ...(scenario.minigames ?? [])]) {
      const count = saved.hints?.[p.id];
      if (p.hints && Number.isInteger(count) && count >= 0) hints[p.id] = Math.min(count, p.hints.length);
    }
    const messages = saved.messages.filter(m => typeof m.text === 'string' && typeof m.speaker === 'string' && ['dialogue', 'answer', 'error', 'success'].includes(m.kind) && (!m.problemId || validIds.has(m.problemId)));
    // 統合前の小問で止まった記録にも、統合先の正解後の会話を補う。
    for (const migration of scenario.progressMigrations ?? []) {
      if ((saved.scenarioRevision ?? 0) >= migration.revision) continue;
      for (const id of migration.completeDialogue ?? []) {
        const problem = scenario.problems.find(p => p.id === id);
        if (solved.includes(id) && !messages.some(m => m.problemId === id && m.kind === 'dialogue')) {
          messages.push(...(problem?.dialogue ?? []).map(line => ({ ...line, kind: 'dialogue', problemId: id })));
        }
      }
    }
    const hexCubeFailures = Number.isSafeInteger(saved.hexCubeFailures) && saved.hexCubeFailures > 0 ? saved.hexCubeFailures : 0;
    return { version: 2, hexCubeFailures, scenarioRevision: scenario.progressRevision ?? 0, selected: validIds.has(saved.selected) ? saved.selected : scenario.problems[0].id, solved, branches, hints, minigames: [...new Set((Array.isArray(saved.minigames)?saved.minigames:[]).filter(id=>(scenario.minigames??[]).some(game=>game.id===id)))], combinations: (saved.combinations ?? []).filter(id => scenario.combinations.some(c => c.id === id)), messages: messages.length ? messages : initialState(scenario).messages };
  } catch { return initialState(scenario); }
}

export function submitAnswer(scenario, state, answer) {
  const problem = scenario.problems.find(p => p.id === state.selected);
  if (!problem || !canOpenProblem(problem, state)) return { state, status: 'locked' };
  if (problem.type === 'pending') return { state, status: 'unavailable' };
  if (state.solved.includes(problem.id)) return { state, status: 'already-solved' };
  if (problem.type === 'fields' && (!Array.isArray(answer) || answer.length !== problem.fields.length || answer.some(value => typeof value !== 'string' || !normalizeAnswer(value)))) return { state, status: 'empty' };
  if (problem.answerSlots && (typeof answer !== 'string' || Array.from(normalizeAnswer(answer)).length !== problem.answerSlots)) return { state, status: 'empty' };
  const labels = problem.type === 'fields'
    ? problem.answerParts ? problem.answerParts.map((part, index) => part + (answer[index]?.trim() ?? '')).join('') : answer.map(value => value.trim()).join(' & ')
    : Array.isArray(answer) ? answer.map(id => problem.options.find(o => o.id === id)?.label).filter(Boolean).join('、') : String(answer ?? '').trim();
  if (!labels) return { state, status: 'empty' };
  const correct = checkAnswer(problem, answer);
  if (!correct) {
    const response = Array.isArray(answer) && answer.length === 1 && problem.options?.some(option => option.id === answer[0])
      ? problem.optionResponses?.[answer[0]] : null;
    if (!response) return { state, status: 'incorrect' };
    return {
      state: { ...state, messages: [...state.messages,
        { speaker: 'あなた', text: labels, kind: 'answer', problemId: problem.id },
        ...response.map(line => ({ ...line, kind: 'dialogue', problemId: problem.id })),
      ] },
      status: 'incorrect', response: true,
    };
  }
  if (correct && problem.advanceTo) {
    return { state: { ...state, selected: problem.advanceTo, solved: [...state.solved, problem.id] }, status: 'correct' };
  }
  const messages = [...state.messages, { speaker: 'あなた', text: labels, kind: 'answer', problemId: problem.id }];
  if (correct) {
    messages.push({ speaker: 'システム', text: `問${problem.id} 正解`, kind: 'success', problemId: problem.id });
    messages.push(...problem.dialogue.map(line => ({ ...line, kind: 'dialogue', problemId: problem.id })));
  }
  return { state: { ...state, messages, solved: correct ? [...state.solved, problem.id] : state.solved }, status: correct ? 'correct' : 'incorrect' };
}

export function chooseBranch(scenario, state, problemId, branchId) {
  const branch = scenario.problems.find(p => p.id === problemId)?.branches?.find(b => b.id === branchId);
  if (!branch || !state.solved.includes(problemId) || state.branches[problemId]) return state;
  return { ...state, branches: { ...state.branches, [problemId]: branchId }, messages: [...state.messages, { speaker: 'あなた', text: branch.label, kind: 'answer', problemId }, ...branch.dialogue.map(line => ({ ...line, kind: 'dialogue', problemId }))] };
}

export function unlockedCards(scenario, state) {
  const ids = new Set(scenario.problems.filter(p => state.solved.includes(p.id)).flatMap(p => p.unlock));
  for(const game of scenario.minigames??[])if(state.minigames?.includes(game.id))ids.add(game.rewardCard);
  return scenario.cards.filter(c => ids.has(c.id));
}

export function completeMinigame(scenario, state, id, moves) {
  const game=(scenario.minigames??[]).find(game=>game.id===id);
  if(!game)return {state,status:'unavailable'};
  if(!verifyPuzzleSolution(moves))return {state,status:'incorrect'};
  if(state.minigames?.includes(id))return {state,status:'already-solved'};
  const card=scenario.cards.find(card=>card.id===game.rewardCard);
  return {status:'correct',state:{...state,minigames:[...(state.minigames??[]),id],messages:[...state.messages,{speaker:'システム',kind:'success',minigameId:id,text:`新しい手がかり「${card.title}」を手に入れた。`}]}};
}
