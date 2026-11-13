/* =============================================================================
 * native.js —— 原生能力封装
 * =============================================================================
 * 原则：**全部特性检测**。在浏览器里跑时每个函数都会优雅降级，不会报错、不会白屏。
 * 这样同一份代码既能当 PWA，也能被打进 App。
 *
 * 需要装的 Capacitor 插件（已在 package.json 声明）：
 *   @capacitor/camera   拍照
 *   @capacitor/app      硬件返回键 / 版本号
 *   @capacitor/local-notifications  本地提醒
 *   @capacitor/filesystem  存到"文档"
 * ========================================================================== */
(function (g) {
  'use strict';

  function plugins() { return (g.Capacitor && g.Capacitor.Plugins) || {}; }
  function has(name) { return !!plugins()[name]; }
  var isNative = !!(g.Capacitor && g.Capacitor.isNativePlatform && g.Capacitor.isNativePlatform());

  function toast(msg) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:999;' +
      'background:rgba(15,23,42,.9);color:#fff;padding:10px 16px;border-radius:10px;' +
      'font-size:13px;max-width:86%;line-height:1.6;text-align:center';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2600);
  }

  /* ---------------- 1. 相机拍照 ---------------- */
  /**
   * 用原生相机拍一张，返回 File；不支持则返回 null（调用方自行降级到 <input>）
   * @param {boolean} fromCamera true=直接调相机，false=从相册选
   */
  async function pickPhoto(fromCamera) {
    var P = plugins();
    if (!P.Camera) return null;
    var photo = await P.Camera.getPhoto({
      quality: 90,
      allowEditing: false,
      resultType: 'dataUrl',
      source: (fromCamera === false) ? 'PHOTOS' : 'CAMERA',
      direction: 'REAR',
      width: 1920,
      correctOrientation: true,
      saveToGallery: false
    });
    if (!photo || !photo.dataUrl) return null;
    var res = await fetch(photo.dataUrl);
    var blob = await res.blob();
    var ext = (blob.type && blob.type.indexOf('png') >= 0) ? 'png' : 'jpg';
    var name = 'photo_' + new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14) + '.' + ext;
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  }

  /* ---------------- 2. 硬件返回键 ---------------- */
  /**
   * 注册返回键：handler 返回 true 表示"我已处理"，false 则退出 App。
   * @param {()=>boolean} handler
   */
  function installBackButton(handler) {
    var P = plugins();
    if (!P.App || !P.App.addListener) return false;
    P.App.addListener('backButton', function (ev) {
      var handled = false;
      try { handled = handler(ev) === true; } catch (e) { handled = false; }
      if (!handled && P.App.exitApp) P.App.exitApp();
    });
    return true;
  }

  /* ---------------- 3. 本地通知 / 提醒 ---------------- */
  async function ensureNotifyPermission() {
    var P = plugins();
    if (!P.LocalNotifications) return false;
    try {
      var r = await P.LocalNotifications.requestPermissions();
      return r.display === 'granted';
    } catch (e) { return false; }
  }

  /** 定时提醒（例如"3 天没备份了"）；只在原生里有效 */
  async function remindAt(date, title, body) {
    var P = plugins();
    if (!P.LocalNotifications) return false;
    if (!(await ensureNotifyPermission())) return false;
    try {
      await P.LocalNotifications.schedule({
        notifications: [{
          id: Math.floor(Date.now() / 1000) % 100000,
          title: title,
          body: body,
          schedule: { at: date }
        }]
      });
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 4. 直接存到"文档" ---------------- */
  /**
   * 存文件。原生：写入 App 的 Documents 目录并返回路径；
   * 浏览器：退回 <a download>。
   * @returns {Promise<{ok:boolean, path?:string, via:string}>}
   */
  async function saveFile(blob, filename) {
    var P = plugins();
    if (P.Filesystem && P.Filesystem.writeFile) {
      try {
        var b64 = await new Promise(function (resolve, reject) {
          var fr = new FileReader();
          fr.onload = function () {
            var s = String(fr.result || '');
            resolve(s.slice(s.indexOf(',') + 1));
          };
          fr.onerror = function () { reject(fr.error); };
          fr.readAsDataURL(blob);
        });
        var r = await P.Filesystem.writeFile({
          path: filename, data: b64, directory: 'DOCUMENTS', recursive: true
        });
        return { ok: true, path: r.uri, via: 'documents' };
      } catch (e) {
        console.warn('写入 Documents 失败，回退下载：', e);
      }
    }
    // 浏览器：普通下载
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    return { ok: true, via: 'download' };
  }

  /* ---------------- 5. 版本 / 检查更新 ---------------- */
  async function appInfo() {
    var P = plugins();
    var out = { version: null, build: null, platform: isNative ? 'app' : 'web' };
    if (P.App && P.App.getInfo) {
      try {
        var i = await P.App.getInfo();
        out.version = i.version;
        out.build = i.build;
      } catch (e) { /* ignore */ }
    }
    return out;
  }

  /**
   * 检查更新：读网页仓库里的 version.json（公开可访问），与当前版本比较。
   * @param {string} url   version.json 地址
   */
  async function checkUpdate(url) {
    var cur = await appInfo();
    var res = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) throw new Error('取版本信息失败 HTTP ' + res.status);
    var info = await res.json();
    return {
      current: cur.version || '1.0.0',
      latest: info.version,
      url: info.url || '',
      notes: info.notes || '',
      hasUpdate: String(info.version) !== String(cur.version || '1.0.0')
    };
  }

  /* ---------------- 6. 反馈 / 联系我们 ---------------- */
  function deviceLine() {
    var ua = navigator.userAgent || '';
    var m = ua.match(/Android[^;)]*/);
    return (m ? m[0] : (ua.slice(0, 60))) + ' | ' + (isNative ? 'App' : 'Web');
  }

  /**
   * 打开邮件反馈。原生里用系统邮件；没有邮件 App 时复制正文并提示。
   */
  function sendFeedback(to, subject, body) {
    var full = body + '\n\n---\n' + deviceLine();
    var href = 'mailto:' + encodeURIComponent(to) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(full);
    try {
      if (g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.App && g.Capacitor.Plugins.App.openUrl) {
        g.Capacitor.Plugins.App.openUrl({ url: href });
        return 'app';
      }
      g.location.href = href;
      return 'mailto';
    } catch (e) {
      copyText(full);
      toast('已复制反馈内容，请粘贴到邮件或微信发送');
      return 'copy';
    }
  }

  function copyText(t) {
    try {
      if (navigator.clipboard) { navigator.clipboard.writeText(t); return true; }
    } catch (e) { /* ignore */ }
    var ta = document.createElement('textarea');
    ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
    return true;
  }

  /* ---------------- 7. 倾角仪测坡度（纯 Web，无需插件） ---------------- */
  /**
   * 返回 {supported, start(cb), stop()}。
   * 用 deviceorientation 的 beta（前后倾）算角度；已做两次采样平滑。
   */
  function slopeSensor() {
    var handler = null, lastCall = 0, buf = [], cb = null;

    function onOrient(e) {
      var beta = e.beta;
      if (beta === null || beta === undefined) return;
      var now = Date.now();
      if (now - lastCall < 120) return;
      lastCall = now;
      // 手机竖着贴在坡面上时，前后倾角 ≈ 坡度；取绝对值
      buf.push(Math.abs(beta));
      if (buf.length > 6) buf.shift();
      var avg = buf.reduce(function (a, b) { return a + b; }, 0) / buf.length;
      if (cb) cb(Math.round(avg * 10) / 10);
    }

    return {
      supported: ('DeviceOrientationEvent' in g),
      start: function (onVal) {
        cb = onVal; buf = [];
        if (!('DeviceOrientationEvent' in g)) return false;
        g.addEventListener('deviceorientation', onOrient, true);
        handler = onOrient;
        return true;
      },
      /** 以当前读数为零点（地面本身有坡度时先校准） */
      calibrate: function () { buf = []; },
      stop: function () {
        if (handler) g.removeEventListener('deviceorientation', handler, true);
        handler = null; cb = null;
      }
    };
  }

  g.AGV_NATIVE = {
    isNative: isNative,
    hasPlugin: has,
    toast: toast,
    pickPhoto: pickPhoto,
    installBackButton: installBackButton,
    remindAt: remindAt,
    ensureNotifyPermission: ensureNotifyPermission,
    saveFile: saveFile,
    appInfo: appInfo,
    checkUpdate: checkUpdate,
    sendFeedback: sendFeedback,
    copyText: copyText,
    slopeSensor: slopeSensor,
    deviceLine: deviceLine
  };
})(typeof window !== 'undefined' ? window : globalThis);
