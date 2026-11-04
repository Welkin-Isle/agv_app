/* =============================================================================
 * media.js —— 媒体处理：拍照 / 相册 / 图片压缩 / 视频录制
 * =============================================================================
 * 策略（对应决策 N1）：
 *   · 图片：canvas 重编码 → 长边 1920 / JPEG 0.72；另生成 240px 缩略图
 *   · 视频：**App 内录制**，固定 720p / 约 1.5 Mbps → 体积天然可控
 *   · 相册里选的外部视频：不转码，只做体积/时长提示（双端一致）
 * ========================================================================== */
(function (g) {
  'use strict';

  var IMG_MAX_EDGE = 1920;
  var IMG_QUALITY = 0.72;
  var THUMB_EDGE = 240;
  var VIDEO_MAX_BYTES = 200 * 1024 * 1024;   // 200MB 提示阈值
  var VIDEO_MAX_MINUTES = 5;

  /* ---------------- 图片压缩 ---------------- */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  function drawToCanvas(img, maxEdge) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, cw, ch);
    return { canvas: c, w: cw, h: ch };
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(function (b) { resolve(b); }, 'image/jpeg', quality);
      else resolve(dataURLtoBlob(canvas.toDataURL('image/jpeg', quality)));
    });
  }
  function dataURLtoBlob(d) {
    var parts = d.split(',');
    var mime = /:(.*?);/.exec(parts[0])[1];
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /** 压缩一张图片 → { blob, thumb, w, h, name, size, mime } */
  async function compressImage(file) {
    var img = await loadImage(file);
    var big = drawToCanvas(img, IMG_MAX_EDGE);
    var blob = await canvasToBlob(big.canvas, IMG_QUALITY);
    var small = drawToCanvas(img, THUMB_EDGE);
    var thumb = await canvasToBlob(small.canvas, 0.6);
    return {
      blob: blob, thumb: thumb,
      w: big.w, h: big.h,
      name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg',
      size: blob.size,
      mime: 'image/jpeg',
      originalSize: file.size
    };
  }

  /* ---------------- 视频录制 ---------------- */
  var recorder = null, chunks = [], stream = null, recStartAt = 0;

  function supportsRecording() {
    return !!(g.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && g.MediaRecorder);
  }

  /** 挑一个当前浏览器支持的视频 mimeType（iOS/安卓取交集） */
  function pickVideoMime() {
    var cands = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    for (var i = 0; i < cands.length; i++) {
      try { if (MediaRecorder.isTypeSupported(cands[i])) return cands[i]; } catch (e) { }
    }
    return '';
  }

  async function startRecording(opts) {
    if (recorder) throw new Error('已在录制中');
    opts = opts || {};
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: opts.facing || 'environment',
        width: { ideal: 1280 }, height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 }
      },
      audio: opts.audio !== false
    });
    var mime = pickVideoMime();
    var options = { videoBitsPerSecond: 1500000 };     // ≈1.5 Mbps → 1 分钟约 11MB
    if (mime) options.mimeType = mime;
    recorder = new MediaRecorder(stream, options);
    chunks = [];
    recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(1000);
    recStartAt = Date.now();
    return { mimeType: recorder.mimeType || mime || 'video/mp4' };
  }

  function stopRecording() {
    return new Promise(function (resolve, reject) {
      if (!recorder) { reject(new Error('没有在录制')); return; }
      var r = recorder;
      r.onstop = function () {
        var type = (r.mimeType || 'video/mp4').split(';')[0];
        var blob = new Blob(chunks, { type: type });
        var secs = Math.round((Date.now() - recStartAt) / 1000);
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
        recorder = null; chunks = [];
        var ext = type.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
        var d = new Date();
        var p = function (x) { return x < 10 ? '0' + x : '' + x; };
        resolve({
          blob: blob,
          name: 'video_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
                p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + ext,
          size: blob.size, mime: type, duration: secs
        });
      };
      try { r.stop(); } catch (e) { reject(e); }
    });
  }

  function elapsed() { return recorder ? Math.round((Date.now() - recStartAt) / 1000) : 0; }
  function isRecording() { return !!recorder; }

  /* ---------------- 外部视频体积提示 ---------------- */
  function checkVideo(file) {
    if (file.size > VIDEO_MAX_BYTES) {
      return '该视频 ' + (file.size / 1048576).toFixed(0) + 'MB，超过建议上限 ' +
        (VIDEO_MAX_BYTES / 1048576) + 'MB。导出时会很慢，建议先用 App 内录制或自行裁剪。';
    }
    return '';
  }

  /** 读取视频时长（用于提示） */
  function videoDuration(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = function () { URL.revokeObjectURL(url); resolve(v.duration || 0); };
      v.onerror = function () { URL.revokeObjectURL(url); resolve(0); };
      v.src = url;
    });
  }

  g.AGV_MEDIA = {
    compressImage: compressImage,
    supportsRecording: supportsRecording,
    startRecording: startRecording,
    stopRecording: stopRecording,
    elapsed: elapsed,
    isRecording: isRecording,
    checkVideo: checkVideo,
    videoDuration: videoDuration,
    VIDEO_MAX_BYTES: VIDEO_MAX_BYTES
  };
})(typeof window !== 'undefined' ? window : globalThis);
