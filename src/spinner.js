const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function createSpinner(text, stream = process.stderr) {
  let index = 0;
  let timer = null;
  const enabled = Boolean(stream.isTTY);

  function render() {
    stream.write(`\r${FRAMES[index]} ${text}`);
    index = (index + 1) % FRAMES.length;
  }

  return {
    start() {
      if (!enabled || timer) return;
      render();
      timer = setInterval(render, 80);
      timer.unref?.();
    },

    stop() {
      if (!enabled) return;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      stream.write(`\r${' '.repeat(text.length + 4)}\r`);
    },
  };
}
