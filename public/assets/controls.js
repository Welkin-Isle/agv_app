/* =============================================================================
 * controls.js —— 字段控件库（模块编辑页复用）
 * =============================================================================
 * 提供 renderField(field, value, onChange) → DOM
 * 数值字段支持四种回答方式：精确值 / 范围 / 大于等于 / 不确定（不用滑块）
 * ========================================================================== */
(function (g) {
  'use strict';
  var U = g.AGV_UTIL, esc = U.esc;

  function isNum(x) { return x !== null && x !== undefined && x !== '' && !isNaN(Number(x)); }

  function numVal(v) {
    if (v && typeof v === 'object' && v.m) return v;
    if (isNum(v)) return { m: 'single', v: Number(v) };
    return { m: 'single' };
  }

  function numControl(field, value, onChange) {
    var v = numVal(value);
    var modes = field.modes || ['single'];
    var wrap = document.createElement('div');
    wrap.className = 'numctl';

    if (modes.length > 1) {
      var bar = document.createElement('div');
      bar.className = 'modes';
      var LABELS = { single: '精确值', range: '范围', ge: '大于等于', unknown: '不确定' };
      modes.forEach(function (m) {
        var s = document.createElement('span');
        s.textContent = LABELS[m] || m;
        if (v.m === m) s.className = 'on';
        s.onclick = function () {
          if (m === 'unknown') { onChange({ m: 'unknown' }); return; }
          var next = { m: m };
          if (m === 'range') {
            next.a = v.a !== undefined ? v.a : (v.v !== undefined ? v.v : null);
            next.b = v.b !== undefined ? v.b : null;
          } else {
            next.v = v.v !== undefined ? v.v : (v.a !== undefined ? v.a : null);
          }
          onChange(next);
        };
        bar.appendChild(s);
      });
      wrap.appendChild(bar);
    }

    var body = document.createElement('div');
    body.className = 'mode-body';

    function mkInput(ph, val, cb) {
      var i = document.createElement('input');
      i.type = 'number'; i.inputMode = 'decimal'; i.placeholder = ph;
      if (val !== null && val !== undefined && !isNaN(val)) i.value = val;
      i.addEventListener('input', function () {
        var x = i.value === '' ? null : Number(i.value);
        cb(isNaN(x) ? null : x);
      });
      return i;
    }

    var unitEl = null;
    if (field.unit) {
      unitEl = document.createElement('span');
      unitEl.className = 'unit';
      unitEl.textContent = field.unit;
    }

    if (v.m === 'unknown') {
      var tip = document.createElement('div');
      tip.className = 'fhint';
      tip.textContent = '已标记为「不确定」，导出时会注明，便于后续确认。';
      body.appendChild(tip);
    } else if (v.m === 'range') {
      body.appendChild(mkInput('最小值', v.a, function (x) { onChange({ m: 'range', a: x, b: v.b }); }));
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '~';
      body.appendChild(sep);
      body.appendChild(mkInput('最大值', v.b, function (x) { onChange({ m: 'range', a: v.a, b: x }); }));
      if (unitEl) body.appendChild(unitEl);
    } else if (v.m === 'ge') {
      var ge = document.createElement('span'); ge.className = 'sep'; ge.textContent = '≥';
      body.appendChild(ge);
      body.appendChild(mkInput('最小值', v.v, function (x) { onChange({ m: 'ge', v: x }); }));
      if (unitEl) body.appendChild(unitEl);
    } else {
      body.appendChild(mkInput(field.placeholder || '请输入', v.v, function (x) { onChange({ m: 'single', v: x }); }));
      if (unitEl) body.appendChild(unitEl);
    }
    wrap.appendChild(body);
    return wrap;
  }

  function renderField(field, value, onChange) {
    var box = document.createElement('div');
    box.className = 'field' + (field.wide || field.type === 'textarea' ? ' wide' : '');

    var lb = document.createElement('label');
    lb.className = 'flabel';
    lb.innerHTML = esc(field.label) + (field.required ? '<span class="req">*</span>' : '');
    box.appendChild(lb);

    if (field.type === 'textarea') {
      var ta = document.createElement('textarea');
      ta.placeholder = field.placeholder || '';
      ta.value = value || '';
      ta.addEventListener('input', function () { onChange(ta.value); });
      box.appendChild(ta);

    } else if (field.type === 'number') {
      box.appendChild(numControl(field, value, onChange));

    } else if (field.type === 'select') {
      var sel = document.createElement('select');
      var cur = value == null ? '' : String(value);
      var opts = ['<option value="">请选择…</option>'];
      (field.options || []).forEach(function (o) {
        opts.push('<option value="' + esc(o) + '"' + (cur === o ? ' selected' : '') + '>' + esc(o) + '</option>');
      });
      if (field.allowOther) {
        opts.push('<option value="__other"' + (cur.indexOf('其它（') === 0 ? ' selected' : '') + '>其它（请说明）</option>');
      }
      sel.innerHTML = opts.join('');
      sel.addEventListener('change', function () {
        onChange(sel.value === '__other' ? '其它（）' : sel.value);
      });
      box.appendChild(sel);

      if (field.allowOther && cur.indexOf('其它（') === 0) {
        var extra = document.createElement('input');
        extra.type = 'text';
        extra.className = 'other-input';
        extra.placeholder = '请说明具体是什么';
        extra.value = cur.slice(3, -1);
        extra.addEventListener('input', function () { onChange('其它（' + extra.value + '）'); });
        box.appendChild(extra);
      }

    } else if (field.type === 'multi') {
      var chips = document.createElement('div');
      chips.className = 'chips';
      var arr = Array.isArray(value) ? value.slice() : [];
      (field.options || []).forEach(function (o) {
        var c = document.createElement('span');
        c.className = 'chip' + (arr.indexOf(o) >= 0 ? ' on' : '');
        c.textContent = o;
        c.onclick = function () {
          var i = arr.indexOf(o);
          var exclusive = (o === '无' || o === '常规');
          if (exclusive) {
            arr = (i >= 0) ? [] : [o];
          } else {
            ['无', '常规'].forEach(function (x) {
              var j = arr.indexOf(x); if (j >= 0) arr.splice(j, 1);
            });
            if (i >= 0) arr.splice(arr.indexOf(o), 1); else arr.push(o);
          }
          onChange(arr.slice());
        };
        chips.appendChild(c);
      });
      box.appendChild(chips);

    } else {
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = field.placeholder || '';
      inp.value = value || '';
      inp.addEventListener('input', function () { onChange(inp.value); });
      box.appendChild(inp);
    }

    if (field.hint) {
      var h = document.createElement('div');
      h.className = 'fhint';
      h.textContent = field.hint;
      box.appendChild(h);
    }
    return box;
  }

  g.AGV_CTRL = { renderField: renderField, numControl: numControl, numVal: numVal };
})(typeof window !== 'undefined' ? window : globalThis);
