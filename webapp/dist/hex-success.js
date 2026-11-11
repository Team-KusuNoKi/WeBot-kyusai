// The celebration ends when the player chooses to continue, independently of the animation.
export function showHexSuccess(host) {
  const dialog = document.createElement('dialog');
  dialog.className = 'hex-success';
  dialog.setAttribute('aria-labelledby', 'hex-success-title');
  dialog.innerHTML = `<div class="hex-confetti" aria-hidden="true"></div>
    <div class="hex-success-card">
      <h2 id="hex-success-title">成功</h2>
      <button type="button">次へ</button>
    </div>`;
  host.append(dialog);
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  function close() {
    if (dialog.open) dialog.close();
    dialog.remove();
    resolveFinished();
  }
  dialog.querySelector('button').addEventListener('click', close);
  dialog.addEventListener('cancel', event => event.preventDefault());
  dialog.showModal();
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    burstConfetti(dialog.querySelector('.hex-confetti'));
  }
  return { finished, close };
}

function burstConfetti(layer) {
  const colors = ['#f5bd57', '#e47464', '#67bfaf', '#90bbec', '#d398c7', '#fff1c8'];
  const { width, height } = layer.getBoundingClientRect();
  for (const direction of [1, -1]) {
    for (let i = 0; i < 38; i++) {
      const paper = document.createElement('i');
      paper.style.background = colors[i % colors.length];
      paper.style.left = direction === 1 ? '0' : '100%';
      paper.style.width = (5 + Math.random() * 5) + 'px';
      paper.style.height = (8 + Math.random() * 8) + 'px';
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
