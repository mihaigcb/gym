// Gym Journal — Timer Service Worker
// Keeps a scheduled notification alive even when the screen is locked.

let _timerId     = null;
let _timerResolve = null;

function _cancelPending() {
  if (_timerId !== null) {
    clearTimeout(_timerId);
    _timerId = null;
  }
  if (_timerResolve) {
    _timerResolve();   // resolve the waitUntil promise so SW can idle
    _timerResolve = null;
  }
}

self.addEventListener('message', event => {
  const { type, endTime, label } = event.data || {};

  // Always cancel any existing timer first
  _cancelPending();

  if (type === 'START_TIMER') {
    const delay = Math.max(0, endTime - Date.now());

    event.waitUntil(
      new Promise(resolve => {
        _timerResolve = resolve;
        _timerId = setTimeout(async () => {
          _timerId     = null;
          _timerResolve = null;
          try {
            await self.registration.showNotification('Rest complete! \u2705', {
              body: (label || 'Rest') + ' \u2014 time to get back to it!',
              vibrate: [300, 100, 300, 100, 300],
              tag: 'gym-timer',
              renotify: true,
              silent: false
            });
          } catch (e) { /* notifications not supported */ }
          resolve();
        }, delay);
      })
    );
  }
  // CANCEL_TIMER: already handled by _cancelPending() above
});
