import test from 'node:test';
import assert from 'node:assert/strict';
import { scenario } from '../dist/scenario.js';
import { normalizeAnswer, checkAnswer, submitAnswer, chooseBranch, restoreState, initialState, unlockedCards, findCombination, canOpenProblem, investigationComplete, availableNavigationProblems } from '../dist/engine.js';

// 会話分岐は本編N1から独立したサンプルで検証する。
const branchingScenario = {
  ...scenario,
  problems: scenario.problems.map(p => p.id === 'N1' ? {
    ...p,
    branches: [
      { id: 'how', label: '使い方を聞く', dialogue: [{ speaker: '案内人', text: '答えを送ってください。' }] },
      { id: 'continue', label: '続ける', dialogue: [] },
    ],
  } : p),
};

test('N1は①〜⑩のうち⑩だけが正解となる', () => {
  const problem = scenario.problems[0];
  assert.equal(problem.type, 'single');
  assert.deepEqual(problem.options.map(o => o.label), ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩']);
  for (const option of problem.options) assert.equal(checkAnswer(problem, [option.id]), option.label === '⑩');
  assert.equal(checkAnswer(problem, ['1', '10']), false);
  assert.equal(checkAnswer(problem, ['10', '10']), false);
  assert.equal(checkAnswer(problem, '11月'), false);
});

test('N1正解後に指定の会話と地の文を順番に追加し、保存から復元できる', () => {
  const result = submitAnswer(scenario, initialState(scenario), ['10']);
  const dialogue = result.state.messages.filter(m => m.problemId === 'N1' && m.kind === 'dialogue');
  assert.deepEqual(dialogue.map(({ speaker, text }) => [speaker, text]), [
    ['ミサメ', '「国旗の色に関する問題ですね。問題文のイラストは『仏』を表しています。『仏』はフランスを表す漢字です。フランスの国旗は赤・青・白の3色なので、答えは⑩というわけです！」'],
    ['タツ', '「凄いな、ミサメ。よくこんな一瞬で分かったな」'],
    ['ミサメ', '「ふふーん。先輩とは観察力が違いますからね♪」'],
    ['アサヒ', '「ところで、総合研究10号館ってどこでしたっけ？」'],
    ['ミサメ', '「中央食堂の1つ東の建物よ」'],
    ['', 'そう言うと、ミサメはアサヒにも分かるように、手元のメモに10号館までの道順を丁寧に書き記していった。'],
    ['アサヒ', '「凄い！めっちゃ分かりやすいです！ミサ先、あざっす！」'],
    ['ミサメ', '「ミサ先って……。意外に悪くない響きね」'],
    ['', '指示：総合研究10号館へ向かおう。以下の写真を参考にしてください。現地でN2と書かれた問題を見つけたら上部の「次へ」ボタンを押しましょう。'],
    ['', '〈ここに、総合研究10号館までの行き方を写真付きで分かりやすく解説する。解いている人が図書館前にいないかもしれないことにも留意〉'],
    ['', '〈N2が貼ってある場所の写真をここに挿入〉'],
  ]);
  assert.equal(dialogue[8].emphasis, true);
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
  assert.equal(scenario.problems[0].branches, undefined);
});

test('全角数字・英字の大文字小文字・前後の空白を揃える', () => {
  assert.equal(normalizeAnswer(' ＡＢＣ１２ '), 'abc12');
  const textProblem = { type: 'text', answers: ['11月'] };
  assert.ok(checkAnswer(textProblem, ' １１月 '));
  assert.equal(checkAnswer(textProblem, '12月'), false);
});
test('選択肢は過不足と重複を判定し、順序は問わない', () => {
  const p = { type: 'multiple', answers: ['A1', 'B1'] };
  assert.ok(checkAnswer(p, ['B1', 'A1']));
  for (const answer of [['A1'], ['A1', 'B1', 'C1'], ['A1', 'B1', 'B1'], 'A1']) assert.equal(checkAnswer(p, answer), false);
  const single = { type: 'single', answers: ['dec'] };
  assert.ok(checkAnswer(single, ['dec']));
  assert.equal(checkAnswer(single, ['nov']), false);
});
test('不正解で進行・カードを解除せず、再回答で正解できる', () => {
  const start = initialState(scenario);
  const wrong = submitAnswer(scenario, start, ['1']);
  assert.equal(wrong.status, 'incorrect');
  assert.equal(wrong.state, start);
  assert.deepEqual(wrong.state.solved, []);
  assert.deepEqual(unlockedCards(scenario, wrong.state), []);
  const right = submitAnswer(scenario, wrong.state, ['10']);
  assert.equal(right.status, 'correct');
  assert.deepEqual(right.state.solved, ['N1']);
  assert.deepEqual(unlockedCards(scenario, right.state).map(c => c.id), ['A1']);
});
test('空回答で会話を追加しない', () => {
  const state = initialState(scenario);
  assert.equal(submitAnswer(scenario, state, '  ').state, state);
  assert.equal(submitAnswer(scenario, state, []).status, 'empty');
});
test('解答済みの問題は、会話や正解記録を重複させない', () => {
  const solved = submitAnswer(scenario, initialState(scenario), ['10']).state;
  const again = submitAnswer(scenario, solved, ['10']);
  assert.equal(again.state, solved);
  assert.equal(again.status, 'already-solved');
});
test('会話分岐は正解後に一度だけ選べる', () => {
  const scenario = branchingScenario;
  const start = initialState(scenario);
  assert.equal(chooseBranch(scenario, start, 'N1', 'how'), start);
  const solved = submitAnswer(scenario, start, ['10']).state;
  assert.equal(chooseBranch(scenario, solved, 'N1', 'unknown'), solved);
  const branch = chooseBranch(scenario, solved, 'N1', 'how');
  assert.equal(branch.branches['N1'], 'how');
  assert.equal(branch.messages.length, solved.messages.length + 2);
  assert.equal(chooseBranch(scenario, branch, 'N1', 'continue'), branch);
});
test('カードの組み合わせは順序を問わず、同じカードや余計なカードは認めない', () => {
  assert.equal(findCombination(scenario, ['B1', 'A1']).id, 'months');
  for (const ids of [[], ['A1'], ['A1', 'A1'], ['A1', 'C1'], ['A1', 'B1', 'C1']]) assert.equal(findCombination(scenario, ids), null);
});
test('進行・分岐・ヒント・考察・会話を保存状態から復元する', () => {
  const scenario = branchingScenario;
  let state = submitAnswer(scenario, initialState(scenario), ['10']).state;
  state = chooseBranch(scenario, state, 'N1', 'how');
  state.hints['N1'] = 1;
  state.combinations = ['months'];
  assert.deepEqual(restoreState(scenario, JSON.stringify(state)), state);
});
test('破損した保存データや旧形式から安全に開始する', () => {
  for (const raw of [null, '', 'invalid', 'null', '{}', '{"version":0}']) assert.deepEqual(restoreState(scenario, raw), initialState(scenario));
});
test('存在しない問題や分岐を復元せず、ヒント数を上限に制限する', () => {
  const raw = { ...initialState(scenario), selected: 'missing', solved: ['N1', 'N1', 'missing'], branches: { 'N1': 'missing' }, hints: { 'N1': 100, 'N2': -1 }, combinations: ['missing'] };
  const result = restoreState(scenario, JSON.stringify(raw));
  assert.equal(result.selected, 'N1');
  assert.deepEqual(result.solved, ['N1']);
  assert.deepEqual(result.branches, {});
  assert.deepEqual(result.hints, { 'N1': scenario.problems[0].hints.length });
  assert.deepEqual(result.combinations, []);
});

test('N2は法経済学部北館の漢字入力で正解となり、指定の会話と移動指示を返す', () => {
  const problem = scenario.problems.find(p => p.id === 'N2');
  assert.equal(problem.type, 'text');
  assert.equal(checkAnswer(problem, ' 法経済学部北館 '), true);
  for (const answer of ['12月', '法経済学部', 'ほうけいざいがくぶきたかん', '法経済学部南館']) assert.equal(checkAnswer(problem, answer), false);
  const start = { ...initialState(scenario), selected: 'N2' };
  const result = submitAnswer(scenario, start, '法経済学部北館');
  assert.equal(result.status, 'correct');
  const dialogue = result.state.messages.filter(m => m.problemId === 'N2' && m.kind === 'dialogue');
  assert.deepEqual(dialogue.map(({ speaker, text }) => [speaker, text]), [
    ['タツ', '「うん、線が交差するところは、法経済学部北館だね」'],
    ['アサヒ', '「タツパイ流石っす！僕全然分かんなかったっすよ」'],
    ['ミサメ', '「ちょっと！もう解けるとこだったのに～答え言わないでください！」'],
    ['タツ', '「ミサメ、実は結構楽しんでない？」'],
    ['ミサメ', '「そ、そんなことないですよ！ほら、早く行きますよ！」'],
    ['ミサメ', '「もう！こんな問題の紙も規約違反なので回収します！」'],
    ['', 'ミサメはN2の問題用紙を壁から剥がすとクシャクシャに丸めポケットに入れた。'],
    ['', '指示：法経済学部北館へ向かおう。以下の写真を参考にしてください。現地でN3と書かれた問題を見つけたら上部の「次へ」ボタンを押しましょう。'],
    ['', '〈ここに、法経済学部北館までの行き方を写真付きで分かりやすく解説する〉'],
    ['', '〈N3が貼ってある場所の写真をここに挿入〉'],
  ]);
  assert.equal(dialogue[7].emphasis, true);
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
});

test('N3は末だけを正解とし、指定の会話・指示・写真の仮テキストを保存できる', () => {
  const problem = scenario.problems.find(p => p.id === 'N3');
  assert.equal(problem.type, 'text');
  assert.ok(checkAnswer(problem, ' 末 '));
  for (const answer of ['未', '末吉', 'すえ', '']) assert.equal(checkAnswer(problem, answer), false);
  assert.deepEqual(scenario.problems.map(p => p.id), ['N1', 'N2', 'N3', 'N4', 'N4.1', 'N5', 'N5.5', 'Q1', 'Q1.1', 'Q2', 'Q2.1', 'Q2.2', 'Q3', 'Q3.scaffold', 'Q3.2', 'Q3.3', 'Q3.3.1', 'Q3.1', 'Q4', 'Q5', 'Q6', 'Q6.1', 'Q6.2', 'Q7', 'Q8', 'Q9']);
  const result = submitAnswer(scenario, { ...initialState(scenario), selected: 'N3' }, '末');
  assert.equal(result.status, 'correct');
  const dialogue = result.state.messages.filter(m => m.problemId === 'N3' && m.kind === 'dialogue');
  assert.deepEqual(dialogue.map(({ speaker, text }) => [speaker, text]), [
    ['ミサメ', '「おみくじ！おみくじがモチーフの問題ね！だから答えは末吉の末！」'],
    ['', 'ミサメは満足げに答えると、今度も問題用紙を剥がして回収した。まったく、仕事に関しては抜かりのないやつだ。'],
    ['アサヒ', '「先輩、末席って何ですか？」'],
    ['タツ', '「アサヒ君は理科系は強いけど、国語は苦手みたいだね。末席っていうのは、何だろう、一番地位の低い人が座る席みたいな？」'],
    ['アサヒ', '「え、じゃぁこの『末席同好会』ってやつはどんな活動をしてるんですかね？全国の居酒屋の末席を調査するとかですか？」'],
    ['ミサメ', '「それはただの飲みサーね」'],
    ['ミサメ', '「それはそうと、サークルとか同好会を探すなら、吉田南の総人広場を抜けた先にある掲示板ね。あそこには色んな団体が部員募集のチラシを貼っているわ」'],
    ['タツ', '「うん、確かにそこしかないかもね。とりあえず行ってみるか」'],
    ['アサヒ', '「出発進行～！」'],
    ['', '指示：吉田南、総人広場を抜けた先にある掲示板へ行こう。以下の写真を参考にしてください。現地で末席同好会のチラシを見つけたら上部の「次へ」ボタンを押しましょう。'],
    ['', '〈ここに、吉田南、総人広場先掲示板までの行き方を写真付きで分かりやすく解説する〉'],
    ['', '〈N4が貼ってある場所の写真をここに挿入〉'],
  ]);
  assert.equal(dialogue[9].emphasis, true);
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
});

test('N4は数字・矢印の3文字を順に判定し、未選択では進行と会話を変えない', () => {
  const p = scenario.problems.find(p => p.id === 'N4');
  const state = { ...initialState(scenario), selected: 'N4' };
  assert.equal(p.answerSlots, 3);
  assert.equal(new Set(p.symbolChoices).size, 18);
  for (const value of ['', '8', '89']) {
    const result = submitAnswer(scenario, state, value);
    assert.equal(result.status, 'empty');
    assert.equal(result.state, state);
  }
  assert.equal(checkAnswer(p, '89↙'), true);
  assert.equal(checkAnswer(p, '８９↙'), true);
  for (const value of ['98↙', '89↘', '888']) assert.equal(submitAnswer(scenario, state, value).status, 'incorrect');
});

test('N4はN4.1へ進み、N4.1の正解後に会話を返して進行を復元できる', () => {
  const start = { ...initialState(scenario), selected: 'N4' };
  assert.equal(submitAnswer(scenario, start, '88').state.selected, 'N4');
  const first = submitAnswer(scenario, start, '８９↙');
  assert.equal(first.status, 'correct');
  assert.equal(first.state.selected, 'N4.1');
  assert.equal(first.state.messages, start.messages);
  assert.deepEqual(first.state.solved, ['N4']);
  const second = submitAnswer(scenario, first.state, '人間・環境学研究科棟');
  assert.equal(second.status, 'correct');
  assert.equal(second.state.selected, 'N4.1');
  assert.equal(second.state.messages.filter(m => m.problemId === 'N4.1' && m.kind === 'dialogue').length, 8);
  assert.deepEqual(second.state.solved, ['N4', 'N4.1']);
  assert.deepEqual(restoreState(scenario, JSON.stringify(second.state)), second.state);
});

test('Q1は17:20～17:40のみ正解で会話を追加せずQ1.1へ進み、Q1.1はマヤで正解する', () => {
  const q1 = scenario.problems.find(p => p.id === 'Q1');
  assert.equal(q1.type, 'single');
  assert.deepEqual(q1.options.map(o => o.label), ['16:00～16:20', '16:20～16:40', '16:40～17:00', '17:00～17:20', '17:20～17:40', '17:40～18:00']);
  for (const option of q1.options) assert.equal(checkAnswer(q1, [option.id]), option.id === '5');
  assert.equal(checkAnswer(q1, ['4', '5']), false);
  const start = { ...initialState(scenario), selected: 'Q1' };
  const result = submitAnswer(scenario, start, ['5']);
  assert.equal(result.status, 'correct');
  assert.equal(result.state.selected, 'Q1.1');
  assert.equal(result.state.messages, start.messages);
  assert.deepEqual(result.state.solved, ['Q1']);
  const restored = restoreState(scenario, JSON.stringify(result.state));
  assert.deepEqual(restored, result.state);
  for (const value of ['', 'マナ', 'まや']) assert.notEqual(submitAnswer(scenario, restored, value).status, 'correct');
  const second = submitAnswer(scenario, restored, ' マヤ ');
  assert.equal(second.status, 'correct');
  assert.deepEqual(second.state.solved, ['Q1', 'Q1.1']);
  const dialogue = second.state.messages.filter(m => m.problemId === 'Q1.1' && m.kind === 'dialogue');
  assert.deepEqual(dialogue.map(m => m.speaker), ['タツ', 'マヤ', 'マヤ', 'タツ', '']);
  assert.ok(dialogue[0].text.includes('女子高生たちの証言によると、17時半に入館した子はミサメを目撃している'));
  assert.ok(dialogue[0].text.includes('犯行時刻は、17:20～17:40だろう'));
  assert.equal(dialogue.at(-1).text, '指示：冊子の次のページをめくろう');
  assert.equal(dialogue.at(-1).emphasis, true);
});

test('Q2からQ2.2まで正解で進み、途中の会話を増やさず最後に真相の文章を保存する', () => {
  const start = { ...initialState(scenario), selected: 'Q2' };
  const wrong = submitAnswer(scenario, start, ['2']);
  assert.equal(wrong.status, 'incorrect');
  assert.equal(wrong.state, start);
  const first = submitAnswer(scenario, start, ['1']);
  assert.equal(first.status, 'correct');
  assert.equal(first.state.selected, 'Q2.1');
  assert.equal(first.state.messages, start.messages);
  for (const value of ['', '霧', '布が']) assert.notEqual(submitAnswer(scenario, first.state, value).status, 'correct');
  const second = submitAnswer(scenario, first.state, '布');
  assert.equal(second.status, 'correct');
  assert.equal(second.state.selected, 'Q2.2');
  assert.equal(second.state.messages, start.messages);
  const restored = restoreState(scenario, JSON.stringify(second.state));
  assert.deepEqual(restored, second.state);
  assert.equal(submitAnswer(scenario, restored, '氷').status, 'incorrect');
  const last = submitAnswer(scenario, restored, ' ドライアイス ');
  assert.equal(last.status, 'correct');
  assert.deepEqual(last.state.solved, ['Q2', 'Q2.1', 'Q2.2']);
  const dialogue = last.state.messages.filter(m => m.kind === 'dialogue' && m.problemId === 'Q2.2');
  assert.deepEqual(dialogue.map(m => [m.speaker, m.text]), [['アサヒ', '「ドライアイスが昇華することで、時間差で布が落ちる……。それによって鏡に光が反射するようになり、ミサメさんの姿が現れたってことですか……！」'], ['タツ', '「そうだ！　犯人はなんて巧妙なトリックを仕掛けたんだ……！」']]);
  assert.deepEqual(restoreState(scenario, JSON.stringify(last.state)), last.state);
});

test('Q3の誤答は専用の反応を保存し、正解記録を増やさず再回答できる', () => {
  const id = 'Q3';
  const problem = scenario.problems.find(p => p.id === id);
  let state = { ...initialState(scenario), selected: id };
  for (const wrongId of ['2', '3']) {
    const result = submitAnswer(scenario, state, [wrongId]);
    assert.equal(result.status, 'incorrect');
    assert.equal(result.response, true);
    assert.equal(result.state.selected, id);
    assert.deepEqual(result.state.solved, []);
    assert.deepEqual(result.state.messages.at(-1), { ...problem.optionResponses[wrongId][0], kind: 'dialogue', problemId: id });
    state = restoreState(scenario, JSON.stringify(result.state));
  }
  for (const invalid of [[], ['1', '2'], ['1', '1'], ['unknown'], '1']) {
    const result = submitAnswer(scenario, state, invalid);
    assert.equal(result.state, state);
    assert.notEqual(result.response, true);
  }
  const right = submitAnswer(scenario, state, ['1']);
  assert.equal(right.status, 'correct');
  assert.deepEqual(right.state.solved, [id]);
  assert.equal(right.state.messages.at(-1).text, problem.dialogue[0].text);
  assert.deepEqual(restoreState(scenario, JSON.stringify(right.state)), right.state);
});

test('3つの問いは全6通りの順序で解け、N6を含む全問正解で一覧が完了する', () => {
  const permutations = items => items.length ? items.flatMap((id, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [id, ...rest])) : [[]];
  const q4 = scenario.problems.find(p => p.id === 'Q4');
  const answers = { Q3: ['1'], 'Q3.2': ['2', '3'], 'Q3.3': '102', 'Q3.3.1': 'かべおせ' };
  for (const order of permutations(scenario.investigation.entries)) {
    let state = initialState(scenario);
    assert.equal(submitAnswer(scenario, { ...state, selected: 'Q3.3.1' }, 'かべおせ').status, 'locked');
    assert.equal(submitAnswer(scenario, { ...state, selected: 'Q3.scaffold' }, '脚立').status, 'locked');
    for (const id of order) {
      assert.equal(investigationComplete(scenario, state), false);
      assert.equal(canOpenProblem(q4, state), true);
      const result = submitAnswer(scenario, { ...state, selected: id }, answers[id]);
      assert.equal(result.status, 'correct');
      state = restoreState(scenario, JSON.stringify(result.state));
      if (id === 'Q3') {
        assert.equal(investigationComplete(scenario, state), false);
        state = submitAnswer(scenario, { ...state, selected: 'Q3.scaffold' }, '脚立').state;
      }
      if (id === 'Q3.3') {
        assert.equal(investigationComplete(scenario, state), false);
        assert.equal(unlockedCards(scenario, state).some(c => c.id === '404'), true);
        state = submitAnswer(scenario, { ...state, selected: 'Q3.3.1' }, answers['Q3.3.1']).state;
      }
    }
    assert.equal(investigationComplete(scenario, state), true);
    assert.equal(canOpenProblem(q4, state), true);
    assert.equal(submitAnswer(scenario, { ...state, selected: 'Q4' }, ['マヤ', '002']).status, 'correct');
  }
});

test('N4.1は建物名で正解し、旧N4.2の会話と指示を返す', () => {
  const problem = scenario.problems.find(p => p.id === 'N4.1');
  assert.equal(scenario.problems.some(p => p.id === 'N4.2'), false);
  assert.equal(checkAnswer(problem, '人間・環境学研究科棟'), true);
  const result = submitAnswer(scenario, { ...initialState(scenario), selected: 'N4.1' }, '人間・環境学研究科棟');
  assert.equal(result.status, 'correct');
  const dialogue = result.state.messages.filter(m => m.kind === 'dialogue' && m.problemId === 'N4.1');
  assert.deepEqual(dialogue.map(({ speaker, text }) => [speaker, text]), [
    ['タツ', '「正解は89の↙だね。散々見てきた標識を参考にすると、89は人間・環境学研究科棟に割り振られた数字だ。 そして、 ↙ は南西の角を意味すると考えるのが自然かな」'],
    ['アサヒ', '「つまり、『人間・環境学研究科棟の南西の角』ってことですね」'],
    ['ミサメ', '「今回はいっぱい歩きましたね。疲れました～」'],
    ['タツ', '「そこのミサメ君、文句を言わない！さっさと歩く」'],
    ['ミサメ', '「ど、どういうキャラですか？」'],
    ['', '指示：人間・環境学研究科棟、南西の角へ向かおう。以下の写真を参考にしてください。現地でN5と書かれた問題を見つけたら上部の「次へ」ボタンを押しましょう。'],
    ['', '〈ここに、人間・環境学研究科棟、南西の角までの行き方を写真付きで分かりやすく解説する〉'],
    ['', '〈N5が貼ってある場所の写真をここに挿入〉'],
  ]);
  assert.equal(dialogue[5].emphasis, true);
});

test('N5はお化け屋敷で正解となり、心の声と周遊終了の案内を含む会話を返す', () => {
  const problem = scenario.problems.find(p => p.id === 'N5');
  assert.equal(problem.type, 'text');
  assert.ok(checkAnswer(problem, 'お化け屋敷'));
  assert.equal(checkAnswer(problem, '屋台'), false);
  const result = submitAnswer(scenario, { ...initialState(scenario), selected: 'N5' }, 'お化け屋敷');
  assert.equal(result.status, 'correct');
  const dialogue = result.state.messages.filter(m => m.kind === 'dialogue' && m.problemId === 'N5');
  assert.deepEqual(dialogue.map(({ speaker, text }) => [speaker, text]), [
    ['アサヒ', '「そういえば、この問題文、ついに『最期の場所』になりましたね。今までは『次の場所』だったのに」'],
    ['タツ', '「最後はお化け屋敷か。確か、水泳部が毎年運営してるんだよな。……それにしても、なんで最後がそこなんだろう？」'],
    ['ミサメ', '「さっぱりですね。でも、最後の場所ということは、主催者はそこにいるんじゃないですか？さっさと注意して、巡回に戻りましょう」'],
    ['アサヒ', '「ミサ先～！いっぱい歩いたらお腹が空いちゃいました！お化け屋敷に行く前に、ちょっと食事休憩とか……」'],
    ['ミサメ', '「ダメ！仕事中でしょ！私だってお腹が空いてるのを我慢してるんだから！」'],
    ['タツ', '（……そういえば、この子、さっきお腹鳴らしてたな…）'],
    ['', '伝達：以上で、構内での周遊、滞在が必須な部分は終了となります。実際にお化け屋敷に向かう必要はありません。これ以降は、(後半の「冥」も含めて) お好きな場所で遊ぶことができます。カフェやベンチ、ご自宅など落ち着ける場所でお楽しみください。'],
    ['', '指示：冊子の次のページをめくろう'],
  ]);
  assert.equal(dialogue[7].emphasis, true);
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
});

test('N5.5は語群の2語が両方正しい場合だけ会話へ進む', () => {
  const problem = scenario.problems.find(p => p.id === 'N5.5');
  assert.equal(problem.type, 'fields');
  assert.equal(problem.image, undefined);
  const state = { ...initialState(scenario), selected: 'N5.5' };
  for (const first of problem.wordBank) {
    for (const second of problem.wordBank) {
      const result = submitAnswer(scenario, state, [first, second]);
      const correct = first === '謎解き' && second === '1人';
      assert.equal(result.status, correct ? 'correct' : 'incorrect');
      if (!correct) assert.equal(result.state, state);
    }
  }
  for (const answer of [[], ['謎解き'], ['謎解き', ''], ['', '1人'], '1人', ['謎解き', '1人', '余分']]) {
    const result = submitAnswer(scenario, state, answer);
    assert.equal(result.status, 'empty');
    assert.equal(result.state, state);
  }
  assert.equal(checkAnswer(problem, ['謎解き', '１人']), true);
  const result = submitAnswer(scenario, state, ['謎解き', '1人']);
  assert.equal(result.status, 'correct');
  assert.deepEqual(result.state.solved, ['N5.5']);
  const dialogue = result.state.messages.filter(m => m.kind === 'dialogue' && m.problemId === 'N5.5');
  assert.deepEqual(dialogue.map(({ speaker, text }) => [speaker, text]), [
    ['タツ', '「こ、これって、まさかこんなことがあるか、、、」'],
    ['アサヒ', '「失踪者が2人とも僕らがさっきまでやっていた謎解きをしていたということですか？」'],
    ['タツ', '「それしか考えられない。3つの円が書かれた紙は最初に子供から貰ったやつだ。そして、彼らが看板や石碑を凝視したり、人気のないところに行っていたのは、僕らと同じように謎解きをしていたからだ」'],
    ['アサヒ', '「つまり、1人でこの非公式の謎解きをやっていた人が行方不明に…」'],
    ['タツ', '「1人で…？」'],
    ['', 'その瞬間、タツの頭にハンマーで殴られたような衝撃が走った。これまでの情報が1本の線でつながり、恐ろしい仮説が浮かび上がる。全身に悪寒が走った。そんなはずはない。どうか、間違いであってくれ。'],
    ['タツ', '「ミサメだっ！！！！ミサメが危ない！！！！！！！」'],
    ['', '指示：冊子の次のページをめくろう'],
  ]);
  assert.equal(dialogue[7].emphasis, true);
});


test('廃止した小問の保存記録は復元せず、N5までの進行を保つ', () => {
  const n5 = submitAnswer(scenario, { ...initialState(scenario), selected: 'N5' }, 'お化け屋敷').state;
  const saved = {
    ...n5, scenarioRevision: undefined, selected: 'N5.5.1', solved: ['N5', 'N5.5', 'N5.5.1'],
    messages: [...n5.messages, { speaker: 'タツ', text: '旧小問の会話', kind: 'dialogue', problemId: 'N5.5.1' }],
  };
  const restored = restoreState(scenario, JSON.stringify(saved));
  assert.deepEqual(restored.solved, ['N5']);
  assert.equal(restored.selected, 'N1');
  assert.deepEqual(restored.messages, n5.messages);
  assert.equal(restored.solved.includes('N5.5'), false);
});

test('Q4は人物と3桁のカード番号で回答し、会話と正解を保存する', () => {
  const state = { ...initialState(scenario), selected: 'Q4' };
  for (const answer of [[], ['マヤ'], ['マヤ', ''], ['マヤ', 2]]) {
    assert.equal(submitAnswer(scenario, state, answer).status, 'empty');
  }
  for (const answer of [['マヤ', '2'], ['マヤ', '102'], ['サダヲ', '002'], ['002', 'マヤ']]) {
    assert.equal(submitAnswer(scenario, state, answer).status, 'incorrect');
  }
  const result = submitAnswer(scenario, state, ['マヤ', '００２']);
  assert.equal(result.status, 'correct');
  assert.deepEqual(result.state.solved, ['Q4']);
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
  assert.equal(result.state.messages.at(-1).text, '指示：冊子の次のページをめくろう');
  assert.equal(submitAnswer(scenario, result.state, ['マヤ', '002']).status, 'already-solved');
});

test('Q6は凶器・証拠・犯人とカード番号を順番に判定し、既存のQ5記録から続けられる', () => {
  const q6 = scenario.problems.find(p => p.id === 'Q6');
  let state = { ...initialState(scenario), selected: 'Q5', solved: scenario.problems.slice(0, scenario.problems.indexOf(q6)).map(p => p.id) };
  state = restoreState(scenario, JSON.stringify(state));
  const cases = [
    ['Q6', ' ドライアイス ', ['氷', 'ハンマー', '']],
    ['Q6.1', '軍手', ['手袋', '血まみれの軍手', '']],
    ['Q6.2', [' ハナ ', '００３'], [['マヤ', '003'], ['ハナ', '002'], ['ハナ', '3'], ['003', 'ハナ'], ['ハナ', ''], ['ハナ'], 'ハナ&003']],
  ];
  for (const [id, answer, wrongAnswers] of cases) {
    const problem = scenario.problems.find(p => p.id === id);
    assert.equal(submitAnswer(scenario, { ...initialState(scenario), selected: id }, answer).status, 'correct');
    state = { ...state, selected: id };
    for (const wrong of wrongAnswers) {
      const result = submitAnswer(scenario, state, wrong);
      assert.notEqual(result.status, 'correct');
      assert.equal(result.state, state);
    }
    const result = submitAnswer(scenario, state, answer);
    assert.equal(result.status, 'correct');
    assert.equal(result.state.selected, id);
    assert.deepEqual(result.state.messages.filter(m => m.problemId === id && m.kind === 'dialogue').map(({ kind, problemId, ...line }) => line), problem.dialogue);
    state = restoreState(scenario, JSON.stringify(result.state));
    assert.deepEqual(state, result.state);
    assert.equal(submitAnswer(scenario, state, answer).status, 'already-solved');
  }
  assert.equal(state.messages.at(-1).text, '冊子の次のページをめくろう');
  assert.equal(state.messages.at(-1).emphasis, true);
});

test('Q5は16:30とカード番号203が揃った場合だけ正解し、会話と指示を保存する', () => {
  const problem = scenario.problems.find(p => p.id === 'Q5');
  const card = '203';
  const start = { ...initialState(scenario), selected: 'Q5', solved: scenario.problems.slice(0, scenario.problems.indexOf(problem)).map(p => p.id) };
  assert.deepEqual(problem.fields[0].answerChoices.map(o => o.label), ['16:00', '16:30', '17:00', '17:30']);
  for (const option of problem.fields[0].answerChoices) assert.equal(checkAnswer(problem, [option.id, card]), option.id === '16:30');
  for (const value of [['16:30', '002'], ['16:30', '幽煙の間：スタッフの証言'], ['16:30', '深紅の間：スタッフの証言'], [card, '16:30'], ['16:30', card, 'extra']]) {
    assert.equal(checkAnswer(problem, value), false);
  }
  for (const value of [[], ['16:30'], ['16:30', ''], ['', card]]) assert.equal(submitAnswer(scenario, start, value).status, 'empty');
  assert.equal(submitAnswer(scenario, { ...initialState(scenario), selected: 'Q5' }, ['16:30', card]).status, 'correct');
  const wrong = submitAnswer(scenario, start, ['17:00', card]);
  assert.equal(wrong.status, 'incorrect');
  assert.equal(wrong.state, start);
  const result = submitAnswer(scenario, wrong.state, ['１６：３０', ' ２０３ ']);
  assert.equal(result.status, 'correct');
  assert.deepEqual(result.state.solved, [...start.solved, 'Q5']);
  const dialogue = result.state.messages.filter(m => m.kind === 'dialogue' && m.problemId === 'Q5');
  assert.equal(dialogue[0].speaker, 'アサヒ');
  assert.ok(dialogue[0].text.includes('16時40分頃に鈴の音を聞き'));
  assert.ok(dialogue[0].text.includes('16時30分頃に入場し'));
  assert.ok(dialogue[0].text.endsWith('元の順路へ戻ってしまうはずですから」'));
  assert.equal(dialogue[1].text, '指示：冊子の次のページをめくろう');
  assert.equal(dialogue[1].emphasis, true);
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
  assert.equal(submitAnswer(scenario, result.state, ['16:30', card]).status, 'already-solved');
});

test('Q7はA+203とD+302の両組が揃って初めて正解し、前問の記録と推理・会場案内を保存する', () => {
  const problem = scenario.problems.find(p => p.id === 'Q7');
  assert.equal(problem.prompt, '矛盾があるブロックを全て指摘せよ');
  assert.deepEqual(problem.answerCombos, [['A', '203'], ['D', '302']]);
  const start = restoreState(scenario, JSON.stringify({ ...initialState(scenario), selected: 'Q6.2', solved: scenario.problems.slice(0, scenario.problems.indexOf(problem)).map(p => p.id) }));
  const state = { ...start, selected: 'Q7' };
  assert.equal(submitAnswer(scenario, { ...initialState(scenario), selected: 'Q7' }, ['D', '302']).status, 'progress');
  assert.equal(submitAnswer(scenario, { ...initialState(scenario), selected: 'Q7' }, ['A', '203']).status, 'progress');
  for (const answer of [['C', '302'], ['D', '003'], ['A', '302'], ['D', '203'], ['302', 'D'], ['D', '302', '余分'], ['D', ''], ['', '302'], ['D'], 'D&302']) {
    const result = submitAnswer(scenario, state, answer);
    assert.notEqual(result.status, 'correct');
    assert.notEqual(result.status, 'progress');
    assert.equal(result.state, state);
  }
  for (const answer of [['D', '302'], [' d ', '３０２'], ['Ｄ', '302'], ['A', '203'], [' ａ ', '２０３'], ['Ａ', '203']]) {
    assert.equal(checkAnswer(problem, answer), true);
  }
  const first = submitAnswer(scenario, state, ['Ｄ', '３０２']);
  assert.equal(first.status, 'progress');
  assert.deepEqual(first.state.solved, start.solved);
  assert.deepEqual(first.state.answerCombos.Q7, [1]);
  assert.equal(first.state.messages.filter(m => m.problemId === 'Q7' && m.kind === 'dialogue').length, 0);
  assert.equal(submitAnswer(scenario, first.state, ['D', '302']).status, 'incorrect');
  const result = submitAnswer(scenario, first.state, ['Ａ', '２０３']);
  assert.equal(result.status, 'correct');
  assert.deepEqual(result.state.solved, [...start.solved, 'Q7']);
  assert.deepEqual(result.state.answerCombos.Q7, [0, 1]);
  const dialogue = result.state.messages.filter(m => m.problemId === 'Q7' && m.kind === 'dialogue');
  assert.equal(dialogue[0].speaker, 'タツ');
  assert.ok(dialogue[0].text.startsWith('「ずっと違和感があったんだ。'));
  assert.ok(dialogue[0].text.endsWith('お前しかいない！！」'));
  assert.equal(dialogue[1].text, '冊子の次のページをめくろう');
  assert.equal(dialogue[1].emphasis, true);
  assert.ok(dialogue[2].text.includes('この先は会場を離れても進められます'));
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
  assert.equal(submitAnswer(scenario, result.state, ['D', '302']).status, 'already-solved');
});

test('Q6でトンカチと答えると専用の誤答会話を保存し、正解記録を増やさず再回答できる', () => {
  const problem = scenario.problems.find(p => p.id === 'Q6');
  const state = { ...initialState(scenario), selected: 'Q6' };
  const result = submitAnswer(scenario, state, 'トンカチ');
  assert.equal(result.status, 'incorrect');
  assert.equal(result.response, true);
  assert.deepEqual(result.state.solved, []);
  assert.deepEqual(
    result.state.messages.filter(m => m.problemId === 'Q6').map(m => [m.kind, m.speaker, m.text]),
    [
      ['answer', 'あなた', 'トンカチ'],
      ...problem.answerResponses['トンカチ'].map(line => ['dialogue', line.speaker, line.text]),
    ],
  );
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
  assert.equal(submitAnswer(scenario, result.state, 'ドライアイス').status, 'correct');
});

test('Q8は4空欄が揃った場合だけ正解し、完成文と解答記録を保存する', () => {
  const problem = scenario.problems.find(p => p.id === 'Q8');
  const correct = ['ハナ', '知恵', '畏怖', '大地震'];
  const start = { ...initialState(scenario), selected: 'Q8' };
  for (let index = 0; index < correct.length; index++) {
    const empty = correct.map((word, i) => i === index ? '' : word);
    assert.equal(submitAnswer(scenario, start, empty).status, 'empty');
    const wrong = submitAnswer(scenario, start, correct.map((word, i) => i === index ? '誤答' : word));
    assert.equal(wrong.status, 'incorrect');
    assert.equal(wrong.state, start);
  }
  for (const value of [correct.slice(0, 3), [...correct, '余分'], [...correct].reverse(), ['ハナ', '知恵深き者', '畏怖を集める', '大地震']]) assert.equal(checkAnswer(problem, value), false);
  const result = submitAnswer(scenario, start, correct.map(word => ` ${word} `));
  assert.equal(result.status, 'correct');
  assert.deepEqual(result.state.solved, ['Q8']);
  const completed = '一昨年、去年と続けて起きたNF連続失踪事件は、すべてハナによるものだった。1人で謎解きをしていた人物が標的となったのは、問題を通じて人目の少ない場所へ自然に誘導し、拉致を容易にするためだ。そして何より儀式に「知恵深き者」が必要だった。謎解きを進められる者こそ、その条件を満たしていたのだ。今年、ミサメがお化け屋敷へ誘導され、撲殺された後に吊るされたのも、入場者にその姿を見せつけ、儀式に必要な「畏怖を集める」という段階を満たすためだった。ハナがそこまでして儀式を行おうとした理由は、京都を襲うと予言された大地震を防ぐため。かつて神を人の身に降ろし、厄災を回避したという儀式を再現する術を求めていたのだ。';
  assert.equal(result.state.messages.find(m => m.problemId === 'Q8' && m.kind === 'answer').text, completed);
  assert.equal(result.state.messages.at(-1).text, '次のページへ進もう');
  assert.equal(submitAnswer(scenario, start, ['ハナ', '知恵', '畏怖', '京都大地震']).status, 'correct');
  assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)), result.state);
  assert.equal(submitAnswer(scenario, result.state, correct).status, 'already-solved');
});

test('Q9は示された文字から3つの言葉を受け、選んだ言葉の幕だけを残す', () => {
  const problem = scenario.problems.find(p => p.id === 'Q9');
  const start = { ...initialState(scenario), selected: 'Q9' };
  assert.deepEqual(problem.wordBank, ['神', 'ハ', 'カ', 'エ', 'ッ', 'タ', 'セ', 'イ', 'ス', 'ク', 'ワ', 'レ', 'ベ', 'テ', 'ガ']);
  assert.equal(submitAnswer(scenario, start, '神は還った').status, 'incorrect');
  assert.equal(submitAnswer(scenario, start, '').status, 'empty');
  for (const branch of problem.answerBranches) {
    const result = submitAnswer(scenario, start, ` ${branch.answer} `);
    assert.equal(result.status, 'correct');
    assert.equal(result.state.branches.Q9, branch.id);
    const dialogue = result.state.messages.filter(m => m.problemId === 'Q9' && m.kind === 'dialogue');
    assert.equal(dialogue.at(-1).text, branch.dialogue.at(-1).text);
    assert.equal(dialogue.length, branch.dialogue.length);
    assert.deepEqual(restoreState(scenario, JSON.stringify(result.state)).branches, { Q9: branch.id });
  }
  const ending = problem.answerBranches.find(branch => branch.id === 'god-returned').dialogue;
  assert.equal(ending[0].text, '俺はあのとき、見返りがほしかっただけなんじゃないかって思う。');
  assert.equal(ending[0].epilogue, true);
  assert.equal(ending[1].text, 'ミサメが死に、悲しさと虚しさを埋めるためハナの野望を打ち砕く、そんな復讐に似た感情に身を任せた。');
  assert.equal(ending[1].epilogue, true);
  assert.equal(ending.at(-1).text, 'ただ、それでも俺は前を向く。');
  assert.equal(ending.find(line => line.text.includes('約束ですよ')).speaker, 'ミサメ');
  assert.equal(problem.answerBranches.find(branch => branch.id === 'world-saved').dialogue.length, 1);
  assert.equal(problem.answerBranches.find(branch => branch.id === 'all-saved').dialogue.length, 1);
});


test('Q4の旧番号の正解・会話を新番号へ一度だけ移し、再読込でずれない', () => {
  const raw = { ...initialState(scenario), version: 1, scenarioRevision: undefined, selected: 'Q4.3', solved: ['Q4.1', 'Q4.2', 'Q4.3', 'Q5'],
    messages: ['Q4.1', 'Q4.2', 'Q4.3'].map(problemId => ({ problemId, speaker: 'タツ', kind: 'dialogue', text: problemId })) };
  const restored = restoreState(scenario, JSON.stringify(raw));
  assert.equal(restored.selected, 'Q4');
  assert.deepEqual(restored.solved, ['Q4', 'Q5']);
  assert.deepEqual(restored.messages.map(m => m.problemId), ['Q4']);
  assert.deepEqual(restored.messages.map(m => m.text), ['Q4.3']);
  assert.deepEqual(restoreState(scenario, JSON.stringify(restored)), restored);
});

test('旧N6の番号・正解・会話をN5.5へ移し、現在のN5.5は再読込でも保持する', () => {
  const saved = { ...initialState(scenario), scenarioRevision: undefined, selected: 'N6', solved: ['N5', 'N6'],
    hints: { N6: 0 }, messages: [{ problemId: 'N6', speaker: 'タツ', kind: 'dialogue', text: 'ミサメが危ない！' }] };
  const restored = restoreState(scenario, JSON.stringify(saved));
  assert.equal(restored.selected, 'N5.5');
  assert.deepEqual(restored.solved, ['N5', 'N5.5']);
  assert.equal(restored.messages[0].problemId, 'N5.5');
  assert.deepEqual(restoreState(scenario, JSON.stringify(restored)), restored);
  const current = submitAnswer(scenario, { ...initialState(scenario), selected: 'N5.5' }, ['謎解き', '1人']).state;
  assert.deepEqual(restoreState(scenario, JSON.stringify(current)), current);
});

test('通常プレイの問題メニューは解答済みとこれから解く問題だけを返す', () => {
  const ids = state => availableNavigationProblems(scenario, state).map(p => p.id);
  const fresh = initialState(scenario);
  assert.deepEqual(ids(fresh), ['N1']);
  const n1 = submitAnswer(scenario, fresh, ['10']).state;
  assert.deepEqual(ids(n1), ['N1', 'N2']);
  const n4 = { ...fresh, selected: 'N4.1', solved: ['N1', 'N2', 'N3', 'N4'] };
  assert.deepEqual(ids(n4), ['N1', 'N2', 'N3', 'N4', 'N4.1']);
  assert.deepEqual(ids(restoreState(scenario, JSON.stringify(n4))), ids(n4));
});

test('旧N4.2の進行と会話をN4.1へまとめ、会話前の保存にも補完する', () => {
  const problem = scenario.problems.find(p => p.id === 'N4.1');
  for (const completed of [false, true]) {
    const old = { ...initialState(scenario), scenarioRevision: 1, selected: 'N4.2',
      solved: ['N4', 'N4.1', ...(completed ? ['N4.2'] : [])],
      messages: completed ? problem.dialogue.map(line => ({ ...line, kind: 'dialogue', problemId: 'N4.2' })) : [],
    };
    const restored = restoreState(scenario, JSON.stringify(old));
    assert.equal(restored.selected, 'N4.1');
    assert.deepEqual(restored.solved, ['N4', 'N4.1']);
    assert.deepEqual(restored.messages.map(m => m.text), problem.dialogue.map(m => m.text));
    assert.ok(restored.messages.every(m => m.problemId === 'N4.1'));
    assert.deepEqual(restoreState(scenario, JSON.stringify(restored)), restored);
    assert.ok(!availableNavigationProblems(scenario, restored).some(p => p.id === 'N4.2'));
  }
});

test('Q3が途中の間はQ4を出さず、N6は問題メニューに追加しない', () => {
  const prefix = scenario.problems.slice(0, scenario.problems.findIndex(p => p.id === 'Q3')).map(p => p.id);
  const state = { ...initialState(scenario), selected: 'Q3.3.1', solved: [...prefix, 'Q3', 'Q3.scaffold', 'Q3.2', 'Q3.3'] };
  const ids = availableNavigationProblems(scenario, state).map(p => p.id);
  assert.ok(ids.includes('Q3'));
  assert.ok(!ids.includes('Q4'));
  assert.ok(!ids.includes('Q3.3.1'));
  assert.ok(!ids.includes('N6'));
  const completed = { ...state, solved: [...state.solved, 'Q3.3.1'] };
  assert.ok(!ids.includes('Q3.1'));
  assert.ok(availableNavigationProblems(scenario, completed).some(p => p.id === 'Q3.1'));
  assert.ok(!availableNavigationProblems(scenario, completed).some(p => p.id === 'Q4'));
  const correct = ['蝋人形の間', '幽煙の間', 'かくしべや'];
  assert.equal(submitAnswer(scenario, { ...state, selected: 'Q3.1' }, correct).status, 'locked');
  const ready = { ...completed, selected: 'Q3.1' };
  assert.equal(submitAnswer(scenario, ready, [correct[1], correct[0], correct[2]]).status, 'incorrect');
  assert.equal(submitAnswer(scenario, ready, [...correct.slice(0, 2), 'かくしへや']).status, 'incorrect');
  const result = submitAnswer(scenario, ready, correct);
  assert.equal(result.status, 'correct');
  assert.ok(availableNavigationProblems(scenario, result.state).some(p => p.id === 'Q4'));
});
