// 文章量にかかわらず、短いセリフと同じ間隔で次を表示する。
export function readingDelay(message) {
  if (message.kind === 'answer' || message.kind === 'success') return 650;
  return 1400;
}

export function latestSceneStart(messages, problemId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].kind === 'answer' && messages[i].problemId === problemId) return i;
  }
  return messages.some(message => message.problemId) ? messages.length : 0;
}

export function createConversationPlayer({ onMessage, onComplete, onWait, schedule = setTimeout, cancel = clearTimeout }) {
  let timer;
  let generation = 0;
  function stop() {
    generation++;
    cancel(timer);
    timer = undefined;
    onWait?.(null);
  }
  function play(messages, { immediate = false } = {}) {
    stop();
    const run = generation;
    let index = 0;
    function next() {
      if (run !== generation) return;
      if (index === messages.length) { timer = undefined; onComplete(); return; }
      const message = messages[index++];
      onMessage(message);
      if (run === generation) {
        const upcoming = messages[index];
        if (upcoming) onWait?.(upcoming);
        timer = schedule(next, readingDelay(message));
      }
    }
    if (immediate) next();
    else {
      if (messages.length) onWait?.(messages[0]);
      timer = schedule(next, 300);
    }
  }
  return { play, stop };
}
