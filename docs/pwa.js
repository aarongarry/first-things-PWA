export function setupPWA({ beforeUpdate = () => true } = {}) {
  const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);
  let promptEvent;
  const dialog = document.querySelector('#install-dialog');
  const status = document.querySelector('#pwa-status');
  const update = document.querySelector('#pwa-update');
  function refresh() {
    document.documentElement.classList.toggle('installed', installed());
  }
  function instructions() {
    const steps = ios
      ? '<li>Open this page in <strong>Safari</strong>.</li><li>Tap <strong>Share</strong> (the square with an up arrow). It may be inside the page menu.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Keep <strong>Open as Web App</strong> on, if shown, and tap <strong>Add</strong>.</li>'
      : android
        ? '<li>Open this page in <strong>Chrome</strong>.</li><li>Open the <strong>⋮ menu</strong>.</li><li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>, then confirm.</li>'
        : '<li>Open this link on your phone.</li><li>On iPhone: use Safari’s <strong>Share → Add to Home Screen</strong>.</li><li>On Android: use Chrome’s <strong>⋮ → Install app</strong>.</li>';
    dialog.querySelector('#install-steps').innerHTML = steps;
    dialog.showModal();
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-install]');
    if (!button) return;
    if (promptEvent && !ios) {
      const deferred = promptEvent;
      promptEvent = null;
      try { await deferred.prompt(); await deferred.userChoice; }
      catch { instructions(); }
    } else instructions();
  });
  dialog.querySelector('[data-close-install]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  } });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); promptEvent = event; });
  window.addEventListener('appinstalled', () => { promptEvent = null; refresh(); dialog.close(); });
  matchMedia('(display-mode: standalone)').addEventListener('change', refresh);
  refresh();
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    status.textContent = 'Open the HTTPS website to enable installation and offline use.';
    return;
  }
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) location.reload();
  });
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(registration => {
    const waiting = () => {
      if (!registration.waiting || !navigator.serviceWorker.controller) return;
      update.hidden = false;
      update.onclick = () => {
        if (!beforeUpdate()) return;
        if (!registration.waiting) { update.hidden = true; return; }
        refreshing = true;
        registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
      };
    };
    waiting();
    registration.addEventListener('updatefound', () => {
      registration.installing?.addEventListener('statechange', waiting);
    });
    navigator.serviceWorker.ready.then(() => {
      status.textContent = 'Ready for offline use on this device.';
    });
    window.addEventListener('online', () => { void registration.update().catch(() => {}); });
  }).catch(() => { status.textContent = 'Offline setup couldn’t finish. Reconnect and reopen this page to retry.'; });
}
