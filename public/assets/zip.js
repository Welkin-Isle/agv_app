/* =============================================================================
 * zip.js —— 纯 JS 的 ZIP 读写（无第三方库）
 * =============================================================================
 * 写：全部用 stored(不压缩)，兼容性最好；Excel / Windows 资源管理器 / macOS 归档
 *     工具都能正常打开。代价是体积略大（图片视频本来就是压缩格式，几乎不增）。
 * 读：从中央目录解析条目，用于拿调研表模板里的 sheet1.xml。
 * ========================================================================== */
(function (g) {
  'use strict';

  /* ---------------- CRC32 ---------------- */
  var CRC_TABLE = (function () {
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = -1;
    for (var i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
    return (c ^ -1) >>> 0;
  }

  /* ---------------- 时间戳 → DOS 格式 ---------------- */
  function dosTime(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xFFFF;
  }
  function dosDate(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  var utf8enc = new TextEncoder();

  /* ==========================================================================
   * 写 ZIP
   * entries: [{ name:'a/b.txt', data: Uint8Array|string|Blob, date?:Date }]
   * 返回 Blob（application/zip）
   * ======================================================================== */
  async function writeZip(entries, onProgress) {
    var parts = [];          // Blob 片段
    var central = [];        // 中央目录（Uint8Array）
    var offset = 0;
    var now = new Date();
    var total = entries.length;

    for (var i = 0; i < total; i++) {
      var e = entries[i];
      var nameBuf = utf8enc.encode(e.name);
      var data = await toBytes(e.data);
      if (data === null) continue;

      var crc = crc32(data);
      var dt = e.date || now;
      var t = dosTime(dt), d = dosDate(dt);

      var lh = new Uint8Array(30);
      var dv = new DataView(lh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);          // version needed
      dv.setUint16(6, 0x0800, true);      // flags: UTF-8 文件名
      dv.setUint16(8, 0, true);           // method 0 = stored
      dv.setUint16(10, t, true);
      dv.setUint16(12, d, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBuf.length, true);
      dv.setUint16(28, 0, true);

      parts.push(lh, nameBuf, data);

      var cd = new Uint8Array(46);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, t, true);
      cv.setUint16(14, d, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBuf.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.push(cd, nameBuf);

      offset += lh.length + nameBuf.length + data.length;
      if (onProgress) onProgress(i + 1, total, e.name);
      // 让出主线程，避免大文件时界面卡死
      if (i % 5 === 4) await tick();
    }

    var cdSize = central.reduce(function (s, x) { return s + x.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, total, true);
    ev.setUint16(10, total, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([].concat(parts, central, [eocd]), { type: 'application/zip' });
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  async function toBytes(d) {
    if (d === null || d === undefined) return null;
    if (d instanceof Blob) return new Uint8Array(await d.arrayBuffer());
    if (d instanceof ArrayBuffer) return new Uint8Array(d);
    if (d instanceof Uint8Array) return d;
    if (typeof d === 'string') return utf8enc.encode(d);
    return utf8enc.encode(String(d));
  }

  /* ==========================================================================
   * 读 ZIP（只需解析中央目录 + 取某条目解压）
   * ======================================================================== */
  function readZip(arrayBuffer) {
    var u8 = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);

    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/xlsx');

    var count = dv.getUint16(eocd + 10, true);
    var p = dv.getUint32(eocd + 16, true);
    var entries = [];
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var e = {
        method: dv.getUint16(p + 10, true),
        time: dv.getUint16(p + 12, true),
        date: dv.getUint16(p + 14, true),
        crc: dv.getUint32(p + 16, true),
        compSize: dv.getUint32(p + 20, true),
        uncompSize: dv.getUint32(p + 24, true),
        localOff: dv.getUint32(p + 42, true)
      };
      var nl = dv.getUint16(p + 28, true);
      var el = dv.getUint16(p + 30, true);
      var cl = dv.getUint16(p + 32, true);
      e.name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nl));
      entries.push(e);
      p += 46 + nl + el + cl;
    }

    function raw(e) {
      var lnl = dv.getUint16(e.localOff + 26, true);
      var lel = dv.getUint16(e.localOff + 28, true);
      var start = e.localOff + 30 + lnl + lel;
      return u8.subarray(start, start + e.compSize);
    }
    async function inflate(e) {
      var data = raw(e);
      if (e.method === 0) return data;
      if (e.method === 8) {
        if (typeof DecompressionStream === 'function') {
          var ds = new DecompressionStream('deflate-raw');
          var stream = new Blob([data]).stream().pipeThrough(ds);
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        throw new Error('浏览器不支持 DecompressionStream，无法解压 xlsx 内部条目');
      }
      throw new Error('不支持的压缩方式: ' + e.method);
    }

    return { entries: entries, find: function (n) { return entries.filter(function (x) { return x.name === n; })[0]; }, raw: raw, inflate: inflate, bytes: u8 };
  }

  /* ==========================================================================
   * 重打包 xlsx：保留除被替换条目外的所有原始压缩字节
   *   src: 原始 xlsx 的 ArrayBuffer
   *   replace: { 'xl/worksheets/sheet1.xml': Uint8Array(新内容) }
   * ======================================================================== */
  function repackZip(srcBuf, replace) {
    var z = readZip(srcBuf);
    var dv = new DataView(srcBuf);
    var parts = [];
    var central = [];
    var offset = 0;

    z.entries.forEach(function (e) {
      var nameBuf = utf8enc.encode(e.name);
      var isReplaced = Object.prototype.hasOwnProperty.call(replace, e.name);
      var method, crc, comp, uncompLen;

      if (isReplaced) {
        var nd = replace[e.name];
        method = 0; crc = crc32(nd); comp = nd; uncompLen = nd.length;
      } else {
        var raw = z.raw(e);
        // 原样拷贝：压缩方法、CRC、尺寸、压缩字节全部照搬
        method = e.method; crc = e.crc; comp = raw; uncompLen = e.uncompSize;
      }

      var lh = new Uint8Array(30);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, e.time, true);
      lv.setUint16(12, e.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, comp.length, true);
      lv.setUint32(22, uncompLen, true);
      lv.setUint16(26, nameBuf.length, true);
      lv.setUint16(28, 0, true);
      parts.push(lh, nameBuf, comp);

      var cd = new Uint8Array(46);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, e.time, true);
      cv.setUint16(14, e.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, comp.length, true);
      cv.setUint32(24, uncompLen, true);
      cv.setUint16(28, nameBuf.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      central.push(cd, nameBuf);

      offset += lh.length + nameBuf.length + comp.length;
    });

    var cdSize = central.reduce(function (s, x) { return s + x.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, z.entries.length, true);
    ev.setUint16(10, z.entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([].concat(parts, central, [eocd]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  g.AGV_ZIP = { writeZip: writeZip, readZip: readZip, repackZip: repackZip, crc32: crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
