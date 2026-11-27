export function offlineSetup(button: HTMLButtonElement, status: HTMLElement) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    button.disabled = true;
    status.textContent = 'Offline launch requires HTTPS or localhost.';
    return;
  }
  const service = navigator.serviceWorker;
  const script = new URL('offline-sw.js', document.baseURI);
  const offlineReady = () => {
    status.textContent = 'Offline launch is ready for this address.';
    button.textContent = 'Refresh offline cache';
  };
  void service.getRegistration().then(registration => {
    if (registration?.active?.scriptURL === script.href) offlineReady();
  }).catch(() => undefined);
  service.addEventListener('controllerchange', () => {
    if (service.controller?.scriptURL === script.href) offlineReady();
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Saving application files for offline launch…';
    try {
      const registration = await service.register(script, { updateViaCache: 'none' });
      const installing = registration.installing ?? registration.waiting;
      if (installing) await new Promise<void>((resolve, reject) => {
        const finish = () => {
          if (installing.state === 'activated' || installing.state === 'installed') resolve();
          else if (installing.state === 'redundant') reject(new Error('The application files could not be cached.'));
          else return;
          installing.removeEventListener('statechange', finish);
        };
        installing.addEventListener('statechange', finish);
        finish();
      });
      if (registration.waiting && registration.active) status.textContent = 'The new offline build will activate after its open tabs are closed.';
      else { await service.ready; offlineReady(); }
    } catch (error) {
      status.textContent = `Offline launch unavailable. ${error instanceof Error ? error.message : String(error)}`;
    } finally { button.disabled = false; }
  });
}
