/* =============================================================================
 * home.js —— 首页：方案列表 / 新建 / 备份提醒 / 导出全部
 * ========================================================================== */
(function () {
  'use strict';
  var DB = window.AGV_DB, U = window.AGV_UTIL, EX = window.AGV_EXPORT, esc = U.esc;
  var $ = function (id) { return document.getElementById(id); };

  var DAY = 86400000;

  /* ---------------- 完成度 ---------------- */
  function completeness(answers) {
    var S = window.AGV_SCHEMA, total = 0, filled = 0;
    S.steps.forEach(function (st) {
      (st.groups || []).forEach(function (grp) {
        var store = answers[grp.id] || {};
        grp.fields.forEach(function (f) {
          if (!f.required) return;                  // 完成度只算必填，避免 59 个字段永远显示低
          total++; if (!U.isEmpty(store[f.key])) filled++;
        });
      });
      if (st.repeat) {
        (st.repeat.refs || []).forEach(function () { total++; });
      }
    });
    // 必填很少，改用"模块有内容"的口径更直观
    var mods = S.steps.length, doneMods = 0;
    S.steps.forEach(function (st) {
      if (moduleHasContent(st, answers)) doneMods++;
    });
    return Math.round(doneMods / mods * 100);
  }

  function moduleHasContent(st, answers) {
    var any = false;
    (st.groups || []).forEach(function (grp) {
      var store = answers[grp.id] || {};
      grp.fields.forEach(function (f) { if (!U.isEmpty(store[f.key])) any = true; });
    });
    if (st.repeat) {
      var arr = answers[st.repeat.id] || [];
      arr.forEach(function (it) {
        st.repeat.fields.forEach(function (f) { if (!U.isEmpty(it[f.key])) any = true; });
      });
    }
    return any;
  }

  /* ---------------- 渲染 ---------------- */
  async function render() {
    var list = await DB.listProjects();
    var main = $('main');
    main.innerHTML = '';

    // 备份提醒
    var lastBackup = await DB.getSetting('lastBackupAt', null);
    if (list.length) {
      main.appendChild(backupBanner(lastBackup, list));
    }

    // 首次使用说明
    if (!list.length) {
      var intro = document.createElement('div');
      intro.className = 'notice info';
      intro.innerHTML = '<b>欢迎使用「AGV 现场记录」</b><br>' +
        '本应用的所有内容 <b>只保存在这台设备里</b>，不会上传到任何服务器。' +
        '请定期用「⋯ → 导出备份」把数据存到网盘或电脑，换设备/清缓存后数据无法恢复。';
      main.appendChild(intro);
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML = '还没有方案<br><span class="tiny">点下方「＋ 新建方案」开始</span>';
      main.appendChild(empty);
      $('actions').classList.remove('hidden');
      return;
    }

    list.forEach(function (p) {
      main.appendChild(projectCard(p));
    });
    $('actions').classList.remove('hidden');
  }

  function backupBanner(lastBackup, list) {
    var d = document.createElement('div');
    var days = lastBackup ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / DAY) : null;
    if (days === null) {
      d.className = 'banner warn';
      d.innerHTML = '<span class="grow">从未备份过。数据只在本机，建议现在导出一次。</span>';
    } else if (days >= 7) {
      d.className = 'banner bad';
      d.innerHTML = '<span class="grow">⚠ 已 <b>' + days + '</b> 天未备份。手机丢失/清缓存会全部丢失。</span>';
    } else if (days >= 3) {
      d.className = 'banner warn';
      d.innerHTML = '<span class="grow">上次备份 ' + days + ' 天前，建议今天再备份一次。</span>';
    } else {
      d.className = 'banner ok';
      d.innerHTML = '<span class="grow">上次备份：' + (days === 0 ? '今天' : days + ' 天前') + ' ✓</span>';
    }
    var b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = '导出备份';
    b.onclick = function () { exportAll(list); };
    d.appendChild(b);
    return d;
  }

  function projectCard(p) {
    var pct = completeness(p.answers || {});
    var a = document.createElement('a');
    a.className = 'pcard';
    a.href = 'project.html?id=' + encodeURIComponent(p.id);
    a.innerHTML =
      '<div class="row1">' +
        '<div style="min-width:0">' +
          '<div class="who">' + esc(p.customer || p.name || '(未命名方案)') + '</div>' +
          (p.name && p.customer ? '<div class="what">' + esc(p.name) + '</div>' : '') +
        '</div>' +
        '<span class="pill ' + (p.status === 'done' ? 'done' : 'draft') + '">' +
          (p.status === 'done' ? '已完成' : '草稿') + '</span>' +
      '</div>' +
      '<div class="row2">' +
        '<span class="pct">' + pct + '%</span>' +
        '<span class="pbar"><i style="width:' + pct + '%"></i></span>' +
        '<span>' + esc(U.fmtTime(p.updatedAt).slice(5)) + '</span>' +
      '</div>';
    return a;
  }

  /* ---------------- 新建 ---------------- */
  $('btn-new').onclick = async function () {
    // 先问项目名称（必填），再问客户名称（可留空）
    var proj = prompt('项目名称（必填）');
    if (proj === null) return;
    proj = (proj || '').trim();
    if (!proj) { alert('项目名称必填，请重新新建'); return; }

    var cust = prompt('客户名称（可留空）');
    if (cust === null) cust = '';
    cust = (cust || '').trim();

    var p = DB.newProject({ name: proj, customer: cust });
    // 自动带进「基本信息」，进模块时已填好
    p.answers = p.answers || {};
    p.answers.basic = p.answers.basic || {};
    p.answers.basic.project_name = proj;
    if (cust) p.answers.basic.customer_name = cust;

    await DB.putProject(p);
    location.href = 'project.html?id=' + encodeURIComponent(p.id);
  };

  /* ---------------- 更多 ---------------- */
  $('btn-more').onclick = async function () {
    var list = await DB.listProjects();
    var body = $('sheet-body');
    body.innerHTML = '';

    body.appendChild(sheetItem('导出全部方案（备份）', '把全部方案打成 zip 存起来', function () {
      exportAll(list);
    }));
    body.appendChild(sheetItem('解密加密包', '把 .zip.enc 还原成普通 zip', function () {
      closeSheet();
      decryptFile();
    }));
    body.appendChild(sheetItem('检查更新', '看看有没有新版本', function () { checkUpdateFlow(); }));
    body.appendChild(sheetItem('反馈 / 联系我们', '发邮件反馈问题或建议', function () { feedbackFlow(); }));
    body.appendChild(sheetItem('环境自检', '检查这台手机能否正常导出调研表', function () {
      location.href = 'selftest.html';
    }));
    body.appendChild(sheetItem('关于 / 数据说明', '数据存在哪、怎么不丢', function () {
      closeSheet();
      alert('「AGV 现场记录」\n\n' +
        '· 所有方案、照片、视频只保存在这台设备的浏览器数据库里\n' +
        '· 不联网、不上传、无账号\n' +
        '· 卸载 App / 清理浏览器数据 / 换手机 → 数据会丢失\n' +
        '· 请定期用「导出备份」保存到网盘或电脑\n\n' +
        '导出包内含：调研表 xlsx + 照片视频 + answers.json');
    }));
    $('sheet').classList.remove('hidden');
  };
  $('sheet-close').onclick = closeSheet;
  $('sheet').onclick = function (e) { if (e.target === $('sheet')) closeSheet(); };
  function closeSheet() { $('sheet').classList.add('hidden'); }

  /* ---------------- 检查更新 ---------------- */
  const FEEDBACK_MAIL = '2361677086@qq.com';
  const VERSION_URL = 'https://welkin-isle.github.io/agv_app/version.json';

  async function checkUpdateFlow() {
    var N = window.AGV_NATIVE;
    var info = N ? await N.appInfo() : { version: null, platform: 'web' };
    var cur = info.version || '（网页版，无版本号）';
    try {
      var r = await N.checkUpdate(VERSION_URL);
      if (r.hasUpdate) {
        if (confirm('发现新版本 ' + r.latest + '（当前 ' + r.current + '）\n\n' + (r.notes || '') +
          '\n\n是否打开下载页？')) { if (r.url) window.open(r.url, '_blank'); }
      } else {
        alert('已是最新版本\n\n当前：' + cur);
      }
    } catch (e) {
      alert('检查更新失败：' + e.message + '\n\n当前版本：' + cur +
        '\n（网页版没有版本号是正常的）');
    }
  }

  /* ---------------- 反馈 ---------------- */
  function feedbackFlow() {
    var N = window.AGV_NATIVE;
    var body = '请描述你遇到的问题或建议：\n\n1) 在哪个页面：\n2) 做了什么：\n3) 期望结果：\n4) 实际结果：\n\n';
    if (N) N.sendFeedback(FEEDBACK_MAIL, 'AGV 现场记录 App 反馈', body);
  }

  function sheetItem(title, desc, fn) {
    var b = document.createElement('button');
    b.className = 'btn';
    b.style.cssText = 'width:100%;text-align:left;margin-bottom:9px;padding:13px 15px';
    b.innerHTML = '<div style="font-weight:650">' + esc(title) + '</div>' +
      '<div class="tiny" style="margin-top:3px">' + esc(desc) + '</div>';
    b.onclick = fn;
    return b;
  }

  /* ---------------- 导出全部 ---------------- */
  async function exportAll(list) {
    if (!list.length) { alert('还没有方案'); return; }
    var ok = confirm('将导出 ' + list.length + ' 个方案的备份包。\n\n' +
      '包含每个方案的调研表 + 附件 + 原始数据。\n' +
      '大文件可能需要几十秒，请保持屏幕常亮。');
    if (!ok) return;

    try {
      var entries = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var media = await DB.listMedia(p.id);
        var files = await EX.build({
          project: p, answers: p.answers || {}, media: media, includeVideos: true, splitVideo: false
        });
        var f = files.files[0];
        var b = new Uint8Array(await f.blob.arrayBuffer());
        entries.push({ name: (p.customer || p.name || '方案') + '/' + f.name, data: b });
      }
      var zip = await window.AGV_ZIP.writeZip(entries);
      var name = 'AGV现场记录_备份_' + new Date().toISOString().slice(0, 10) + '.zip';
      EX.saveBlob(zip, name);
      await DB.setSetting('lastBackupAt', new Date().toISOString());
      render();
    } catch (err) {
      alert('导出失败：' + err.message);
    }
  }

  /* 解密 .zip.enc → 普通 zip */
  function decryptFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.enc,application/octet-stream';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.onchange = async function () {
      var f = input.files && input.files[0];
      input.remove();
      if (!f) return;
      var pw = prompt('输入导出时设的口令');
      if (!pw) return;
      try {
        var zip = await EX.decryptBlob(f, pw);
        var name = f.name.replace(/\.enc$/i, '') || 'decrypted.zip';
        EX.saveBlob(zip, name);
      } catch (e) {
        alert('解密失败：口令不对，或文件不是本 App 加密的');
      }
    };
    input.click();
  }

  /* ---------------- 自检 ---------------- */
  async function selfCheck() {
    var lines = [];
    try {
      var tpl = await EX.loadTemplate();
      lines.push('✓ 调研表模板已就绪（' + (tpl.byteLength / 1048576).toFixed(2) + ' MB）');
    } catch (e) {
      lines.push('✗ 调研表模板加载失败：' + e.message);
    }
    var usage = await DB.usage();
    lines.push('✓ 已用存储：' + U.fileSize(usage.used) +
      (usage.quota ? ' / 可用 ' + U.fileSize(usage.quota) : ''));
    var list = await DB.listProjects();
    lines.push('✓ 方案数：' + list.length);
    lines.push('✓ 浏览器支持离线缓存：' + (!!('serviceWorker' in navigator)));
    lines.push('✓ 支持录视频：' + (window.AGV_MEDIA ? window.AGV_MEDIA.supportsRecording() : false));
    alert(lines.join('\n'));
  }

  /* ---------------- 启动 ---------------- */
  (async function boot() {
    // 备份提醒：距上次导出 >3 天 → 今晚 20:00 提醒；>7 天 → 立刻提醒
  (async function remindBackup() {
    var N = window.AGV_NATIVE;
    if (!N || !N.isNative || !N.remindAt) return;
    try {
      var last = await DB.getSetting('lastExportAt');
      var days = last ? (Date.now() - new Date(last).getTime()) / 86400000 : 999;
      if (days < 3) return;
      var at = new Date();
      if (days >= 7) at = new Date(Date.now() + 5000);
      else { at.setHours(20, 0, 0, 0); if (at.getTime() <= Date.now()) at = new Date(Date.now() + 60000); }
      var d = Math.floor(days);
      await N.remindAt(at, '该导出备份了',
        (d >= 999 ? '你还没有导出过方案' : '距上次导出已 ' + d + ' 天') +
        '。数据只存在这台手机里，建议现在导出一次。');
    } catch (e) { /* 提醒失败不影响使用 */ }
  })();

  // 硬件返回键：首页按返回 = 退出（交给系统）
  if (window.AGV_NATIVE && window.AGV_NATIVE.isNative) {
    window.AGV_NATIVE.installBackButton(function () { return false; });
  }

  // App 壳（Capacitor）里资源已本地打包，Service Worker 既没必要也可能报错
    if ('serviceWorker' in navigator && !window.Capacitor) {
      navigator.serviceWorker.register('sw.js').catch(function () { /* 离线缓存失败不阻塞 */ });
    }
    try {
      await render();
    } catch (err) {
      $('main').innerHTML = '<div class="notice bad">加载失败：' + esc(err.message) +
        '<br><span class="tiny">如果是首次使用，请确认不是用 file:// 直接打开（需要 http/https 才能用本地数据库）</span></div>';
    }
    // 空闲时预热 4.8MB 调研表模板：等用户真的点「导出」时就不用再等下载
    // （同时让 Service Worker 有机会把它缓存下来，之后完全离线可用）
    var warm = function () {
      if (EX.isTemplateLoaded && EX.isTemplateLoaded()) return;
      EX.loadTemplate().then(function () {
        var el = $('storage-state');
        if (el && el.textContent.indexOf('准备') < 0) el.title = '调研表模板已就绪，可离线导出';
      }).catch(function () { /* 预热失败不影响使用，导出时会再试 */ });
    };
    if (window.requestIdleCallback) setTimeout(function () { requestIdleCallback(warm); }, 2500);
    else setTimeout(warm, 4000);

    // 存储状态
    DB.usage().then(function (u) {
      if (u.quota) {
        var pct = Math.round(u.used / u.quota * 100);
        var el = $('storage-state');
        el.textContent = '存储 ' + pct + '%';
        el.className = 'save-state ' + (pct > 85 ? 'warn' : 'ok');
      }
    });
  })();
})();
