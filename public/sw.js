/* =============================================================================
 * sw.js —— Service Worker（离线缓存）
 * =============================================================================
 * 策略：
 *   应用外壳（html/js/css/icons）→ 安装时预缓存，之后 cache-first
 *   调研表模板 template.xlsx（4.9MB）→ 首次用到时缓存，之后 cache-first
 * 注意：更新版本号 VERSION 即可让客户端拉取新代码（不会清掉 IndexedDB 数据）
 * ========================================================================== */
var VERSION = 'v1.0.0';
var SHELL_CACHE = 'agv-shell-' + VERSION;
var DATA_CACHE = 'agv-data-' + VERSION;

var SHELL = [
  './',
  './index.html',
  './project.html',
  './module.html',
  './selftest.html',
  './manifest.webmanifest',
  './assets/app.css',
  './assets/util.js',
  './assets/db.js',
  './assets/zip.js',
  './assets/schema.js',
  './assets/controls.js',
  './assets/xlsxgen.js',
  './assets/export.js',
  './assets/media.js',
  './assets/home.js',
  './assets/project.js',
  './assets/module.js',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function (c) {
      return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== SHELL_CACHE && k !== DATA_CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 调研表模板：缓存优先（很大，不常变）
  if (url.pathname.indexOf('/template/') >= 0) {
    e.respondWith(
      caches.open(DATA_CACHE).then(function (c) {
        return c.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && res.ok) c.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  // 外壳：缓存优先，回退网络
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok && (req.destination === 'script' || req.destination === 'style' ||
            req.destination === 'document' || req.destination === 'image')) {
          var copy = res.clone();
          caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        // 离线且未缓存：页面请求回退到 index.html
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 504 });
      });
    })
  );
});
