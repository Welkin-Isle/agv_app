/* =============================================================================
 * project.js —— 方案工作台（模块卡片式，点卡片进入该模块）
 * ========================================================================== */
(function () {
  'use strict';
  var DB = window.AGV_DB, U = window.AGV_UTIL, S = window.AGV_SCHEMA;
  var M = window.AGV_MEDIA, EX = window.AGV_EXPORT, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };

  var qs = new URLSearchParams(location.search);
  var pid = qs.get('id');
  var state = { project: null, media: [] };

  // 内联 SVG 图标（不用 emoji：Windows/安卓/iOS 的 emoji 字形大小不一致）
  var PATHS = {
    basic: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1"/><path d="M9 10h6M9 14h6M9 18h4"/>',
    material: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/>',
    carrier: '<path d="M3 7h10v8H3z"/><path d="M13 10h4l3 3v2h-7z"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/>',
    combo: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M8 6v4M12 6v6M16 6v4"/>',
    flow: '<path d="M4 8h12l-3-3"/><path d="M20 16H8l3 3"/>',
    process: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    site: '<path d="M3 20h18"/><path d="M4 20V10l5 3V10l5 3V8h6v12"/>',
    system: '<path d="M9 3v6M15 3v6"/><path d="M6 9h12v2a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
    extra: '<path d="M12 3.5l2.6 5.3 5.9.8-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.6l5.9-.8z"/>',
    other: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>',
    media: '<path d="M8 12V7a4 4 0 0 1 8 0v9a3 3 0 0 1-6 0V8"/>'
  };
  function icon(id) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (PATHS[id] || PATHS.other) + '</svg>';
  }

  /* ---------------- 完整度计算 ---------------- */
  function moduleStat(stepId) {
    var st = S.steps.filter(function (x) { return x.id === stepId; })[0];
    if (!st) return { filled: 0, total: 0, has: false };
    var ans = state.project.answers || {};
    var filled = 0, total = 0;

    (st.groups || []).forEach(function (grp) {
      var store = ans[grp.id] || {};
      grp.fields.forEach(function (f) {
        total++;
        if (!U.isEmpty(store[f.key])) filled++;
      });
    });
    if (st.repeat) {
      var arr = ans[st.repeat.id] || [];
      if (!arr.length) arr = [{}];
      // 每组的"引用"字段也算一项
      (st.repeat.fields).forEach(function (f) { total++; });
      (st.repeat.refs || []).forEach(function () { total++; });
      arr.forEach(function (it) {
        st.repeat.fields.forEach(function (f) { if (!U.isEmpty(it[f.key])) filled++; });
        (st.repeat.refs || []).forEach(function (rf) { if (it[rf.key]) filled++; });
      });
    }
    return { filled: filled, total: total, has: filled > 0 };
  }

  function mediaStat() {
    var n = state.media.length;
    return { filled: n, total: n || 1, has: n > 0 };
  }

  function overallPct() {
    var mods = S.steps.map(function (st) { return moduleStat(st.id); }).concat([mediaStat()]);
    var done = mods.filter(function (m) { return m.has; }).length;
    return Math.round(done / mods.length * 100);
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    var p = state.project;
    document.title = (p.customer || '方案') + ' · 工作台';
    $('ttl').textContent = p.customer || p.name || '(未命名方案)';
    var pct = overallPct();
    $('sub').innerHTML = esc(p.name || '') +
      (p.name ? '　·　' : '') + '完成度 ' + pct + '%　·　' +
      (p.status === 'done' ? '已完成' : '草稿');

    var main = $('main');
    main.innerHTML = '';

    // 顶部摘要
    var sum = document.createElement('div');
    sum.className = 'card';
    sum.style.marginBottom = '14px';
    sum.innerHTML =
      '<div class="row-flex" style="justify-content:space-between">' +
        '<div><div style="font-size:12px;color:var(--ink2)">整体完成度</div>' +
        '<div style="font-size:26px;font-weight:800;color:var(--brand-2);line-height:1.1">' + pct + '%</div></div>' +
        '<div style="text-align:right" class="tiny">' +
          '最后修改<br>' + esc(U.fmtTime(p.updatedAt)) +
          (p.lastBackupAt ? '<br>已备份' : '<br><span style="color:var(--warn)">未备份</span>') +
        '</div></div>' +
      '<div class="pbar mt12"><i style="width:' + pct + '%"></i></div>';

    if (!p.lastBackupAt || (Date.now() - new Date(p.lastBackupAt).getTime()) > 7 * 86400000) {
      var warn = document.createElement('div');
      warn.className = 'banner warn mt12';
      warn.innerHTML = '<span class="grow">本方案还没导出过备份，数据只在这台设备上。</span>';
      sum.appendChild(warn);
    }
    main.appendChild(sum);

    // 模块九宫格
    var gridWrap = document.createElement('div');
    gridWrap.className = 'card';
    gridWrap.innerHTML = '<div class="panel-head" style="margin-bottom:12px"><h2>点击模块开始记录</h2></div>';
    var grid = document.createElement('div');
    grid.className = 'mod-grid';

    S.steps.forEach(function (st) {
      grid.appendChild(modCard(st.id, st.no + '. ' + st.title, st.id, moduleStat(st.id)));
    });
    grid.appendChild(modCard('media', '附件', 'media', mediaStat()));
    gridWrap.appendChild(grid);
    main.appendChild(gridWrap);

    // 提示
    var tip = document.createElement('div');
    tip.className = 'notice info';
    tip.innerHTML = '提示：现场来不及归类时，用底部「📷 快速记录」先拍照，之后在「附件」里改备注即可。';
    main.appendChild(tip);
  }

  function modCard(id, title, iconId, stat) {
    var cls = 'mod';
    if (stat.has) cls += (stat.filled >= stat.total ? ' done' : ' part');
    var el = document.createElement('div');
    el.className = cls;
    el.onclick = function () { location.href = 'module.html?id=' + encodeURIComponent(pid) + '&m=' + id; };
    var frac = stat.has ? (stat.filled + '/' + stat.total) : '';
    var label = stat.has ? (stat.filled >= stat.total ? '已完成' : '待补充') : '未填写';
    el.innerHTML =
      '<span class="cnt">' + frac + '</span>' +
      '<div><div class="ico">' + icon(iconId) + '</div><div class="nm">' + esc(title) + '</div></div>' +
      '<div class="st"><span class="dot"></span>' + label + '</div>';
    return el;
  }

  /* ---------------- 快速记录 ---------------- */
  $('btn-quick').onclick = function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async function () {
      var files = Array.from(input.files || []);
      input.remove();
      if (!files.length) return;
      var n = 0;
      for (var i = 0; i < files.length; i++) {
        try {
          var c = await M.compressImage(files[i]);
          await DB.addMedia({
            projectId: pid, zone: 'temp', kind: 'image',
            name: c.name, mime: c.mime, size: c.size,
            blob: c.blob, thumb: c.thumb, w: c.w, h: c.h
          });
          n++;
        } catch (e) { alert('照片处理失败：' + e.message); }
      }
      await reload();
      if (n) toast('已记录 ' + n + ' 张，稍后可在「附件」里补充说明');
    };
    input.click();
  };

  function toast(msg) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:90;' +
      'background:rgba(15,23,42,.88);color:#fff;padding:10px 16px;border-radius:10px;font-size:13px;max-width:86%';
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 2200);
  }

  /* ---------------- 导出 ---------------- */
  $('btn-export').onclick = async function () {
    var p = state.project;
    if (!p.customer && !p.name) { alert('请先填写客户名称'); return; }
    var hasVideo = state.media.some(function (m) { return m.zone === 'videos'; });
    var totalSize = state.media.reduce(function (s, m) { return s + (m.size || 0); }, 0);
    var big = totalSize > 50 * 1048576;

    var msg = '导出内容：\n· 调研表 xlsx\n· 照片/视频 ' + state.media.length + ' 个（约 ' +
      U.fileSize(totalSize) + '）\n· 原始数据 answers.json\n\n';
    if (big || hasVideo) msg += '附件较大，建议「分包导出」：表格+照片 一个包，视频 单独一个包。\n\n';
    msg += '继续导出？';
    if (!confirm(msg)) return;

    var split = (big || hasVideo) ? confirm('是否分包导出？（推荐：iOS 上更稳）\n确定=分包　取消=打成一个大包') : false;

    var btn = $('btn-export');
    btn.disabled = true; btn.textContent = '打包中…';
    try {
      var res = await EX.build({
        project: p, answers: p.answers || {}, media: state.media,
        includeVideos: true, splitVideo: split
      });
      res.files.forEach(function (f) { EX.saveBlob(f.blob, f.name); });
      p.lastBackupAt = new Date().toISOString();
      p.exportedAt = p.lastBackupAt;
      await DB.putProject(p);
      await DB.setSetting('lastBackupAt', new Date().toISOString());
      await reload();
      toast('已导出 ' + res.files.length + ' 个文件，共 ' + U.fileSize(res.total));
    } catch (e) {
      alert('导出失败：' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '导出';
    }
  };

  /* ---------------- 更多 ---------------- */
  /* 加密导出：产物为 <原名>.zip.enc（AES-GCM 256） */
  async function encryptedExport() {
    var pw = prompt('设置一个口令（解密时需要，请务必记住）');
    if (!pw) return;
    if (pw.length < 6) { alert('口令至少 6 位'); return; }
    var pw2 = prompt('再输一次确认');
    if (pw2 !== pw) { alert('两次输入不一致'); return; }

    var btn = $('btn-export');
    btn.disabled = true; btn.textContent = '加密打包中…';
    try {
      var res = await EX.build({
        project: state.project, answers: state.project.answers || {},
        media: state.media, includeVideos: true, splitVideo: false
      });
      for (var i = 0; i < res.files.length; i++) {
        var f = res.files[i];
        var enc = await EX.encryptBlob(f.blob, pw);
        EX.saveBlob(enc, f.name + '.enc');
      }
      state.project.lastBackupAt = new Date().toISOString();
      await DB.putProject(state.project);
      await DB.setSetting('lastBackupAt', new Date().toISOString());
      await reload();
      toast('已加密导出，共 ' + res.files.length + ' 个文件（.zip.enc）');
    } catch (e) {
      alert('加密导出失败：' + e.message);
    } finally {
      btn.disabled = false; btn.textContent = '导出';
    }
  }

  $('btn-more').onclick = function () {
    var body = $('sheet-body');
    body.innerHTML = '';
    body.appendChild(item('标记为已完成 / 改回草稿', '仅影响状态显示', async function () {
      closeSheet();
      state.project.status = state.project.status === 'done' ? 'draft' : 'done';
      await DB.putProject(state.project);
      render();
    }));
    body.appendChild(item('重命名方案', '客户名 / 项目名', async function () {
      closeSheet();
      var c = prompt('客户名称', state.project.customer || '');
      if (c === null) return;
      var n = prompt('项目名称', state.project.name || '');
      if (n === null) return;
      state.project.customer = c.trim();
      state.project.name = n.trim();
      await DB.putProject(state.project);
      render();
    }));
    body.appendChild(item('加密导出', '设一个口令，导出 .zip.enc（适合微信/网盘传敏感资料）', async function () {
      closeSheet();
      await encryptedExport();
    }));
    body.appendChild(item('删除这个方案', '连同照片视频一起删除，不可恢复', async function () {
      closeSheet();
      if (!confirm('确认删除「' + (state.project.customer || '未命名') + '」？\n所有已填内容和附件都会删除，无法恢复。')) return;
      await DB.deleteProject(pid);
      location.href = 'index.html';
    }));
    $('sheet').classList.remove('hidden');
  };
  $('sheet-close').onclick = closeSheet;
  $('sheet').onclick = function (e) { if (e.target === $('sheet')) closeSheet(); };
  function closeSheet() { $('sheet').classList.add('hidden'); }
  function item(t, d, fn) {
    var b = document.createElement('button');
    b.className = 'btn';
    b.style.cssText = 'width:100%;text-align:left;margin-bottom:9px;padding:13px 15px';
    b.innerHTML = '<div style="font-weight:650">' + esc(t) + '</div>' +
      '<div class="tiny" style="margin-top:3px">' + esc(d) + '</div>';
    b.onclick = fn;
    return b;
  }

  $('btn-back').onclick = function () { location.href = 'index.html'; };

  /* ---------------- 启动 ---------------- */
  async function reload() {
    state.project = await DB.getProject(pid);
    state.media = await DB.listMedia(pid);
    if (!state.project) {
      $('main').innerHTML = '<div class="notice bad">方案不存在或已被删除</div>';
      return;
    }
    render();
  }

  (async function boot() {
    if (!pid) { $('main').innerHTML = '<div class="notice bad">缺少方案 ID</div>'; return; }
    try { await reload(); }
    catch (e) {
      $('main').innerHTML = '<div class="notice bad">加载失败：' + esc(e.message) + '</div>';
    }
  })();

  // 从模块页返回时刷新
  window.addEventListener('pageshow', function (e) { if (e.persisted) reload(); });
})();
