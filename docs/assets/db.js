/* =============================================================================
 * db.js —— IndexedDB 封装（纯本地存储）
 * =============================================================================
 * 三个对象仓库：
 *   projects  方案（keyPath=id），answers 为 JSON 整体存
 *   media     媒体 Blob（keyPath=id，index=projectId）
 *   settings  键值对（keyPath=k）
 *
 * 设计要点：
 *   · 媒体单独存 Blob，绝不塞进 answers（否则 JSON 会撑爆）
 *   · 每条记录带 updatedAt + syncState 预留位，v2 加同步不用改结构
 * ========================================================================== */
(function (g) {
  'use strict';
  var DB_NAME = 'agv_field';
  var DB_VER = 1;
  var _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('projects')) {
          var ps = db.createObjectStore('projects', { keyPath: 'id' });
          ps.createIndex('updatedAt', 'updatedAt');
          ps.createIndex('status', 'status');
        }
        if (!db.objectStoreNames.contains('media')) {
          var ms = db.createObjectStore('media', { keyPath: 'id' });
          ms.createIndex('projectId', 'projectId');
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'k' });
        }
      };
      req.onsuccess = function () { _db = req.result; resolve(_db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, mode);
        var s = t.objectStore(store);
        var out;
        try { out = fn(s); } catch (e) { reject(e); return; }
        t.oncomplete = function () {
          // 注意：get() 查不到时 result === undefined，此时必须 resolve(undefined)，
          // 不能回退成 IDBRequest 对象本身（那是个真值，会让"未找到"判断全部失效）。
          if (out && typeof IDBRequest !== 'undefined' && out instanceof IDBRequest) {
            resolve(out.result);
          } else {
            resolve(out);
          }
        };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function uuid() {
    if (g.crypto && g.crypto.randomUUID) return g.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  function nowISO() { return new Date().toISOString(); }

  /* ---------------------------- projects ---------------------------- */
  function newProject(fields) {
    var t = nowISO();
    return Object.assign({
      id: uuid(),
      name: '',
      customer: '',
      status: 'draft',                 // draft | done
      answers: {},
      note: '',
      createdAt: t,
      updatedAt: t,
      exportedAt: null,
      lastBackupAt: null,
      schemaVersion: '1.0',
      syncState: 'local'               // 预留：local | synced
    }, fields || {});
  }

  function listProjects() {
    return tx('projects', 'readonly', function (s) { return s.getAll(); })
      .then(function (rows) {
        return (rows || []).sort(function (a, b) {
          return String(b.updatedAt).localeCompare(String(a.updatedAt));
        });
      });
  }
  function getProject(id) {
    return tx('projects', 'readonly', function (s) { return s.get(id); });
  }
  function putProject(p) {
    p.updatedAt = nowISO();
    return tx('projects', 'readwrite', function (s) { s.put(p); return p; });
  }
  function deleteProject(id) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(['projects', 'media'], 'readwrite');
        t.objectStore('projects').delete(id);
        var idx = t.objectStore('media').index('projectId');
        var req = idx.openKeyCursor(IDBKeyRange.only(id));
        req.onsuccess = function () {
          var c = req.result;
          if (c) { t.objectStore('media').delete(c.primaryKey); c.continue(); }
        };
        t.oncomplete = resolve;
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  /* ---------------------------- media ---------------------------- */
  function addMedia(m) {
    var rec = Object.assign({
      id: uuid(), projectId: '', zone: 'site_photos',
      kind: 'image', name: '', mime: '', size: 0,
      blob: null, thumb: null, w: 0, h: 0, duration: 0,
      note: '', createdAt: nowISO()
    }, m);
    return tx('media', 'readwrite', function (s) { s.put(rec); return rec; });
  }
  function listMedia(projectId) {
    return tx('media', 'readonly', function (s) {
      return s.index('projectId').getAll(IDBKeyRange.only(projectId));
    }).then(function (rows) {
      return (rows || []).sort(function (a, b) {
        return String(a.createdAt).localeCompare(String(b.createdAt));
      });
    });
  }
  function deleteMedia(id) {
    return tx('media', 'readwrite', function (s) { s.delete(id); });
  }
  function countMedia(projectId) {
    return tx('media', 'readonly', function (s) {
      return s.index('projectId').count(IDBKeyRange.only(projectId));
    });
  }

  /* ---------------------------- settings ---------------------------- */
  function getSetting(k, dflt) {
    return tx('settings', 'readonly', function (s) { return s.get(k); })
      .then(function (r) { return r ? r.v : dflt; });
  }
  function setSetting(k, v) {
    return tx('settings', 'readwrite', function (s) { s.put({ k: k, v: v }); return v; });
  }

  /* ---------------------------- 存储用量 ---------------------------- */
  async function usage() {
    if (navigator.storage && navigator.storage.estimate) {
      try {
        var e = await navigator.storage.estimate();
        return { used: e.usage || 0, quota: e.quota || 0 };
      } catch (err) { /* 忽略 */ }
    }
    return { used: 0, quota: 0 };
  }

  g.AGV_DB = {
    uuid: uuid, nowISO: nowISO,
    newProject: newProject,
    listProjects: listProjects, getProject: getProject,
    putProject: putProject, deleteProject: deleteProject,
    addMedia: addMedia, listMedia: listMedia,
    deleteMedia: deleteMedia, countMedia: countMedia,
    getSetting: getSetting, setSetting: setSetting,
    usage: usage
  };
})(typeof window !== 'undefined' ? window : globalThis);
