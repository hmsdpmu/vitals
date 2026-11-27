/*
 * HDMP VITALS 2.0 Field App
 * Version 0.1.0 (27 November 2026) — Phase 2, Task 3: app shell, install and offline
 * Hospital Development and Management Program, Planning and Monitoring Unit
 *
 * What this version does
 * - Installs on laptops, tablets and phones and opens with no internet after the first open.
 * - Setup: sync service address, Member ID and personal sync key, typed once per device.
 * - Downloads the field pack (questions for the hospital's level, hospital profile, open actions)
 *   for chosen hospitals before a trip, and shows when each was downloaded.
 * - Visits, answers, photos and sync of visits come in Tasks 4 to 8.
 *
 * Data rules
 * - No hospital data is written in this code. Data lives only in this device's database
 *   and in the VITALS workbook, reached through the sync service.
 * - Field packs are read-only copies; this version sends nothing to the workbook.
 */
(function (root) {
  'use strict';

  var APP_VERSION = '0.1.0';
  var QUESTION_BANK_VERSION = '2.2';
  var DB_NAME = 'vitals2';
  var DB_VERSION = 1;
  var REQUEST_TIMEOUT_MS = 90000;
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var LAYERS = ['Must comply', 'Run well', 'Ready to grow'];

  /* ------------------------------------------------------------------ */
  /* Pure helpers (tested without a browser)                             */
  /* ------------------------------------------------------------------ */

  function validServiceUrl(url) {
    var u = String(url || '').trim();
    return /^https:\/\/script\.google\.com\/(a\/macros\/[A-Za-z0-9.-]+|macros)\/s\/[A-Za-z0-9_-]{20,}\/exec$/.test(u);
  }

  function normMemberId(id) {
    return String(id || '').trim().toUpperCase().replace(/\s+/g, '');
  }

  function normKey(key) {
    var k = String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return k.length === 16 ? k.match(/.{4}/g).join('-') : k;
  }

  function newDeviceCode(randomFn) {
    var r = randomFn || Math.random;
    var s = '';
    for (var i = 0; i < 4; i++) s += CODE_ALPHABET.charAt(Math.floor(r() * CODE_ALPHABET.length) % CODE_ALPHABET.length);
    return s;
  }

  function packSummary(pack) {
    var qs = (pack && pack.questions) || [];
    var out = { total: qs.length, openActions: ((pack && pack.openActions) || []).length, critical: 0 };
    LAYERS.forEach(function (l) { out[l] = 0; });
    qs.forEach(function (q) {
      if (out[q.Layer] !== undefined) out[q.Layer]++;
      if (String(q.Critical || '').toUpperCase() === 'TRUE' || String(q.Critical || '').toLowerCase() === 'yes') out.critical++;
    });
    return out;
  }

  function formatManila(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', day: 'numeric', month: 'short', year: 'numeric',
        hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return d.toISOString();
    }
  }

  function readyLine(record) {
    return 'Ready for offline use: ' + record.hospitalName + ', questions v' + record.questionBankVersion +
      ', downloaded ' + formatManila(record.downloadedAt);
  }

  function shortReadyLine(record) {
    return 'Questions v' + record.questionBankVersion + ' · downloaded ' + formatManila(record.downloadedAt);
  }

  function packNeedsUpdate(record, serverQuestionBankVersion) {
    if (!record) return false;
    var want = serverQuestionBankVersion || QUESTION_BANK_VERSION;
    return String(record.questionBankVersion) !== String(want);
  }

  function friendlyError(err) {
    var m = String(err && err.message ? err.message : err || '');
    if (/abort/i.test(m)) return 'The sync service took too long to answer. Try again when the signal is better.';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) {
      return 'Could not reach the sync service. Check the internet connection and the service address.';
    }
    return m || 'Something went wrong.';
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function makeRecord(hospital, pack, nowIso) {
    return {
      hospitalId: String(hospital.HospitalID),
      hospitalCode: hospital.HospitalCode || (pack.hospital && pack.hospital.HospitalCode) || '',
      hospitalName: hospital.HospitalName || (pack.hospital && pack.hospital.HospitalName) || String(hospital.HospitalID),
      level: hospital.Level || (pack.hospital && pack.hospital.CurrentFunctionalClassification) || '',
      questionBankVersion: pack.questionBankVersion || '',
      generatedAt: pack.generatedAt || '',
      downloadedAt: nowIso,
      summary: packSummary(pack),
      pack: pack
    };
  }

  var pure = {
    APP_VERSION: APP_VERSION, QUESTION_BANK_VERSION: QUESTION_BANK_VERSION,
    validServiceUrl: validServiceUrl, normMemberId: normMemberId, normKey: normKey, newDeviceCode: newDeviceCode,
    packSummary: packSummary, formatManila: formatManila, readyLine: readyLine, shortReadyLine: shortReadyLine, packNeedsUpdate: packNeedsUpdate,
    friendlyError: friendlyError, escapeHtml: escapeHtml, makeRecord: makeRecord
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------------------------ */
  /* Device database (IndexedDB)                                         */
  /* ------------------------------------------------------------------ */

  var dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('packs')) d.createObjectStore('packs', { keyPath: 'hospitalId' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(store, mode);
        var s = t.objectStore(store);
        var result;
        var r = fn(s);
        if (r && 'onsuccess' in r) r.onsuccess = function () { result = r.result; };
        t.oncomplete = function () { resolve(result); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Saving on this device was stopped.')); };
      });
    });
  }

  var store = {
    get: function (k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); },
    set: function (k, v) { return tx('kv', 'readwrite', function (s) { return s.put(v, k); }); },
    packs: function () { return tx('packs', 'readonly', function (s) { return s.getAll(); }).then(function (a) { return a || []; }); },
    putPack: function (rec) { return tx('packs', 'readwrite', function (s) { return s.put(rec); }); },
    deletePack: function (id) { return tx('packs', 'readwrite', function (s) { return s.delete(id); }); },
    wipe: function () {
      return db().then(function (d) {
        d.close();
        dbPromise = null;
        return new Promise(function (resolve, reject) {
          var r = indexedDB.deleteDatabase(DB_NAME);
          r.onsuccess = function () { resolve(); };
          r.onerror = function () { reject(r.error); };
          r.onblocked = function () { resolve(); };
        });
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Sync service calls                                                  */
  /* ------------------------------------------------------------------ */

  function call(settings, action, extra) {
    var body = Object.assign({ action: action, memberId: settings.memberId, key: settings.key,
      deviceId: settings.deviceCode, appVersion: APP_VERSION }, extra || {});
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, REQUEST_TIMEOUT_MS) : null;
    return fetch(settings.serviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('The sync service answered with an error (' + res.status + ').');
      return res.text();
    }).then(function (text) {
      var json;
      try { json = JSON.parse(text); } catch (e) {
        throw new Error('The service address did not answer like the VITALS 2.0 Sync Service. Check the address and that it is deployed with access "Anyone".');
      }
      if (!json.ok) throw new Error(json.error || 'The sync service refused the request.');
      return json.data;
    }).finally(function () { if (timer) clearTimeout(timer); });
  }

  /* ------------------------------------------------------------------ */
  /* App state                                                           */
  /* ------------------------------------------------------------------ */

  var state = { settings: null, hospitals: [], packs: [], installEvent: null, swReg: null, busy: false, flash: null };
  var view = document.getElementById('view');

  function setFlash(kind, text) { state.flash = { kind: kind, text: text }; }
  function takeFlash() {
    var f = state.flash;
    state.flash = null;
    return f ? '<div class="msg ' + f.kind + '">' + escapeHtml(f.text) + '</div>' : '';
  }

  function loadState() {
    return Promise.all([store.get('settings'), store.get('hospitals'), store.packs()]).then(function (r) {
      state.settings = r[0] || null;
      state.hospitals = (r[1] || []).slice().sort(function (a, b) { return String(a.HospitalName).localeCompare(String(b.HospitalName)); });
      state.packs = r[2] || [];
      state.packs.sort(function (a, b) { return a.hospitalName.localeCompare(b.hospitalName); });
    });
  }

  function packFor(id) {
    for (var i = 0; i < state.packs.length; i++) if (state.packs[i].hospitalId === String(id)) return state.packs[i];
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Header, network and updates                                         */
  /* ------------------------------------------------------------------ */

  function renderHeader() {
    var who = document.getElementById('who');
    var s = state.settings;
    who.textContent = s && s.member ? s.member.FullName + ' · ' + s.member.Unit + ' · device ' + s.deviceCode
      : 'Hospital Development and Management Program';
    var net = document.getElementById('net');
    var on = navigator.onLine;
    net.textContent = on ? 'Online' : 'Offline';
    net.className = 'pill ' + (on ? 'online' : 'offline');
  }

  window.addEventListener('online', function () { renderHeader(); route(); });
  window.addEventListener('offline', function () { renderHeader(); route(); });

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    state.installEvent = e;
    if (currentTab() === 'home') route();
  });
  window.addEventListener('appinstalled', function () { state.installEvent = null; if (currentTab() === 'home') route(); });

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function registerWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      state.swReg = reg;
      var showIfWaiting = function () {
        if (reg.waiting && navigator.serviceWorker.controller) document.getElementById('updateBanner').classList.add('show');
      };
      showIfWaiting();
      reg.addEventListener('updatefound', function () {
        var w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', function () {
          if (w.state === 'installed') showIfWaiting();
          if (w.state === 'activated' && currentTab() === 'home') route();
        });
      });
    }).catch(function () { /* the app still works online */ });
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    document.getElementById('updateBtn').addEventListener('click', function () {
      if (state.swReg && state.swReg.waiting) state.swReg.waiting.postMessage('SKIP_WAITING');
    });
  }

  function offlineReady() {
    if (!('serviceWorker' in navigator) || !('caches' in window)) return Promise.resolve(false);
    return caches.keys().then(function (names) {
      var hasShell = names.some(function (n) { return n === 'vitals2-shell-' + APP_VERSION; });
      return hasShell && !!navigator.serviceWorker.controller;
    }).catch(function () { return false; });
  }

  function storageInfo() {
    var out = { persisted: null, usage: null, quota: null };
    if (!navigator.storage) return Promise.resolve(out);
    var p1 = navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(null);
    var p2 = navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve({});
    return Promise.all([p1, p2]).then(function (r) {
      out.persisted = r[0];
      out.usage = r[1].usage || null;
      out.quota = r[1].quota || null;
      return out;
    }).catch(function () { return out; });
  }

  function askPersist() {
    if (!navigator.storage || !navigator.storage.persist) return Promise.resolve(false);
    return navigator.storage.persist().catch(function () { return false; });
  }

  function mb(n) { return n ? (n / 1048576).toFixed(1) + ' MB' : '—'; }

  /* ------------------------------------------------------------------ */
  /* Views                                                               */
  /* ------------------------------------------------------------------ */

  function currentTab() {
    var t = (window.location.hash || '#home').slice(1);
    return ['home', 'packs', 'setup', 'about'].indexOf(t) === -1 ? 'home' : t;
  }

  function route() {
    var tab = currentTab();
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs a'), function (a) {
      a.classList.toggle('on', a.getAttribute('data-tab') === tab);
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    renderHeader();
    if (tab === 'packs') return viewPacks();
    if (tab === 'setup') return viewSetup();
    if (tab === 'about') return viewAbout();
    return viewHome();
  }
  window.addEventListener('hashchange', route);

  /** Opens a screen once (changing the address already redraws, so it is not drawn twice). */
  function go(tab) {
    if (currentTab() === tab && window.location.hash === '#' + tab) route();
    else window.location.hash = '#' + tab;
  }

  function check(symClass, sym, label, detail) {
    return '<div class="check"><span class="sym ' + symClass + '" aria-hidden="true">' + sym + '</span><div class="grow">' +
      '<span class="status-label">' + escapeHtml(label) + '</span>' +
      (detail ? '<div class="small muted">' + detail + '</div>' : '') + '</div></div>';
  }

  function viewHome() {
    Promise.all([offlineReady(), storageInfo()]).then(function (r) {
      var ready = r[0], st = r[1], s = state.settings;
      var html = '<h1>Field app</h1>' + takeFlash();

      if (!s) {
        html += '<div class="card mist"><h2>Set up this device</h2><p>Enter the sync service address, your Member ID and your personal sync key. You do this once on each device.</p>' +
          '<a class="btn" href="#setup">Go to setup</a></div>';
      }

      html += '<div class="card"><h2>Offline readiness</h2>';
      html += ready ? check('s-ok', '✓', 'Compliant — app saved for offline use', 'The app opens without internet on this device.')
        : check('s-att', '▲', 'Attention — not yet saved for offline use', 'Keep the app open for a moment while online, then reopen it.');
      if (st.persisted === true) html += check('s-ok', '✓', 'Compliant — device storage kept permanently', 'The browser will not clear the app data to free space.');
      else if (st.persisted === false) html += check('s-att', '▲', 'Attention — device storage may be cleared when space is low',
        '<button class="link" id="persistBtn" type="button">Ask the browser to keep the data</button>');
      else html += check('s-na', '–', 'Not assessed — this browser does not report storage protection', '');
      html += s ? check('s-ok', '✓', 'Compliant — device set up', escapeHtml(s.member.FullName + ' (' + s.memberId + '), device code ' + s.deviceCode))
        : check('s-crit', '●', 'Critical — device not set up', 'Go to Setup.');
      html += state.packs.length ? check('s-ok', '✓', 'Compliant — ' + state.packs.length + ' field pack' + (state.packs.length > 1 ? 's' : '') + ' on this device', '')
        : check('s-att', '▲', 'Attention — no field packs yet', 'Download the hospitals you will visit, before the trip.');
      html += '<p class="small muted" style="margin-top:8px">Storage used: ' + mb(st.usage) + (st.quota ? ' of about ' + mb(st.quota) : '') + '</p></div>';

      if (state.packs.length) {
        html += '<div class="card"><h2>Ready for offline use</h2>';
        state.packs.forEach(function (p) {
          var stale = packNeedsUpdate(p, s && s.member && s.member.questionBankVersion);
          html += '<div class="check" title="' + escapeHtml(readyLine(p)) + '"><span class="sym ' + (stale ? 's-att' : 's-ok') + '" aria-hidden="true">' + (stale ? '▲' : '✓') + '</span><div class="grow">' +
            '<span class="status-label">' + escapeHtml(p.hospitalName) + '</span>' +
            '<div class="small muted">' + escapeHtml(shortReadyLine(p)) + '<br>' + p.summary.total + ' questions (Must comply ' + p.summary['Must comply'] + ', Run well ' + p.summary['Run well'] +
            ', Ready to grow ' + p.summary['Ready to grow'] + ') · ' + p.summary.openActions + ' open actions from earlier visits' +
            (stale ? '<br><b class="s-att">▲ Update needed: the question bank has changed</b>' : '') + '</div></div></div>';
        });
        html += '</div>';
      }

      html += '<div class="card ice"><h2>Visits</h2><p class="small">Visit setup, answering questions and sending to the laptop come in the next updates of the app. ' +
        'For now this version prepares the device: install, set up, and download field packs.</p></div>';

      if (!isStandalone()) {
        if (state.installEvent) {
          html += '<div class="card"><h2>Install the app</h2><p class="small">Installing puts VITALS on the home screen and opens it in its own window.</p>' +
            '<button id="installBtn" type="button">Install VITALS</button></div>';
        } else if (isIos()) {
          html += '<div class="card"><h2>Install the app</h2><p class="small">On iPad or iPhone, open this page in Safari, tap the Share button, then <b>Add to Home Screen</b>.</p></div>';
        } else {
          html += '<div class="card"><h2>Install the app</h2><p class="small">Use the browser menu and choose <b>Install app</b> or <b>Add to Home screen</b>.</p></div>';
        }
      }

      html += footer();
      view.innerHTML = html;
      var pb = document.getElementById('persistBtn');
      if (pb) pb.addEventListener('click', function () { askPersist().then(function (ok) {
        setFlash(ok ? 'ok' : 'info', ok ? 'The browser will keep the app data.' : 'The browser did not agree yet. Installing the app usually allows it.');
        route();
      }); });
      var ib = document.getElementById('installBtn');
      if (ib) ib.addEventListener('click', function () {
        var ev = state.installEvent;
        if (!ev) return;
        ev.prompt();
        ev.userChoice.then(function () { state.installEvent = null; route(); });
      });
    });
  }

  function viewSetup() {
    var s = state.settings;
    var html = '<h1>Setup</h1>' + takeFlash();
    if (s) {
      html += '<div class="card mist"><h2>This device</h2>' +
        '<p><b>' + escapeHtml(s.member.FullName) + '</b> (' + escapeHtml(s.memberId) + ') · ' + escapeHtml(s.member.Unit) +
        (s.member.Position ? ' · ' + escapeHtml(s.member.Position) : '') + '</p>' +
        '<p class="small">Device name: ' + escapeHtml(s.deviceName) + ' · device code <b>' + escapeHtml(s.deviceCode) + '</b><br>' +
        'Set up ' + escapeHtml(formatManila(s.setupAt)) + ' · last checked ' + escapeHtml(formatManila(s.checkedAt)) + '</p></div>';
    }
    html += '<form class="card" id="setupForm" autocomplete="off" novalidate>' +
      '<h2>' + (s ? 'Change setup' : 'Set up this device') + '</h2>' +
      '<label for="fUrl">Sync service address</label>' +
      '<input id="fUrl" inputmode="url" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="' + escapeHtml(s ? s.serviceUrl : '') + '">' +
      '<div class="hint">From the system administrator. It starts with https://script.google.com/macros/s/ and ends with /exec.</div>' +
      '<label for="fMember">Member ID</label>' +
      '<input id="fMember" spellcheck="false" autocapitalize="characters" placeholder="MBR-…" value="' + escapeHtml(s ? s.memberId : '') + '">' +
      '<label for="fKey">Personal sync key</label>' +
      '<input id="fKey" spellcheck="false" autocapitalize="characters" placeholder="' + (s ? 'Saved — leave blank to keep' : 'XXXX-XXXX-XXXX-XXXX') + '">' +
      '<div class="hint">Your own key. Do not share it. It is kept on this device only.</div>' +
      '<label for="fDevice">Device name</label>' +
      '<input id="fDevice" placeholder="For example: PMU laptop, Aisa phone" value="' + escapeHtml(s ? s.deviceName : '') + '">' +
      '<div class="row" style="margin-top:16px"><button type="submit" id="saveBtn">Save and test connection</button></div>' +
      '<div id="setupMsg"></div></form>';
    if (s) {
      html += '<div class="card"><h2>Remove data from this device</h2><p class="small">Deletes the setup and every field pack on this device. ' +
        'Use this before giving the device to someone else.</p><button class="danger" id="wipeBtn" type="button">Remove all data from this device</button></div>';
    }
    html += footer();
    view.innerHTML = html;

    document.getElementById('setupForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.busy) return;
      var msg = document.getElementById('setupMsg');
      var url = document.getElementById('fUrl').value.trim();
      var memberId = normMemberId(document.getElementById('fMember').value);
      var keyTyped = normKey(document.getElementById('fKey').value);
      var key = keyTyped || (s && memberId === s.memberId ? s.key : '');
      var deviceName = document.getElementById('fDevice').value.trim();
      var problems = [];
      if (!validServiceUrl(url)) problems.push('The sync service address is not in the expected form.');
      if (!/^MBR-[A-Z0-9-]+$/.test(memberId)) problems.push('The Member ID should look like MBR-XXXX.');
      if (!/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(key)) problems.push('The sync key should have 16 letters and numbers, like XXXX-XXXX-XXXX-XXXX.');
      if (!deviceName) problems.push('Give this device a name, so the team can tell devices apart.');
      if (problems.length) { msg.innerHTML = '<div class="msg err">' + problems.map(escapeHtml).join('<br>') + '</div>'; return; }
      if (!navigator.onLine) { msg.innerHTML = '<div class="msg err">Setup needs internet once, to check the key with the sync service.</div>'; return; }

      var trial = { serviceUrl: url, memberId: memberId, key: key, deviceName: deviceName,
        deviceCode: s ? s.deviceCode : newDeviceCode(), setupAt: s ? s.setupAt : new Date().toISOString() };
      state.busy = true;
      document.getElementById('saveBtn').disabled = true;
      msg.innerHTML = '<div class="msg info">Checking with the sync service…</div>';
      call(trial, 'whoami').then(function (member) {
        trial.member = member;
        trial.checkedAt = new Date().toISOString();
        return call(trial, 'hospitals').then(function (list) {
          return store.set('settings', trial).then(function () { return store.set('hospitals', list); }).then(function () {
            return store.set('hospitalsAt', new Date().toISOString());
          });
        });
      }).then(function () {
        return askPersist();
      }).then(function () {
        return loadState();
      }).then(function () {
        state.busy = false;
        setFlash('ok', 'Setup saved. Welcome, ' + state.settings.member.FullName + '. Next: download the hospitals you will visit.');
        go('packs');
      }).catch(function (err) {
        state.busy = false;
        var b = document.getElementById('saveBtn');
        if (b) b.disabled = false;
        msg.innerHTML = '<div class="msg err">' + escapeHtml(friendlyError(err)) + '</div>';
      });
    });

    var wb = document.getElementById('wipeBtn');
    if (wb) wb.addEventListener('click', function () {
      if (!window.confirm('Remove the setup and all field packs from this device?')) return;
      store.wipe().then(function () {
        state.settings = null; state.hospitals = []; state.packs = [];
        setFlash('ok', 'All VITALS data was removed from this device.');
        go('home');
      });
    });
  }

  function viewPacks() {
    var s = state.settings;
    var html = '<h1>Hospitals and field packs</h1>' + takeFlash();
    if (!s) {
      view.innerHTML = html + '<div class="card mist"><p>Set up this device first.</p><a class="btn" href="#setup">Go to setup</a></div>' + footer();
      return;
    }
    var online = navigator.onLine;
    store.get('hospitalsAt').then(function (at) {
      html += '<div class="card mist"><p class="small" style="margin:0">Download the hospitals you will visit <b>before the trip</b>, while you have internet. ' +
        'Each field pack holds the questions for that hospital\'s level and the open actions from earlier visits.</p></div>';
      html += '<div class="card"><h2 style="margin:0 0 4px">' + state.hospitals.length + ' hospitals · ' + state.packs.length + ' on this device</h2>' +
        '<p class="small muted">List updated ' + escapeHtml(formatManila(at)) + (online ? '' : ' · Offline: downloads need internet') + '</p>' +
        '<div class="row" style="margin-bottom:6px"><button id="allBtn" type="button"' + (online ? '' : ' disabled') + '>Download all</button>' +
        '<button class="secondary" id="refreshBtn" type="button"' + (online ? '' : ' disabled') + '>Refresh list</button></div>' +
        '<div id="packMsg"></div><div id="hospList">';
      state.hospitals.forEach(function (h) {
        var p = packFor(h.HospitalID);
        var stale = p && packNeedsUpdate(p, s.member && s.member.questionBankVersion);
        html += '<div class="hosp"><div class="grow"><div class="name">' + escapeHtml(h.HospitalName) + '</div>' +
          '<div><span class="tag">' + escapeHtml(h.HospitalCode) + '</span><span class="tag">' + escapeHtml(h.Level) + '</span></div>' +
          (p ? '<div class="' + (stale ? 's-att small' : 'ready') + '" title="' + escapeHtml(readyLine(p)) + '">' + (stale ? '▲ Update needed · ' : '✓ Ready for offline use · ') + escapeHtml(shortReadyLine(p)) + '</div>'
            : '<div class="small muted">– Not on this device</div>') + '</div>' +
          '<div class="row">' +
          '<button type="button" class="' + (p ? 'secondary' : '') + '" data-dl="' + escapeHtml(h.HospitalID) + '"' + (online ? '' : ' disabled') + '>' + (p ? 'Update' : 'Download') + '</button>' +
          (p ? '<button type="button" class="link" data-rm="' + escapeHtml(h.HospitalID) + '">Remove</button>' : '') +
          '</div></div>';
      });
      if (!state.hospitals.length) html += '<p class="small muted">No hospitals yet. Tap Refresh list while online.</p>';
      html += '</div></div>' + footer();
      view.innerHTML = html;
      wirePacks();
    });
  }

  function packMessage(kind, text) {
    var m = document.getElementById('packMsg');
    if (m) m.innerHTML = '<div class="msg ' + kind + '">' + escapeHtml(text) + '</div>';
  }

  function downloadOne(h) {
    return call(state.settings, 'fieldPack', { hospitalId: h.HospitalID }).then(function (pack) {
      if (!pack || !pack.hospital || String(pack.hospital.HospitalID) !== String(h.HospitalID)) {
        throw new Error('The field pack received is not for ' + h.HospitalName + '. It was not saved.');
      }
      return store.putPack(makeRecord(h, pack, new Date().toISOString()));
    });
  }

  function setButtons(disabled) {
    Array.prototype.forEach.call(view.querySelectorAll('button'), function (b) { b.disabled = disabled || (!navigator.onLine && !b.hasAttribute('data-rm')); });
  }

  function wirePacks() {
    var byId = {};
    state.hospitals.forEach(function (h) { byId[String(h.HospitalID)] = h; });

    Array.prototype.forEach.call(view.querySelectorAll('[data-dl]'), function (b) {
      b.addEventListener('click', function () {
        var h = byId[b.getAttribute('data-dl')];
        if (!h || state.busy) return;
        state.busy = true; setButtons(true);
        packMessage('info', 'Downloading ' + h.HospitalName + '…');
        downloadOne(h).then(loadState).then(function () {
          state.busy = false;
          setFlash('ok', 'Saved on this device: ' + h.HospitalName + '.');
          route();
        }).catch(function (err) {
          state.busy = false; setButtons(false);
          packMessage('err', h.HospitalName + ': ' + friendlyError(err));
        });
      });
    });

    Array.prototype.forEach.call(view.querySelectorAll('[data-rm]'), function (b) {
      b.addEventListener('click', function () {
        var h = byId[b.getAttribute('data-rm')];
        if (!h || !window.confirm('Remove the field pack for ' + h.HospitalName + ' from this device?')) return;
        store.deletePack(String(h.HospitalID)).then(loadState).then(function () {
          setFlash('ok', 'Removed from this device: ' + h.HospitalName + '.');
          route();
        });
      });
    });

    var all = document.getElementById('allBtn');
    if (all) all.addEventListener('click', function () {
      if (state.busy) return;
      state.busy = true; setButtons(true);
      var list = state.hospitals.slice();
      var failed = [];
      var i = 0;
      var next = function () {
        if (i >= list.length) {
          return loadState().then(function () {
            state.busy = false;
            if (failed.length) setFlash('err', (list.length - failed.length) + ' of ' + list.length + ' saved. Not saved: ' + failed.join('; '));
            else setFlash('ok', 'All ' + list.length + ' field packs are saved on this device.');
            route();
          });
        }
        var h = list[i++];
        packMessage('info', 'Downloading ' + i + ' of ' + list.length + ': ' + h.HospitalName + '…');
        return downloadOne(h).catch(function (err) { failed.push(h.HospitalName + ' (' + friendlyError(err) + ')'); }).then(next);
      };
      next();
    });

    var rf = document.getElementById('refreshBtn');
    if (rf) rf.addEventListener('click', function () {
      if (state.busy) return;
      state.busy = true; setButtons(true);
      packMessage('info', 'Getting the hospital list…');
      call(state.settings, 'hospitals').then(function (list) {
        return store.set('hospitals', list).then(function () { return store.set('hospitalsAt', new Date().toISOString()); });
      }).then(loadState).then(function () {
        state.busy = false;
        setFlash('ok', 'Hospital list updated.');
        route();
      }).catch(function (err) {
        state.busy = false; setButtons(false);
        packMessage('err', friendlyError(err));
      });
    });
  }

  function viewAbout() {
    var s = state.settings;
    storageInfo().then(function (st) {
      var html = '<h1>About</h1>' + takeFlash() +
        '<div class="card"><h2>HDMP VITALS 2.0 Field App</h2>' +
        '<p class="small">Offline hospital visit tool of the Hospital Development and Management Program, Provincial Government of Palawan. ' +
        '16 Hospitals, One Provincial Hospital System.</p>' +
        '<div class="kpis">' +
        '<div class="kpi"><b>' + APP_VERSION + '</b><span>App version</span></div>' +
        '<div class="kpi"><b>' + escapeHtml((s && s.member && s.member.questionBankVersion) || QUESTION_BANK_VERSION) + '</b><span>Question bank</span></div>' +
        '<div class="kpi"><b>' + escapeHtml((s && s.member && s.member.serviceVersion) || '—') + '</b><span>Sync service</span></div>' +
        '<div class="kpi"><b>' + state.packs.length + '</b><span>Field packs on device</span></div>' +
        '</div>' +
        '<p class="small muted" style="margin-top:10px">Storage used ' + mb(st.usage) + '. App data stays on this device until it is sent to the VITALS workbook.</p>' +
        '<div class="row"><button class="secondary" id="updCheck" type="button"' + (navigator.onLine ? '' : ' disabled') + '>Check for app update</button></div>' +
        '<div id="aboutMsg"></div></div>' +
        '<div class="card"><h2>What this version does</h2><p class="small">Installs, works offline, sets up the device and downloads field packs. ' +
        'Visit setup, answering, photos, merging devices, scores and the closing conference package follow in the next versions.</p></div>' +
        footer();
      view.innerHTML = html;
      var b = document.getElementById('updCheck');
      if (b) b.addEventListener('click', function () {
        var m = document.getElementById('aboutMsg');
        if (!state.swReg) { m.innerHTML = '<div class="msg info">Offline support is not active in this browser.</div>'; return; }
        state.swReg.update().then(function () {
          m.innerHTML = state.swReg.waiting || state.swReg.installing
            ? '<div class="msg ok">A new version was found. Tap Update now at the top.</div>'
            : '<div class="msg ok">You have the latest version (' + APP_VERSION + ').</div>';
        }).catch(function (err) { m.innerHTML = '<div class="msg err">' + escapeHtml(friendlyError(err)) + '</div>'; });
      });
    });
  }

  function footer() {
    return '<footer class="foot">Hospital Development and Management Program · Provincial Government of Palawan · VITALS 2.0 app ' + APP_VERSION + '</footer>';
  }

  /* ------------------------------------------------------------------ */
  /* Start                                                               */
  /* ------------------------------------------------------------------ */

  registerWorker();
  loadState().then(route).catch(function (err) {
    view.innerHTML = '<div class="card"><div class="msg err">This device could not open the app storage: ' + escapeHtml(friendlyError(err)) +
      '. Private browsing windows may block it; open the app in a normal window.</div></div>';
  });
})(typeof window !== 'undefined' ? window : this);
