/* =============================================================================
 * controls.js —— 字段控件库
 * =============================================================================
 * 关键设计：**结构性变化立即重绘**（模式切换 / 下拉改选 / 多选点击 / 选中"其它"），
 *          **打字不重绘**（避免输入框失焦、光标跳动）。
 * 这解决了"改了精确值/范围、按钮颜色要退出重进才生效"的问题。
 *
 * 入口：renderField(field, value, onChange, ctx)
 *   ctx = {
 *     refOptions(refId) -> [{value,label}]   引用型下拉（material / carrier / place）
 *     placeOptions()    -> [{value,label}]   地点下拉（place_layers 用）
 *   }
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

  var MODE_LABEL = { single: '精确值', range: '范围', ge: '大于等于', le: '小于等于', unknown: '不确定' };

  /* ============================ 数值控件 ============================ */
  function numBody(field, v, soft) {
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
      return body;
    }
    if (v.m === 'range') {
      body.appendChild(mkInput('最小值', v.a, function (x) { soft({ m: 'range', a: x, b: v.b }); }));
      var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '~';
      body.appendChild(sep);
      body.appendChild(mkInput('最大值', v.b, function (x) { soft({ m: 'range', a: v.a, b: x }); }));
      if (unitEl) body.appendChild(unitEl);
      return body;
    }
    if (v.m === 'ge') {
      var ge = document.createElement('span'); ge.className = 'sep'; ge.textContent = '≥';
      body.appendChild(ge);
      body.appendChild(mkInput('最小值', v.v, function (x) { soft({ m: 'ge', v: x }); }));
      if (unitEl) body.appendChild(unitEl);
      return body;
    }
    if (v.m === 'le') {
      var le = document.createElement('span'); le.className = 'sep'; le.textContent = '≤';
      body.appendChild(le);
      body.appendChild(mkInput('最大值', v.v, function (x) { soft({ m: 'le', v: x }); }));
      if (unitEl) body.appendChild(unitEl);
      return body;
    }
    body.appendChild(mkInput(field.placeholder || '请输入', v.v, function (x) { soft({ m: 'single', v: x }); }));
    if (unitEl) body.appendChild(unitEl);
    return body;
  }

  function numControl(field, v, soft, struct) {
    var wrap = document.createElement('div');
    wrap.className = 'numctl';
    var modes = field.modes || ['single'];

    // 关键：值可能为空（默认 single），但字段只允许某一种模式时，
    // 必须按"允许的第一个模式"渲染，否则温度/坡度会误显示成精确值输入框。
    if (modes.indexOf(v.m) < 0) {
      var m0 = modes[0];
      if (m0 === 'range') v = { m: 'range', a: null, b: null };
      else if (m0 === 'unknown') v = { m: 'unknown' };
      else v = { m: m0, v: null };
    }

    if (modes.length > 1) {
      var bar = document.createElement('div');
      bar.className = 'modes';
      modes.forEach(function (m) {
        var s = document.createElement('span');
        s.textContent = MODE_LABEL[m] || m;
        if (v.m === m) s.className = 'on';
        s.onclick = function () {
          if (m === 'unknown') { struct({ m: 'unknown' }); return; }
          var next = { m: m };
          if (m === 'range') {
            next.a = v.a !== undefined ? v.a : (v.v !== undefined ? v.v : null);
            next.b = v.b !== undefined ? v.b : null;
          } else if (m === 'le') {
            next.v = v.v !== undefined ? v.v : (v.b !== undefined ? v.b : null);
          } else {
            next.v = v.v !== undefined ? v.v : (v.a !== undefined ? v.a : null);
          }
          struct(next);
        };
        bar.appendChild(s);
      });
      wrap.appendChild(bar);
    }
    wrap.appendChild(numBody(field, v, soft));
    return wrap;
  }

  /* ============================ 引用型下拉 ============================ */
  function refControl(field, value, struct, ctx) {
    var wrap = document.createElement('div');
    var opts = (ctx && ctx.refOptions) ? (ctx.refOptions(field.ref) || []) : [];
    var sel = document.createElement('select');
    var cur = value == null ? '' : String(value);
    var html = ['<option value="">请选择…</option>'];
    var found = false;
    opts.forEach(function (o) {
      if (o.value === cur) found = true;
      html.push('<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' +
        esc(o.label) + '</option>');
    });
    if (cur && !found) html.push('<option value="' + esc(cur) + '" selected>' + esc(cur) + '（已不存在）</option>');
    sel.innerHTML = html.join('');
    sel.addEventListener('change', function () { struct(sel.value); });
    wrap.appendChild(sel);
    if (!opts.length) {
      var tip = document.createElement('div');
      tip.className = 'fhint';
      tip.textContent = field.ref === 'place'
        ? '还没有地点，请先在上方「地点清单」里添加'
        : '还没有可选项，请先去对应模块添加';
      wrap.appendChild(tip);
    }
    return wrap;
  }

  /* ============================ 地点 + 层数 ============================ */
  function placeLayersControl(field, value, soft, struct, ctx) {
    var v = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
    var wrap = document.createElement('div');
    var row = document.createElement('div');
    row.className = 'pl-row';

    var opts = (ctx && ctx.placeOptions) ? (ctx.placeOptions() || []) : [];
    var sel = document.createElement('select');
    var cur = v.place == null ? '' : String(v.place);
    var html = ['<option value="">选择地点…</option>'];
    var found = false;
    opts.forEach(function (o) {
      if (o.value === cur) found = true;
      html.push('<option value="' + esc(o.value) + '"' + (o.value === cur ? ' selected' : '') + '>' + esc(o.label) + '</option>');
    });
    if (cur && !found) html.push('<option value="' + esc(cur) + '" selected>' + esc(cur) + '（已不存在）</option>');
    sel.innerHTML = html.join('');
    sel.addEventListener('change', function () {
      struct({ place: sel.value, n: v.n === undefined ? null : v.n });
    });
    row.appendChild(sel);

    var numWrap = document.createElement('div');
    numWrap.className = 'pl-num';
    var inp = document.createElement('input');
    inp.type = 'number'; inp.inputMode = 'numeric'; inp.placeholder = '层数';
    if (isNum(v.n)) inp.value = v.n;
    inp.addEventListener('input', function () {
      var x = inp.value === '' ? null : Number(inp.value);
      soft({ place: v.place || '', n: isNaN(x) ? null : x });
    });
    numWrap.appendChild(inp);
    var unit = document.createElement('span');
    unit.className = 'unit';
    unit.textContent = '层';
    numWrap.appendChild(unit);
    row.appendChild(numWrap);
    wrap.appendChild(row);

    if (!opts.length) {
      var tip = document.createElement('div');
      tip.className = 'fhint';
      tip.textContent = '还没有地点，请先去「物流流程」里添加地点';
      wrap.appendChild(tip);
    }
    return wrap;
  }

  /* ============================ 主入口 ============================ */
  function renderField(field, value, onChange, ctx, opts) {
    opts = opts || {};
    var box = document.createElement('div');
    box.className = 'field' + (field.wide || field.type === 'textarea' ? ' wide' : '') + (opts.compact ? ' compact' : '');
    var cur = value;

    function paint() { box.innerHTML = ''; build(); }
    // 结构性变化：写入 + 重绘（让模式/选中态立刻可见）
    function struct(v) { cur = v; onChange(v); paint(); }
    // 打字：只写入，不重绘（避免失焦）
    function soft(v) { cur = v; onChange(v); }

    function build() {
      var lb = document.createElement('label');
      lb.className = 'flabel';
      lb.innerHTML = esc(field.label) + (field.required ? '<span class="req">*</span>' : '');
      box.appendChild(lb);

      if (field.type === 'textarea') {
        var ta = document.createElement('textarea');
        ta.placeholder = field.placeholder || '';
        ta.value = cur || '';
        ta.addEventListener('input', function () { soft(ta.value); });
        box.appendChild(ta);

      } else if (field.type === 'number') {
        box.appendChild(numControl(field, numVal(cur), soft, struct));

      } else if (field.type === 'ref') {
        box.appendChild(refControl(field, cur, struct, ctx));

      } else if (field.type === 'place_layers') {
        box.appendChild(placeLayersControl(field, cur, soft, struct, ctx));

      } else if (field.type === 'select') {
        var sel = document.createElement('select');
        var s = cur == null ? '' : String(cur);
        var isOther = s.indexOf('其它（') === 0;
        var list = ['<option value="">请选择…</option>'];
        (field.options || []).forEach(function (o) {
          list.push('<option value="' + esc(o) + '"' + (s === o ? ' selected' : '') + '>' + esc(o) + '</option>');
        });
        if (field.allowOther) {
          list.push('<option value="__other"' + (isOther ? ' selected' : '') + '>其它（请说明）</option>');
        }
        sel.innerHTML = list.join('');
        sel.addEventListener('change', function () {
          struct(sel.value === '__other' ? '其它（）' : sel.value);
        });
        box.appendChild(sel);

        // 选中"其它" → 立刻弹说明输入框
        if (field.allowOther && isOther) {
          var ob = document.createElement('div');
          ob.className = 'other-box';
          var ol = document.createElement('div');
          ol.className = 'other-label';
          ol.textContent = '说明内容';
          ob.appendChild(ol);
          var oi = document.createElement('input');
          oi.type = 'text';
          oi.placeholder = '请填写具体内容';
          oi.value = s.slice(3, -1);
          oi.addEventListener('input', function () { soft('其它（' + oi.value + '）'); });
          ob.appendChild(oi);
          box.appendChild(ob);
        }

      } else if (field.type === 'multi') {
        var chips = document.createElement('div');
        chips.className = 'chips';
        var arr = Array.isArray(cur) ? cur.slice() : [];
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
            struct(arr.slice());
          };
          chips.appendChild(c);
        });
        box.appendChild(chips);

      } else {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = field.placeholder || '';
        inp.value = cur || '';
        inp.addEventListener('input', function () { soft(inp.value); });
        box.appendChild(inp);
      }

      if (field.hint) {
        var h = document.createElement('div');
        h.className = 'fhint';
        h.textContent = field.hint;
        box.appendChild(h);
      }
    }

    paint();
    return box;
  }

  g.AGV_CTRL = { renderField: renderField, numVal: numVal };
})(typeof window !== 'undefined' ? window : globalThis);
