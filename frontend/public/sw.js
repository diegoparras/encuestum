/*
 * Service worker de las encuestas públicas (/s/…): deja abrir y completar una
 * encuesta ya visitada aunque se corte la conexión (aula sin wifi, trabajo de
 * campo). Las respuestas que no salen se guardan en el dispositivo y se mandan
 * solas al volver la red (ver SurveyView.tsx). Nada del panel se cachea.
 */
const CACHE = "encuestum-publico-v1";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function esEstatico(url) {
  return url.pathname.startsWith("/_next/static/") || /\.(?:css|js|woff2?|svg|png|jpe?g|webp|ico)$/.test(url.pathname);
}

function esEncuesta(url, req) {
  if (req.mode === "navigate") return url.pathname.startsWith("/s/");
  // Sólo la definición pública de la encuesta, no envíos ni otros datos.
  return /\/api\/v1\/survey\/public\/[^/]+$/.test(url.pathname);
}

async function primeroCache(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function primeroRed(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: req.mode === "navigate" });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (esEstatico(url)) event.respondWith(primeroCache(req));
  else if (esEncuesta(url, req)) event.respondWith(primeroRed(req));
});
