// Phones and tablets only: go back into fullscreen with one tap.
//
// After a student switches apps/tabs on a phone and comes back, the browser
// has left fullscreen. On phones the quiz's own "tap to go back" check thinks
// the page is still fullscreen (the browser window is reported as screen-sized),
// so the tap did nothing. This file fixes that separately: the first tap
// anywhere (an answer, a button, the question) puts the quiz back in fullscreen.
//
// It only asks for fullscreen. It does not detect or report anything —
// proctor.js still decides every alert (tab switch, fullscreen exit, …).
// Laptops and desktops are not affected.
(function () {
  const ua = navigator.userAgent || '';
  const touchFirst =
    /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || // iPad asking for the desktop site
    (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
  if (!touchFirst) return;

  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  const enabled = document.fullscreenEnabled !== false || document.webkitFullscreenEnabled;
  if (!request || !enabled) return; // e.g. iPhone Safari: fullscreen isn't allowed for web pages

  const inFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const quizRunning = () => {
    const shell = document.getElementById('quizShell');
    return !!shell && shell.style.display !== 'none';
  };

  let busy = false;
  let leaving = false;
  window.addEventListener('pagehide', () => { leaving = true; });
  window.addEventListener('beforeunload', () => { leaving = true; });

  function goFullscreen() {
    if (busy || leaving || document.hidden || !quizRunning() || inFullscreen()) return;
    busy = true;
    let result;
    try {
      result = request.call(root, { navigationUI: 'hide' });
    } catch (e) {
      try { result = request.call(root); } catch (e2) { /* not allowed right now */ }
    }
    Promise.resolve(result).catch(() => {}).finally(() => {
      busy = false;
      updateHint();
    });
  }

  // Any tap counts — capture phase, so taps on answers and buttons work too.
  ['touchend', 'pointerup', 'click'].forEach((type) =>
    document.addEventListener(type, goFullscreen, { capture: true, passive: true }));

  // Small reminder bar while the quiz is open but not in fullscreen.
  const hint = document.createElement('button');
  hint.type = 'button';
  hint.className = 'fs-return-hint';
  hint.hidden = true;
  hint.innerHTML = '<span class="fs-return-icon" aria-hidden="true">⛶</span> Tap to return to fullscreen';
  hint.addEventListener('click', goFullscreen);
  document.body.appendChild(hint);

  function updateHint() {
    hint.hidden = !quizRunning() || inFullscreen() || leaving;
  }
  ['fullscreenchange', 'webkitfullscreenchange', 'visibilitychange', 'resize', 'orientationchange']
    .forEach((type) => document.addEventListener(type, updateHint));
  window.addEventListener('resize', updateHint);
  setInterval(updateHint, 1000); // also catches the moment the quiz starts
})();
