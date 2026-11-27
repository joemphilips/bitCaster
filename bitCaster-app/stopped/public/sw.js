// The service worker of a stopped host. It has the URL and the scope of the app service
// worker, so a browser that has the cached app installs it at the next update check. It
// takes control of every open page of the app, reloads it from the network, which serves
// the stopped page, and then removes its own registration. It has no fetch handler and
// keeps no cache. It does not delete the browser storage of this origin.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const windows = await self.clients.matchAll({ type: "window" });
      await self.registration.unregister();
      // Do not wait for the reloads. The navigation of a page that this worker controls
      // waits for the end of this activation.
      for (const client of windows) client.navigate(client.url).catch(() => null);
    })(),
  );
});
