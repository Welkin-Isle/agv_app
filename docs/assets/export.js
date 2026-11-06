/* =============================================================================
 * export.js —— 导出打包：xlsx + 媒体 + answers.json，可选加密
 * =============================================================================
 * 产物结构：
 *   客户名_日期.zip
 *   ├─ 1.1 AGV项目需求调研表_客户_日期.xlsx
 *   ├─ 现场照片/  01_xxx.jpg
 *   ├─ 现场视频/  01_xxx.mp4
 *   ├─ 图纸/
 *   ├─ answers.json          原始答案（可再次生成表格、可喂选型工具）
 *   └─ 说明.txt
 *
 * 加密（可选）：AES-GCM 256 + PBKDF2 120k，输出 *.zip.enc
 * 分包（iOS 大文件对策）：先出「表格+照片+图纸」，视频单独一包
 * ========================================================================== */
(function (g) {
  'use strict';

  var TPL_URL = 'template/template.xlsx';
  var _tplBuf = null;

  /**
   * 加载调研表模板（约 43 KB）。首次需要下载，之后走 Service Worker / 内存缓存。
   * @param {(received:number, total:number)=>void} [onProgress] 下载进度回调
   */
  async function loadTemplate(onProgress) {
    if (_tplBuf) return _tplBuf;
    var res = await fetch(TPL_URL);
    if (!res.ok) throw new Error('找不到调研表模板（' + TPL_URL + '，HTTP ' + res.status + '）');

    // 能拿到 content-length 且支持流式读取时，报告真实进度；
    // 否则退化为一次性读取（不会卡死，只是没有百分比）。
    var total = Number(res.headers.get('content-length') || 0);
    if (!res.body || !total || typeof res.body.getReader !== 'function') {
      _tplBuf = await res.arrayBuffer();
      if (onProgress) onProgress(_tplBuf.byteLength, _tplBuf.byteLength);
      return _tplBuf;
    }

    var reader = res.body.getReader();
    var chunks = [], received = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value);
      received += step.value.length;
      if (onProgress) onProgress(received, total);
    }
    var buf = new Uint8Array(received), off = 0;
    for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].length; }
    _tplBuf = buf.buffer;
    return _tplBuf;
  }

  function isTemplateLoaded() { return !!_tplBuf; }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function stamp(d) {
    d = d || new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }
  function safeName(s) {
    return String(s || '未命名').replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 40) || '未命名';
  }
  function baseName(project) {
    return safeName(project.customer || project.name) + '_' + stamp();
  }

  var ZONE_DIR = {
    site_photos: '现场照片',
    material_photos: '物料载具照片',
    drawings: '图纸',
    videos: '现场视频',
    temp: '快速记录'
  };

  /* ---------------- 说明.txt ---------------- */
  function readme(project, counts) {
    var L = [];
    L.push('AGV 现场记录导出包');
    L.push('================================');
    L.push('客户/项目：' + (project.customer || '') + (project.name ? ' · ' + project.name : ''));
    L.push('导出时间：' + new Date().toLocaleString('zh-CN'));
    L.push('数据来源：方案设计人员手机端「AGV 现场记录」App（本地存储，未上传服务器）');
    L.push('');
    L.push('包含内容：');
    L.push('  · 1.1 AGV项目需求调研表 —— 格式与公司空白调研表一致，未填项保持空白');
    L.push('  · 现场照片 ' + (counts.site_photos || 0) + ' 个');
    L.push('  · 物料载具照片 ' + (counts.material_photos || 0) + ' 个');
    L.push('  · 现场视频 ' + (counts.videos || 0) + ' 个');
    L.push('  · 图纸 ' + (counts.drawings || 0) + ' 个');
    L.push('  · answers.json —— 原始答案，可用于重新生成表格或导入选型工具');
    L.push('');
    L.push('说明：');
    L.push('  1. 表格中未能对应到原表预留位置的内容（如物料 A3、载具 B2、组合 C3 及以后，');
    L.push('     以及"选型补充""其他需求"），统一写在表格 R84 起的【扩展区】。');
    L.push('  2. 未填写的字段在原表中保持空白，不做任何标记。');
    if (project.exportedAtTimes) L.push('  3. 本次为该项目的第 ' + project.exportedAtTimes + ' 次导出。');
    return L.join('\r\n');
  }

  /* ---------------- 组装 zip ---------------- */
  /**
   * @param {Object} opt
   *   project, answers, media([{zone,name,blob,size,mime,note,createdAt}]),
   *   includeVideos(boolean), splitVideo(boolean)
   * @returns {Promise<{files:[{name,blob,size}], total:number}>}
   */
  async function build(opt) {
    var project = opt.project || {};
    var answers = opt.answers || {};
    var media = opt.media || [];
    var includeVideos = opt.includeVideos !== false;

    var tpl = await loadTemplate();
    var xlsxBlob = await g.AGV_XLSX.generate(tpl, project, answers, g.AGV_SCHEMA);

    var base = baseName(project);
    var entries = [];
    entries.push({
      name: g.AGV_XLSX.fileName(project),
      data: xlsxBlob
    });

    // 媒体按区分类，序号前缀保证顺序
    var counters = {};
    var counts = {};
    media.forEach(function (m) {
      if (!m.blob) return;
      if (m.zone === 'videos' && !includeVideos) return;
      // 视频统一放「现场视频」目录（不论来自哪个上传区）
      var isVideo = (m.mime || '').indexOf('video/') === 0;
      if (isVideo && !includeVideos) return;
      var dir = isVideo ? '现场视频' : (ZONE_DIR[m.zone] || '附件');
      counters[dir] = (counters[dir] || 0) + 1;
      counts[m.zone] = (counts[m.zone] || 0) + 1;
      var seq = pad2(counters[dir]);
      var note = m.note ? safeName(m.note) : '';
      var ext = (m.name && /\.[^.]+$/.exec(m.name)) ? /\.[^.]+$/.exec(m.name)[0] : '';
      var fname = seq + (note ? '_' + note : '') + ext;
      entries.push({ name: dir + '/' + fname, data: m.blob });
    });

    entries.push({ name: 'answers.json', data: JSON.stringify({
      _meta: {
        app: 'AGV 现场记录', version: '1.0',
        exportedAt: new Date().toISOString(),
        projectId: project.id,
        schemaVersion: project.schemaVersion || '1.0'
      },
      project: {
        customer: project.customer, name: project.name,
        status: project.status, createdAt: project.createdAt, updatedAt: project.updatedAt
      },
      answers: answers
    }, null, 1) });

    entries.push({ name: '说明.txt', data: readme(project, counts) });

    var files = [];
    if (opt.splitVideo && includeVideos) {
      // 第一包：不含视频
      var noVid = await g.AGV_ZIP.writeZip(entries.filter(function (e) {
        return e.name.indexOf('现场视频/') !== 0;
      }));
      files.push({ name: base + '_表格与照片.zip', blob: noVid, size: noVid.size });

      // 第二包：只有视频
      var vidEntries = media.filter(function (m) { return m.zone === 'videos' && m.blob; })
        .map(function (m, i) {
          var ext = (/\.[^.]+$/.exec(m.name) || [''])[0];
          return { name: '现场视频/' + pad2(i + 1) + (m.note ? '_' + safeName(m.note) : '') + ext, data: m.blob };
        });
      if (vidEntries.length) {
        var onlyVid = await g.AGV_ZIP.writeZip(vidEntries);
        files.push({ name: base + '_视频.zip', blob: onlyVid, size: onlyVid.size });
      }
    } else {
      var one = await g.AGV_ZIP.writeZip(entries);
      files.push({ name: base + '.zip', blob: one, size: one.size });
    }

    var total = files.reduce(function (s, f) { return s + f.size; }, 0);
    return { files: files, total: total, xlsx: xlsxBlob };
  }

  /* ---------------- 加密（可选） ---------------- */
  var MAGIC = 'AGVENC01';

  async function deriveKey(password, salt) {
    var enc = new TextEncoder();
    var baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: 120000, hash: 'SHA-256' },
      baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encryptBlob(blob, password) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var key = await deriveKey(password, salt);
    var data = await blob.arrayBuffer();
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);

    var head = new TextEncoder().encode(MAGIC);
    var out = new Uint8Array(head.length + 16 + 12 + ct.byteLength);
    out.set(head, 0);
    out.set(salt, head.length);
    out.set(iv, head.length + 16);
    out.set(new Uint8Array(ct), head.length + 16 + 12);
    return new Blob([out], { type: 'application/octet-stream' });
  }

  async function decryptBlob(blob, password) {
    var buf = new Uint8Array(await blob.arrayBuffer());
    var head = new TextDecoder().decode(buf.subarray(0, 8));
    if (head !== MAGIC) throw new Error('不是本 App 加密的文件');
    var salt = buf.subarray(8, 24);
    var iv = buf.subarray(24, 36);
    var ct = buf.subarray(36);
    var key = await deriveKey(password, salt);
    var data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
    return new Blob([data], { type: 'application/zip' });
  }

  /* ---------------- 保存到设备 ---------------- */
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  g.AGV_EXPORT = {
    build: build, saveBlob: saveBlob,
    encryptBlob: encryptBlob, decryptBlob: decryptBlob,
    loadTemplate: loadTemplate, isTemplateLoaded: isTemplateLoaded, baseName: baseName
  };
})(typeof window !== 'undefined' ? window : globalThis);
