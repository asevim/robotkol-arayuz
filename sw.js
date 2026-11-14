/* sw.js - uygulama olarak kurulum ve internetsiz calisma.
 * Ilk acilista butun dosyalar (3D model dahil, ~9 MB) onbellege alinir;
 * sonra sayfa internet ve sunucu olmadan da acilir. Cevrimiciyken html/js
 * guncel surumu once agdan dener (yeni surum yuklenince kendiliginden gelir). */
const CACHE = "robotkol-20261114144954";
const ASSETS = ["./", "index.html", "usbmon.js", "usbmon-sahte.js", "manifest.webmanifest",
  "icon-192.png", "icon-512.png", "vendor/three.min.js", "vendor/OrbitControls.js",
  "vendor/serial-polyfill.js", "model/arm.json", "model/arm.bin", "model/kin.json"];

/* Buyuk ve degismeyen dosyalar (3D model, three.js): once onbellek. Digerleri
 * (html, usbmon.js, USB kutuphanesi) her acilista agdan denetlenir. */
const HEAVY = /\/(model\/|vendor\/three\.min\.js|vendor\/OrbitControls\.js)|\.png$/;

self.addEventListener("install", e => {
  /* cache:"reload": tarayicinin HTTP onbellegindeki (GitHub 10 dk tutar) eski
   * kopyayi degil, sunucudaki guncel dosyayi al */
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.includes("/api/")) return;   /* canli veri: hep ag */
  if (HEAVY.test(url.pathname)) {                                   /* buyuk ve degismeyen: once onbellek */
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    return;
  }
  /* html/js: once ag (ETag ile denetle, eskiyi kullanma), olmazsa onbellek */
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
