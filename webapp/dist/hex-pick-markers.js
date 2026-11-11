export function createPickMarkers(group) {
  const labels = ['①', '②'].map(() => {
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    group.append(label);
    return label;
  });
  let finishPair;

  function place(index, area, offset = 0) {
    const angle = (area - 1) * Math.PI / 3;
    const radius = 158 / Math.sqrt(3);
    labels[index].setAttribute('x', 300 + radius * Math.cos(angle) + offset);
    labels[index].setAttribute('y', 190 + radius * Math.sin(angle));
    labels[index].textContent = index === 0 ? '①' : '②';
  }

  function clear() {
    for (const label of labels) label.textContent = '';
    finishPair?.();
  }

  return {
    first(area) { clear(); place(0, area); },
    pair(first, second) {
      const offset = first === second ? 11 : 0;
      place(0, first, -offset);
      place(1, second, offset);
      return new Promise(resolve => {
        const timer = setTimeout(clear, 450);
        finishPair = () => {
          clearTimeout(timer);
          finishPair = undefined;
          resolve();
        };
      });
    },
    clear,
  };
}
