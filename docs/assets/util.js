/* =============================================================================
 * util.js —— 客户页与内部页共用的格式化工具
 * ========================================================================== */
(function (g) {
  'use strict';

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim() === '';
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') {
      if (v.m === 'unknown') return false;             // "不确定" 是有效回答
      if (v.m === 'single' || v.m === 'ge' || v.m === 'le') return !isNum(v.v);
      if (v.m === 'range') return !isNum(v.a) && !isNum(v.b);
      return Object.keys(v).length === 0;
    }
    return false;
  }
  function isNum(x) { return x !== null && x !== undefined && x !== '' && !isNaN(Number(x)); }

  /* 数值答案 → 人类可读 */
  function fmtNumber(v, unit) {
    var u = unit ? ' ' + unit : '';
    if (!v || typeof v !== 'object') return v === '' || v === null || v === undefined ? '' : String(v);
    switch (v.m) {
      case 'single': return isNum(v.v) ? v.v + u : '';
      case 'range':
        if (isNum(v.a) && isNum(v.b)) return v.a + ' ~ ' + v.b + u;
        if (isNum(v.a)) return '≥ ' + v.a + u;
        if (isNum(v.b)) return '≤ ' + v.b + u;
        return '';
      case 'ge': return isNum(v.v) ? '≥ ' + v.v + u : '';
      case 'le': return isNum(v.v) ? '≤ ' + v.v + u : '';
      case 'unknown': return '不确定 / 待确认';
      default: return '';
    }
  }

  /* 任意字段答案 → 人类可读 */
  function fmtAnswer(field, val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) return val.join('、');
    if (field) {
      if (field.type === 'place_layers') {
        var pl = (val && val.place) ? val.place : '';
        var pn = (val && isNum(val.n)) ? val.n + ' 层' : '';
        return [pl, pn].filter(Boolean).join(' · ');
      }
      if (field.type === 'number') return fmtNumber(val, field.unit);
      if (field.type === 'multi') return Array.isArray(val) ? val.join('、') : String(val);
    }
    if (typeof val === 'object') return fmtNumber(val, field && field.unit);
    return String(val);
  }

  function fileSize(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var p = function (x) { return x < 10 ? '0' + x : '' + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  g.AGV_UTIL = {
    esc: esc, debounce: debounce, isEmpty: isEmpty, isNum: isNum,
    fmtNumber: fmtNumber, fmtAnswer: fmtAnswer,
    fileSize: fileSize, fmtTime: fmtTime
  };
})(typeof window !== 'undefined' ? window : globalThis);
