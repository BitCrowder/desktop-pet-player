function fitFrame(width, height, canvasWidth, canvasHeight) {
  const scale = Math.min(canvasWidth / width, canvasHeight / height);
  const w = width * scale;
  const h = height * scale;
  return { x: (canvasWidth - w) / 2, y: (canvasHeight - h) / 2, w, h };
}

function planPlayback(id, item) {
  const cycle = item.frameDurationsMs.reduce((sum, delay) => sum + delay, 0);
  const loop = (id === 'idle' || id === 'tail-nap') && item.loop;
  if (id === 'tiny-steps') {
    const cycles = Math.max(3, Math.ceil(1900 / cycle));
    return { duration: cycle * cycles, repeatFrames: true };
  }
  return { duration: loop ? null : cycle, repeatFrames: loop };
}

function animationFrame(item, elapsed, repeatFrames) {
  const time = Math.max(0, elapsed);
  let frameTime = repeatFrames ? time % item.cycle : time;
  const index = item.frameDurationsMs.findIndex(delay => (frameTime -= delay) < 0);
  return index < 0 ? item.frameDurationsMs.length - 1 : index;
}

if (typeof module !== 'undefined') module.exports = { fitFrame, planPlayback, animationFrame };
