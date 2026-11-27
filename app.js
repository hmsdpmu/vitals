/*
 * HDMP VITALS 2.0 Field App
 * Version 0.2.0 (28 November 2026) — Phase 2, Task 4: visit setup and question group assignment
 * Change from 0.1.0 (Task 3, tested 28 Nov 00:13):
 * - Visits tab: the team leader starts a visit (hospital, one of the 8 workbook visit types, date, start
 *   time), answers the service questions once (clinical laboratory, point-of-care testing, mobile
 *   laboratory, diagnostic X-ray, computed tomography or mammography, own pharmacy, bulk distribution),
 *   picks the team and leader, and records hospital representatives.
 * - Questions are grouped by layer and by the 12 workbook systems; the leader assigns each group to a
 *   team member and shares an assignment file; members open it on their own devices.
 * - Visit ID: INS-{hospital code}-{yyyymmdd}-{device code}, made on the leader's device.
 * - Team list comes from the Sync Service (0.4.0 'team' request) and is kept for offline use.
 * Version 0.1.0 (27 November 2026) — Phase 2, Task 3: app shell, install and offline
 * Hospital Development and Management Program, Planning and Monitoring Unit
 *
 * What this version does
 * - Installs on laptops, tablets and phones and opens with no internet after the first open.
 * - Setup: sync service address, Member ID and personal sync key, typed once per device.
 * - Downloads the field pack (questions for the hospital's level, hospital profile, open actions)
 *   for chosen hospitals before a trip, and shows when each was downloaded.
 * - Answers, photos and sync of visits come in Tasks 5 to 8.
 *
 * Data rules
 * - No hospital data is written in this code. Data lives only in this device's database
 *   and in the VITALS workbook, reached through the sync service.
 * - Field packs are read-only copies; this version sends nothing to the workbook.
 */
(function (root) {
  'use strict';

  var APP_VERSION = '0.2.0';
  var QUESTION_BANK_VERSION = '2.2';
  var DB_NAME = 'vitals2';
  var DB_VERSION = 2;
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


  /* ---------- Visit setup (Task 4) ---------- */

  var VISIT_TYPES = ['Comprehensive Inspection', 'Monitoring Visit', 'Validation Visit', 'Follow-up Visit',
    'Licensing Readiness', 'Engineering Assessment', 'ICT Assessment', 'Special Assessment'];

  // The 12 systems of 02_DIM_SYSTEMS, in workbook order.
  var SYSTEMS = [
    ['GOV', 'Leadership and Governance'], ['LND', 'Legal, Land and Property Readiness'],
    ['INF', 'Infrastructure and Physical Environment'], ['ENG', 'Engineering and Utilities'],
    ['CLN', 'Clinical Operations and Patient Safety'], ['MEA', 'Medical Equipment and Asset Management'],
    ['IPC', 'Infection Prevention and Healthcare Waste Management'], ['DHI', 'Digital Health, ICT and iHOMIS+'],
    ['DIS', 'Disaster and Island Readiness'], ['HR', 'Human Resources and Workforce'],
    ['ENV', 'Environmental Health and Sustainability'], ['PLN', 'Planning, Investment and Development']
  ];

  // Service questions asked once per visit. Each matches one AskWhen text of the approved bank (v2.2).
  var SERVICES = [
    { key: 'lab', label: 'Runs a clinical laboratory', askWhen: 'Only where the facility operates a clinical laboratory' },
    { key: 'poct', label: 'Does point-of-care testing', askWhen: 'Only where point-of-care testing is done' },
    { key: 'mobileLab', label: 'Operates a mobile clinical laboratory', askWhen: 'Only where a mobile clinical laboratory is operated' },
    { key: 'xray', label: 'Operates a diagnostic X-ray facility', askWhen: 'Only where the facility operates a diagnostic X-ray facility' },
    { key: 'ctMammo', label: 'Operates computed tomography or mammography', askWhen: 'Only where the facility operates computed tomography or mammography' },
    { key: 'pharmacy', label: 'Runs its own pharmacy', askWhen: 'Only where the facility runs its own pharmacy' },
    { key: 'bulk', label: 'Distributes medicines in bulk to other facilities', askWhen: 'Only where the facility distributes medicines in bulk to other facilities' }
  ];

  function serviceKeyFor(askWhen) {
    var a = String(askWhen || '').trim();
    for (var i = 0; i < SERVICES.length; i++) if (SERVICES[i].askWhen === a) return SERVICES[i].key;
    return null;
  }

  /** Services that have at least one question in this field pack, with their question counts. */
  function relevantServices(questions) {
    return SERVICES.map(function (s) {
      var n = (questions || []).filter(function (q) { return serviceKeyFor(q.AskWhen) === s.key; }).length;
      return { key: s.key, label: s.label, count: n };
    }).filter(function (s) { return s.count > 0; });
  }

  /** Questions asked at this visit: a question tied to a service is left out only when that service is answered No. */
  function applicableQuestions(questions, services) {
    var sv = services || {};
    return (questions || []).filter(function (q) {
      var k = serviceKeyFor(q.AskWhen);
      return !k || sv[k] !== 'No';
    });
  }

  /** Question groups: one per layer and system, in layer order then workbook system order. */
  function buildGroups(questions) {
    var by = {};
    (questions || []).forEach(function (q) {
      var id = q.Layer + '|' + q.SystemCode;
      (by[id] = by[id] || []).push(String(q.QuestionID));
    });
    var out = [];
    LAYERS.forEach(function (layer) {
      SYSTEMS.forEach(function (s) {
        var id = layer + '|' + s[0];
        if (by[id]) out.push({ groupId: id, layer: layer, systemCode: s[0], systemName: s[1], questionIds: by[id], assignedTo: '' });
        delete by[id];
      });
    });
    Object.keys(by).sort().forEach(function (id) {   // a system code not in the list is kept, never dropped
      var p = id.split('|');
      out.push({ groupId: id, layer: p[0], systemCode: p[1], systemName: p[1], questionIds: by[id], assignedTo: '' });
    });
    return out;
  }

  /** Keeps earlier assignments when groups are rebuilt; drops assignments to people no longer on the team. */
  function mergeAssignments(oldGroups, newGroups, teamIds) {
    var prev = {};
    (oldGroups || []).forEach(function (g) { prev[g.groupId] = g.assignedTo || ''; });
    return newGroups.map(function (g) {
      var a = prev[g.groupId] || '';
      if (a && teamIds && teamIds.indexOf(a) === -1) a = '';
      return Object.assign({}, g, { assignedTo: a });
    });
  }

  function todayManila(now) {
    var d = now || new Date();
    var m = new Date(d.getTime() + 8 * 3600000);
    return m.toISOString().slice(0, 10);
  }

  /** INS-{hospital code}-{yyyymmdd}-{device code}; a number is added only if this device already used the ID. */
  function makeVisitId(hospitalCode, dateStr, deviceCode, existingIds) {
    var base = 'INS-' + String(hospitalCode).toUpperCase() + '-' + String(dateStr).replace(/-/g, '') + '-' + deviceCode;
    var ids = existingIds || [];
    if (ids.indexOf(base) === -1) return base;
    for (var n = 2; n < 100; n++) if (ids.indexOf(base + n) === -1) return base + n;
    throw new Error('Too many visits on this device for this hospital and date.');
  }

  /** "Name – office" lines into a list (split at a spaced dash); blank lines skipped. */
  function parsePeople(text) {
    return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
      var m = l.split(/\s+[–—-]\s+/);
      return { name: m[0].trim(), role: m.slice(1).join(' – ').trim() };
    });
  }

  function peopleText(list) {
    return (list || []).map(function (p) { return p.role ? p.name + ' – ' + p.role : p.name; }).join('\n');
  }

  function validateVisit(v, services) {
    var e = [];
    if (!v.hospitalId) e.push('Choose the hospital.');
    if (VISIT_TYPES.indexOf(v.visitType) === -1) e.push('Choose the visit type.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.visitDate || '')) e.push('Enter the visit date.');
    (services || []).forEach(function (s) {
      if (['Yes', 'No'].indexOf((v.services || {})[s.key]) === -1) e.push('Answer: ' + s.label + '?');
    });
    if (!v.team || !v.team.length) e.push('Tick at least one team member.');
    if (!v.leaderId || !(v.team || []).some(function (t) { return t.memberId === v.leaderId; })) e.push('Choose the team leader from the ticked team members.');
    return e;
  }

  function groupsFor(visit, memberId) {
    return (visit.groups || []).filter(function (g) { return g.assignedTo === memberId; });
  }

  function assignmentFingerprint(v) {
    return JSON.stringify([v.visitType, v.visitDate, v.startTime, v.leaderId, v.team, v.guests, v.representatives, v.services,
      (v.groups || []).map(function (g) { return [g.groupId, g.assignedTo, g.questionIds.length]; })]);
  }

  var ASSIGNMENT_KIND = 'HDMP VITALS 2.0 assignment';

  function assignmentFile(v) {
    return {
      kind: ASSIGNMENT_KIND, fileVersion: 1, appVersion: APP_VERSION,
      visitId: v.visitId, assignmentVersion: v.assignmentVersion, exportedAt: v.lastExportedAt,
      hospitalId: v.hospitalId, hospitalCode: v.hospitalCode, hospitalName: v.hospitalName, level: v.level,
      visitType: v.visitType, visitDate: v.visitDate, startTime: v.startTime,
      leaderId: v.leaderId, team: v.team, guests: v.guests, representatives: v.representatives,
      services: v.services, questionBankVersion: v.questionBankVersion,
      createdOnDevice: v.createdOnDevice, createdBy: v.createdBy, createdAt: v.createdAt,
      groups: (v.groups || []).map(function (g) {
        return { groupId: g.groupId, layer: g.layer, systemCode: g.systemCode, systemName: g.systemName, questionIds: g.questionIds, assignedTo: g.assignedTo };
      })
    };
  }

  /**
   * Checks an assignment file before it is kept on a member device.
   * Refuses: not an assignment file, field pack for that hospital missing, question bank differs,
   * question not in this device's pack, visit made on this device, older than the copy already here.
   */
  function checkAssignmentFile(f, packRecord, existing, me) {
    var problems = [], warnings = [];
    if (!f || f.kind !== ASSIGNMENT_KIND || f.fileVersion !== 1) return { ok: false, problems: ['This is not a VITALS 2.0 assignment file.'], warnings: [] };
    if (!/^INS-([A-Z0-9]+)-(\d{8})-([A-Za-z0-9]+)$/.test(String(f.visitId || ''))) problems.push('The visit ID in the file is not valid.');
    if (!packRecord) problems.push('The field pack for ' + (f.hospitalName || f.hospitalId) + ' is not on this device. Download it on the Hospitals tab first, then open the file again.');
    else {
      if (String(packRecord.hospitalId) !== String(f.hospitalId)) problems.push('The file is for another hospital.');
      if (String(packRecord.questionBankVersion) !== String(f.questionBankVersion)) {
        problems.push('The file uses questions v' + f.questionBankVersion + ' but this device has v' + packRecord.questionBankVersion + ' for this hospital. Update the field pack so both match.');
      } else {
        var have = {};
        (packRecord.pack.questions || []).forEach(function (q) { have[String(q.QuestionID)] = true; });
        var missing = 0;
        (f.groups || []).forEach(function (g) { (g.questionIds || []).forEach(function (id) { if (!have[id]) missing++; }); });
        if (missing) problems.push(missing + ' questions in the file are not in this device\'s field pack. Update the field pack.');
      }
    }
    if (me && f.createdOnDevice === me.deviceCode) problems.push('This visit was created on this device. The assignment file is for the other team members\' devices.');
    if (existing) {
      if (existing.role === 'leader') problems.push('This device is the team leader\'s device for this visit.');
      else if (Number(existing.assignmentVersion) > Number(f.assignmentVersion)) problems.push('This device already has a newer assignment (version ' + existing.assignmentVersion + ') for this visit.');
      else if (Number(existing.assignmentVersion) === Number(f.assignmentVersion)) warnings.push('This device already has this assignment. Nothing changes.');
    }
    if (me && !(f.team || []).some(function (t) { return t.memberId === me.memberId; })) warnings.push('You are not on the team for this visit. The visit will open for viewing only.');
    else if (me && !(f.groups || []).some(function (g) { return g.assignedTo === me.memberId; })) warnings.push('No question groups are assigned to you yet.');
    return { ok: problems.length === 0, problems: problems, warnings: warnings };
  }

  function visitFromFile(f, existing) {
    var v = Object.assign({}, f);
    delete v.kind; delete v.fileVersion; delete v.appVersion;
    v.role = 'member';
    v.status = (existing && existing.status) || 'Draft';
    v.importedAt = new Date().toISOString();
    v.updatedAt = v.importedAt;
    return v;
  }

  var pure = {
    APP_VERSION: APP_VERSION, QUESTION_BANK_VERSION: QUESTION_BANK_VERSION,
    validServiceUrl: validServiceUrl, normMemberId: normMemberId, normKey: normKey, newDeviceCode: newDeviceCode,
    packSummary: packSummary, formatManila: formatManila, readyLine: readyLine, shortReadyLine: shortReadyLine, packNeedsUpdate: packNeedsUpdate,
    friendlyError: friendlyError, escapeHtml: escapeHtml, makeRecord: makeRecord,
    VISIT_TYPES: VISIT_TYPES, SYSTEMS: SYSTEMS, SERVICES: SERVICES, serviceKeyFor: serviceKeyFor,
    relevantServices: relevantServices, applicableQuestions: applicableQuestions, buildGroups: buildGroups,
    mergeAssignments: mergeAssignments, todayManila: todayManila, makeVisitId: makeVisitId, parsePeople: parsePeople,
    peopleText: peopleText, validateVisit: validateVisit, groupsFor: groupsFor, assignmentFingerprint: assignmentFingerprint,
    assignmentFile: assignmentFile, checkAssignmentFile: checkAssignmentFile, visitFromFile: visitFromFile
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
        if (!d.objectStoreNames.contains('visits')) d.createObjectStore('visits', { keyPath: 'visitId' });
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
    visits: function () { return tx('visits', 'readonly', function (s) { return s.getAll(); }).then(function (a) { return a || []; }); },
    putVisit: function (v) { return tx('visits', 'readwrite', function (s) { return s.put(v); }); },
    deleteVisit: function (id) { return tx('visits', 'readwrite', function (s) { return s.delete(id); }); },
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

  /** Team list; an older Sync Service without the 'team' request gives an empty list instead of stopping setup. */
  function fetchTeam(settings) {
    return call(settings, 'team').then(function (t) { return { team: t || [], note: '' }; }).catch(function (err) {
      var m = friendlyError(err);
      if (/Unknown action/i.test(m)) return { team: [], note: 'The team list is not available: the Sync Service needs version 0.4.0.' };
      throw err;
    });
  }

  /* ------------------------------------------------------------------ */
  /* App state                                                           */
  /* ------------------------------------------------------------------ */

  var state = { settings: null, hospitals: [], packs: [], team: [], visits: [], installEvent: null, swReg: null, busy: false, flash: null };
  var view = document.getElementById('view');

  function setFlash(kind, text) { state.flash = { kind: kind, text: text }; }
  function takeFlash() {
    var f = state.flash;
    state.flash = null;
    return f ? '<div class="msg ' + f.kind + '">' + escapeHtml(f.text) + '</div>' : '';
  }

  function loadState() {
    return Promise.all([store.get('settings'), store.get('hospitals'), store.packs(), store.get('team'), store.visits()]).then(function (r) {
      state.team = r[3] || [];
      state.visits = (r[4] || []).sort(function (a, b) { return String(b.visitDate + b.createdAt).localeCompare(String(a.visitDate + a.createdAt)); });
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
    var t = (window.location.hash || '#home').slice(1).split('/')[0];
    if (t === 'visit' || t === 'visit-new' || t === 'visit-edit') return 'visits';
    return ['home', 'visits', 'packs', 'setup', 'about'].indexOf(t) === -1 ? 'home' : t;
  }

  function route() {
    var tab = currentTab();
    Array.prototype.forEach.call(document.querySelectorAll('nav.tabs a'), function (a) {
      a.classList.toggle('on', a.getAttribute('data-tab') === tab);
      if (a.getAttribute('data-tab') === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    renderHeader();
    var h = (window.location.hash || '').slice(1).split('/');
    if (h[0] === 'visit-new') return viewVisitForm(null);
    if (h[0] === 'visit-edit') return viewVisitForm(decodeURIComponent(h[1] || ''));
    if (h[0] === 'visit') return viewVisit(decodeURIComponent(h[1] || ''));
    if (tab === 'visits') return viewVisits();
    if (tab === 'packs') return viewPacks();
    if (tab === 'setup') return viewSetup();
    if (tab === 'about') return viewAbout();
    return viewHome();
  }
  window.addEventListener('hashchange', route);

  /** Opens a screen once (changing the address already redraws, so it is not drawn twice). */
  function go(where) {
    if (window.location.hash === '#' + where) route();
    else window.location.hash = '#' + where;
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

      html += '<div class="card ice"><h2>Visits</h2>' + (state.visits.length
        ? '<p class="small">' + state.visits.length + ' visit' + (state.visits.length > 1 ? 's' : '') + ' on this device. Latest: ' +
          escapeHtml(state.visits[0].hospitalName + ', ' + state.visits[0].visitDate + ' (' + state.visits[0].visitType + ')') + '</p>'
        : '<p class="small">No visits on this device yet.</p>') +
        '<a class="btn" href="#visits">Open visits</a>' +
        '<p class="small muted" style="margin-top:10px">Answering questions comes in the next update of the app.</p></div>';

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
      var teamNote = '';
      call(trial, 'whoami').then(function (member) {
        trial.member = member;
        trial.checkedAt = new Date().toISOString();
        return Promise.all([call(trial, 'hospitals'), fetchTeam(trial)]).then(function (r) {
          teamNote = r[1].note;
          return store.set('settings', trial).then(function () { return store.set('hospitals', r[0]); }).then(function () {
            return store.set('team', r[1].team);
          }).then(function () {
            return store.set('hospitalsAt', new Date().toISOString());
          });
        });
      }).then(function () {
        return askPersist();
      }).then(function () {
        return loadState();
      }).then(function () {
        state.busy = false;
        setFlash(teamNote ? 'info' : 'ok', 'Setup saved. Welcome, ' + state.settings.member.FullName + '. Next: download the hospitals you will visit.' + (teamNote ? ' ' + teamNote : ''));
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
      packMessage('info', 'Getting the hospital and team lists…');
      var note = '';
      Promise.all([call(state.settings, 'hospitals'), fetchTeam(state.settings)]).then(function (r) {
        note = r[1].note;
        return store.set('hospitals', r[0]).then(function () { return store.set('team', r[1].team); })
          .then(function () { return store.set('hospitalsAt', new Date().toISOString()); });
      }).then(loadState).then(function () {
        state.busy = false;
        setFlash(note ? 'info' : 'ok', note ? 'Hospital list updated. ' + note : 'Hospital and team lists updated (' + state.team.length + ' team members).');
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
        '<div class="card"><h2>What this version does</h2><p class="small">Installs, works offline, sets up the device, downloads field packs, ' +
        'and sets up visits with question groups assigned to team members. ' +
        'Answering, photos, merging devices, scores and the closing conference package follow in the next versions.</p></div>' +
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

  /* ------------------------------------------------------------------ */
  /* Visits (Task 4)                                                     */
  /* ------------------------------------------------------------------ */

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function visitById(id) {
    for (var i = 0; i < state.visits.length; i++) if (state.visits[i].visitId === id) return state.visits[i];
    return null;
  }

  function memberName(id) {
    for (var i = 0; i < state.team.length; i++) if (state.team[i].MemberID === id) return state.team[i].FullName;
    return id;
  }

  function teamLabel(v, id) {
    var t = (v.team || []).filter(function (x) { return x.memberId === id; })[0];
    return t ? t.name : memberName(id);
  }

  function visitCounts(v) {
    var c = { total: 0, assigned: 0 };
    LAYERS.forEach(function (l) { c[l] = 0; });
    (v.groups || []).forEach(function (g) {
      c.total += g.questionIds.length;
      c[g.layer] = (c[g.layer] || 0) + g.questionIds.length;
      if (g.assignedTo) c.assigned += g.questionIds.length;
    });
    return c;
  }

  function viewVisits() {
    var s = state.settings;
    var html = '<h1>Visits</h1>' + takeFlash();
    if (!s) {
      view.innerHTML = html + '<div class="card mist"><p>Set up this device first.</p><a class="btn" href="#setup">Go to setup</a></div>' + footer();
      return;
    }
    html += '<div class="card"><h2>Start or join a visit</h2>' +
      '<p class="small">The <b>team leader</b> starts the visit on the laptop, assigns question groups, and shares an assignment file. ' +
      'Each <b>team member</b> opens that file on their own device.</p>' +
      '<div class="row"><a class="btn" href="#visit-new">Start a visit</a>' +
      '<label class="btn secondary" style="margin:0" for="importFile">Open an assignment file</label>' +
      '<input type="file" id="importFile" accept=".json,application/json" class="hidden"></div>' +
      '<div id="importMsg"></div></div>';
    html += '<div class="card"><h2>Visits on this device</h2>';
    if (!state.visits.length) html += '<p class="small muted">None yet.</p>';
    state.visits.forEach(function (v) {
      var mine = groupsFor(v, s.memberId).length;
      var c = visitCounts(v);
      html += '<div class="hosp"><div class="grow"><div class="name">' + escapeHtml(v.hospitalName) + ' · ' + escapeHtml(v.visitDate) + '</div>' +
        '<div><span class="tag">' + escapeHtml(v.visitType) + '</span><span class="tag">' + (v.role === 'leader' ? 'Team leader device' : 'Member device') +
        '</span><span class="tag">' + escapeHtml(v.status) + '</span></div>' +
        '<div class="small muted">' + escapeHtml(v.visitId) + ' · ' + c.total + ' questions · ' + mine + ' group' + (mine === 1 ? '' : 's') + ' assigned to you</div></div>' +
        '<a class="btn secondary" href="#visit/' + encodeURIComponent(v.visitId) + '">Open</a></div>';
    });
    html += '</div>' + footer();
    view.innerHTML = html;
    document.getElementById('importFile').addEventListener('change', onImportFile);
  }

  function onImportFile(e) {
    var file = e.target.files && e.target.files[0];
    var msg = document.getElementById('importMsg');
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var f;
      try { f = JSON.parse(String(reader.result)); } catch (err) {
        msg.innerHTML = '<div class="msg err">This file could not be read. Open the assignment file shared by the team leader.</div>';
        return;
      }
      var existing = f && f.visitId ? visitById(f.visitId) : null;
      var check = checkAssignmentFile(f, f ? packFor(f.hospitalId) : null, existing, state.settings);
      if (!check.ok) {
        msg.innerHTML = '<div class="msg err">Not opened.<br>' + check.problems.map(escapeHtml).join('<br>') + '</div>';
        return;
      }
      var v = visitFromFile(f, existing);
      store.putVisit(v).then(loadState).then(function () {
        setFlash(check.warnings.length ? 'info' : 'ok', 'Assignment opened: ' + v.hospitalName + ', ' + v.visitDate + ' (version ' + v.assignmentVersion + ').' +
          (check.warnings.length ? ' ' + check.warnings.join(' ') : ''));
        go('visit/' + encodeURIComponent(v.visitId));
      }).catch(function (err) {
        msg.innerHTML = '<div class="msg err">' + escapeHtml(friendlyError(err)) + '</div>';
      });
    };
    reader.onerror = function () { msg.innerHTML = '<div class="msg err">This file could not be read.</div>'; };
    reader.readAsText(file);
  }

  function radio(name, value, current) {
    return '<label class="choice"><input type="radio" name="' + name + '" value="' + value + '"' + (current === value ? ' checked' : '') + '> ' + value + '</label>';
  }

  function viewVisitForm(editId) {
    var s = state.settings;
    var html = '<h1>' + (editId ? 'Edit visit details' : 'Start a visit') + '</h1>' + takeFlash();
    if (!s) {
      view.innerHTML = html + '<div class="card mist"><p>Set up this device first.</p><a class="btn" href="#setup">Go to setup</a></div>' + footer();
      return;
    }
    var v = editId ? visitById(editId) : null;
    if (editId && (!v || v.role !== 'leader')) {
      view.innerHTML = html + '<div class="card"><div class="msg err">Only the team leader\'s device can edit this visit.</div></div>' + footer();
      return;
    }
    if (!state.packs.length) {
      view.innerHTML = html + '<div class="card mist"><p>Download the field pack for the hospital first.</p><a class="btn" href="#packs">Go to Hospitals</a></div>' + footer();
      return;
    }
    var team = state.team.length ? state.team : [{ MemberID: s.memberId, FullName: s.member.FullName, Unit: s.member.Unit, Position: s.member.Position }];
    var picked = v ? v.team.map(function (t) { return t.memberId; }) : [s.memberId];
    var hid = v ? v.hospitalId : (state.packs.length === 1 ? state.packs[0].hospitalId : '');

    html += '<form id="visitForm" novalidate autocomplete="off">';
    html += '<div class="card"><h2>1. Visit</h2>' +
      '<label for="vHosp">Hospital</label><select id="vHosp"' + (v ? ' disabled' : '') + '><option value="">Choose…</option>' +
      state.packs.map(function (p) { return '<option value="' + escapeHtml(p.hospitalId) + '"' + (p.hospitalId === hid ? ' selected' : '') + '>' +
        escapeHtml(p.hospitalName + ' (' + p.level + ')') + '</option>'; }).join('') + '</select>' +
      '<div class="hint">Only hospitals with a field pack on this device are listed.' + (v ? ' The hospital and date cannot change after the visit is created.' : '') + '</div>' +
      '<label for="vType">Visit type</label><select id="vType"><option value="">Choose…</option>' +
      VISIT_TYPES.map(function (t) { return '<option' + (v && v.visitType === t ? ' selected' : '') + '>' + t + '</option>'; }).join('') + '</select>' +
      '<div class="row"><div class="grow"><label for="vDate">Visit date</label><input type="date" id="vDate" value="' + escapeHtml(v ? v.visitDate : todayManila()) + '"' + (v ? ' disabled' : '') + '></div>' +
      '<div class="grow"><label for="vStart">Start time</label><input type="time" id="vStart" value="' + escapeHtml(v ? v.startTime || '' : '') + '"></div></div></div>';

    html += '<div class="card"><h2>2. Services at this hospital</h2><p class="small">Answer once per visit. Questions for a service the hospital does not run are not asked.</p>' +
      '<div id="svcBox"></div></div>';

    html += '<div class="card"><h2>3. Team</h2><p class="small muted">' + (state.team.length ? 'Tick the HDMP team members on this visit.' :
      'The team list is not on this device yet. Refresh it on the Hospitals tab while online.') + '</p><div id="teamBox">' +
      team.map(function (m) {
        return '<label class="choice block"><input type="checkbox" name="team" value="' + escapeHtml(m.MemberID) + '"' + (picked.indexOf(m.MemberID) !== -1 ? ' checked' : '') + '> ' +
          escapeHtml(m.FullName) + ' <span class="muted small">· ' + escapeHtml(m.Unit) + (m.Position ? ' · ' + escapeHtml(m.Position) : '') + '</span></label>';
      }).join('') + '</div>' +
      '<label for="vLeader">Team leader</label><select id="vLeader"></select>' +
      '<label for="vGuests">Other participants (optional)</label><textarea id="vGuests" rows="2" placeholder="One per line: Name – office">' + escapeHtml(v ? peopleText(v.guests) : '') + '</textarea>' +
      '<div class="hint">For example: Juan Dela Cruz – Provincial Engineering Office. Other participants are listed in the report; question groups go to HDMP team members.</div></div>';

    html += '<div class="card"><h2>4. Hospital representatives</h2>' +
      '<label for="vReps">Names and positions</label><textarea id="vReps" rows="3" placeholder="One per line: Name – position">' + escapeHtml(v ? peopleText(v.representatives) : '') + '</textarea>' +
      '<div class="hint">For example: Maria Santos – Chief of Hospital. You can add or change these later.</div></div>';

    html += '<div class="card"><div class="row"><button type="submit" id="saveVisit">' + (v ? 'Save changes' : 'Create visit') + '</button>' +
      '<a class="btn secondary" href="' + (v ? '#visit/' + encodeURIComponent(v.visitId) : '#visits') + '">Cancel</a></div><div id="visitMsg"></div></div></form>' + footer();
    view.innerHTML = html;

    var hospSel = document.getElementById('vHosp');
    var drawServices = function () {
      var p = packFor(hospSel.value);
      var box = document.getElementById('svcBox');
      if (!p) { box.innerHTML = '<p class="small muted">Choose the hospital first.</p>'; return; }
      var rel = relevantServices(p.pack.questions);
      if (!rel.length) { box.innerHTML = '<p class="small muted">No service questions for this hospital\'s level.</p>'; return; }
      var cur = v ? v.services || {} : {};
      box.innerHTML = rel.map(function (sv) {
        return '<div class="svc"><div class="grow">' + escapeHtml(sv.label) + '? <span class="muted small">(' + sv.count + ' question' + (sv.count === 1 ? '' : 's') + ')</span></div>' +
          '<div class="row">' + radio('svc-' + sv.key, 'Yes', cur[sv.key]) + radio('svc-' + sv.key, 'No', cur[sv.key]) + '</div></div>';
      }).join('');
    };
    var drawLeader = function () {
      var sel = document.getElementById('vLeader');
      var chosen = sel.value || (v ? v.leaderId : s.memberId);
      var ticked = Array.prototype.filter.call(document.querySelectorAll('input[name=team]'), function (c) { return c.checked; }).map(function (c) { return c.value; });
      sel.innerHTML = '<option value="">Choose…</option>' + ticked.map(function (id) {
        var m = team.filter(function (t) { return t.MemberID === id; })[0];
        return '<option value="' + escapeHtml(id) + '"' + (id === chosen ? ' selected' : '') + '>' + escapeHtml(m ? m.FullName : id) + '</option>';
      }).join('');
    };
    hospSel.addEventListener('change', drawServices);
    document.getElementById('teamBox').addEventListener('change', drawLeader);
    drawServices();
    drawLeader();

    document.getElementById('visitForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = document.getElementById('visitMsg');
      var p = packFor(hospSel.value);
      var rel = p ? relevantServices(p.pack.questions) : [];
      var services = {};
      rel.forEach(function (sv) {
        var c = document.querySelector('input[name="svc-' + sv.key + '"]:checked');
        if (c) services[sv.key] = c.value;
      });
      var teamPicked = Array.prototype.filter.call(document.querySelectorAll('input[name=team]'), function (c) { return c.checked; }).map(function (c) {
        var m = team.filter(function (t) { return t.MemberID === c.value; })[0] || { MemberID: c.value, FullName: c.value, Unit: '' };
        return { memberId: m.MemberID, name: m.FullName, unit: m.Unit };
      });
      var draft = {
        hospitalId: hospSel.value, visitType: document.getElementById('vType').value, visitDate: document.getElementById('vDate').value,
        startTime: document.getElementById('vStart').value, services: services, team: teamPicked, leaderId: document.getElementById('vLeader').value,
        guests: parsePeople(document.getElementById('vGuests').value), representatives: parsePeople(document.getElementById('vReps').value)
      };
      var problems = validateVisit(draft, rel);
      if (problems.length) { msg.innerHTML = '<div class="msg err">' + problems.map(escapeHtml).join('<br>') + '</div>'; return; }
      var now = new Date().toISOString();
      var newGroups = buildGroups(applicableQuestions(p.pack.questions, services));
      var rec;
      if (v) {
        rec = Object.assign({}, v, draft, {
          hospitalId: v.hospitalId, visitDate: v.visitDate, updatedAt: now,
          groups: mergeAssignments(v.groups, newGroups, teamPicked.map(function (t) { return t.memberId; }))
        });
      } else {
        rec = Object.assign({}, draft, {
          visitId: makeVisitId(p.hospitalCode, draft.visitDate, s.deviceCode, state.visits.map(function (x) { return x.visitId; })),
          hospitalCode: p.hospitalCode, hospitalName: p.hospitalName, level: p.level, questionBankVersion: p.questionBankVersion,
          status: 'Draft', role: 'leader', createdOnDevice: s.deviceCode, createdBy: s.memberId, createdAt: now, updatedAt: now,
          assignmentVersion: 0, lastExportedAt: '', lastExportedFingerprint: '', groups: newGroups
        });
      }
      store.putVisit(rec).then(loadState).then(function () {
        setFlash('ok', v ? 'Visit details saved.' : 'Visit created: ' + rec.visitId + '. Next: assign the question groups.');
        go('visit/' + encodeURIComponent(rec.visitId));
      }).catch(function (err) { msg.innerHTML = '<div class="msg err">' + escapeHtml(friendlyError(err)) + '</div>'; });
    });
  }

  function viewVisit(id) {
    var s = state.settings;
    var v = visitById(id);
    var html = takeFlash();
    if (!v || !s) {
      view.innerHTML = '<h1>Visit</h1>' + html + '<div class="card"><div class="msg err">This visit is not on this device.</div><a class="btn secondary" href="#visits">Back to visits</a></div>' + footer();
      return;
    }
    var leader = v.role === 'leader';
    var c = visitCounts(v);
    var mine = groupsFor(v, s.memberId);
    var changed = leader && assignmentFingerprint(v) !== v.lastExportedFingerprint;
    var pack = packFor(v.hospitalId);
    var svcRel = pack ? relevantServices(pack.pack.questions) : [];

    html = '<h1>' + escapeHtml(v.hospitalName) + '</h1>' + html;
    html += '<div class="card mist"><p style="margin:0"><b>' + escapeHtml(v.visitType) + '</b> · ' + escapeHtml(v.visitDate) + (v.startTime ? ', ' + escapeHtml(v.startTime) : '') +
      ' · ' + escapeHtml(v.status) + '<br><span class="small">' + escapeHtml(v.visitId) + ' · questions v' + escapeHtml(v.questionBankVersion) +
      ' · ' + (leader ? 'Team leader device' : 'Member device, assignment version ' + escapeHtml(v.assignmentVersion)) + '</span></p></div>';

    if (mine.length) {
      html += '<div class="card"><h2>Your question groups</h2>' + mine.map(function (g) {
        return '<div class="check"><span class="sym s-prog" aria-hidden="true">●</span><div class="grow"><span class="status-label">' + escapeHtml(g.layer + ' · ' + g.systemName) +
          '</span><div class="small muted">' + plural(g.questionIds.length, 'question') + '</div></div></div>';
      }).join('') + '<p class="small muted" style="margin-top:8px">Answering opens in the next update of the app.</p></div>';
    }

    html += '<div class="card"><h2>Questions for this visit</h2><div class="kpis">' +
      '<div class="kpi"><b>' + c.total + '</b><span>Questions asked</span></div>' +
      LAYERS.map(function (l) { return '<div class="kpi"><b>' + (c[l] || 0) + '</b><span>' + l + '</span></div>'; }).join('') +
      '<div class="kpi"><b>' + c.assigned + '</b><span>Assigned</span></div></div>' +
      (svcRel.length ? '<p class="small" style="margin-top:10px">Services: ' + svcRel.map(function (sv) {
        return escapeHtml(sv.label) + ' — <b>' + escapeHtml((v.services || {})[sv.key] || 'not answered') + '</b>';
      }).join('; ') + '</p>' : '') + '</div>';

    html += '<div class="card"><h2>Team</h2><p class="small">' + (v.team || []).map(function (t) {
      return escapeHtml(t.name) + (t.memberId === v.leaderId ? ' <b>(team leader)</b>' : '') + ' · ' + escapeHtml(t.unit);
    }).join('<br>') + '</p>' +
      ((v.guests || []).length ? '<p class="small"><b>Other participants:</b><br>' + v.guests.map(function (g) { return escapeHtml(g.role ? g.name + ' – ' + g.role : g.name); }).join('<br>') + '</p>' : '') +
      '<p class="small"><b>Hospital representatives:</b><br>' + ((v.representatives || []).length ? v.representatives.map(function (g) {
        return escapeHtml(g.role ? g.name + ' – ' + g.role : g.name);
      }).join('<br>') : '<span class="muted">None entered yet</span>') + '</p></div>';

    html += '<div class="card"><h2>Question groups</h2>' + (leader ? '<p class="small">Assign each group to one team member. A person can have several groups.</p>' : '');
    var options = (v.team || []).map(function (t) { return [t.memberId, t.name]; });
    LAYERS.forEach(function (layer) {
      var gs = (v.groups || []).filter(function (g) { return g.layer === layer; });
      if (!gs.length) return;
      html += '<h3 class="layer">' + layer + '</h3>';
      gs.forEach(function (g) {
        html += '<div class="grp"><div class="grow"><b>' + escapeHtml(g.systemName) + '</b><div class="small muted">' + plural(g.questionIds.length, 'question') + '</div></div>';
        if (leader) {
          html += '<select data-group="' + escapeHtml(g.groupId) + '" aria-label="Assign ' + escapeHtml(layer + ' ' + g.systemName) + '"><option value="">Not assigned</option>' +
            options.map(function (o) { return '<option value="' + escapeHtml(o[0]) + '"' + (g.assignedTo === o[0] ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>'; }).join('') + '</select>';
        } else {
          html += '<span class="' + (g.assignedTo === s.memberId ? 'tag on' : 'tag') + '">' + escapeHtml(g.assignedTo ? (g.assignedTo === s.memberId ? 'You' : teamLabel(v, g.assignedTo)) : 'Not assigned') + '</span>';
        }
        html += '</div>';
      });
    });
    html += '</div>';

    if (leader) {
      var unassigned = (v.groups || []).filter(function (g) { return !g.assignedTo; }).length;
      html += '<div class="card"><h2>Share the assignment</h2>' +
        (unassigned ? '<p class="small s-att">▲ ' + unassigned + ' group' + (unassigned === 1 ? ' is' : 's are') + ' not assigned yet.</p>' : '<p class="small s-ok">✓ Every group is assigned.</p>') +
        '<p class="small">Send the file to each team member (AirDrop, Nearby Share, Messenger, email or a cable). They open it on the Visits tab of their app.</p>' +
        (v.assignmentVersion ? '<p class="small muted">Last shared: version ' + v.assignmentVersion + ', ' + escapeHtml(formatManila(v.lastExportedAt)) +
          (changed ? '. <b class="s-att">Changed since then — share again.</b>' : '.') + '</p>' : '') +
        '<div class="row"><button id="shareBtn" type="button">Share assignment file</button>' +
        '<a class="btn secondary" href="#visit-edit/' + encodeURIComponent(v.visitId) + '">Edit visit details</a></div><div id="shareMsg"></div></div>';
      html += '<div class="card"><h2>Delete this visit</h2><p class="small">Removes the visit from this device only. Use it if the visit was created by mistake.</p>' +
        '<button class="danger" id="delVisit" type="button">Delete visit</button></div>';
    } else {
      html += '<div class="card"><p class="small">To get changes from the team leader, open the new assignment file on the Visits tab.</p>' +
        '<button class="danger" id="delVisit" type="button">Remove this visit from this device</button></div>';
    }
    html += footer();
    view.innerHTML = html;

    Array.prototype.forEach.call(view.querySelectorAll('select[data-group]'), function (sel) {
      sel.addEventListener('change', function () {
        var gid = sel.getAttribute('data-group');
        var rec = Object.assign({}, v, {
          updatedAt: new Date().toISOString(),
          groups: v.groups.map(function (g) { return g.groupId === gid ? Object.assign({}, g, { assignedTo: sel.value }) : g; })
        });
        store.putVisit(rec).then(loadState).then(function () { route(); });
      });
    });
    var sb = document.getElementById('shareBtn');
    if (sb) sb.addEventListener('click', function () { shareAssignment(v); });
    var db2 = document.getElementById('delVisit');
    if (db2) db2.addEventListener('click', function () {
      if (!window.confirm('Delete visit ' + v.visitId + ' from this device?')) return;
      store.deleteVisit(v.visitId).then(loadState).then(function () {
        setFlash('ok', 'Visit ' + v.visitId + ' was removed from this device.');
        go('visits');
      });
    });
  }

  function shareAssignment(v) {
    var msg = document.getElementById('shareMsg');
    var fp = assignmentFingerprint(v);
    var rec = Object.assign({}, v);
    if (fp !== v.lastExportedFingerprint || !v.assignmentVersion) {
      rec.assignmentVersion = (Number(v.assignmentVersion) || 0) + 1;
      rec.lastExportedAt = new Date().toISOString();
      rec.lastExportedFingerprint = fp;
    }
    var name = 'VITALS-assignment-' + rec.visitId + '-v' + rec.assignmentVersion + '.json';
    var text = JSON.stringify(assignmentFile(rec), null, 1);
    store.putVisit(rec).then(loadState).then(function () {
      var blob = new Blob([text], { type: 'application/json' });
      var file = typeof File !== 'undefined' ? new File([blob], name, { type: 'application/json' }) : null;
      var done = function (how) {
        setFlash('ok', 'Assignment version ' + rec.assignmentVersion + ' ' + how + ': ' + name);
        route();
      };
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && /Android|iPhone|iPad|iPod/.test(navigator.userAgent)) {
        navigator.share({ files: [file], title: name }).then(function () { done('shared'); }).catch(function () { download(blob, name); done('saved'); });
      } else {
        download(blob, name);
        done('saved to Downloads');
      }
    }).catch(function (err) { if (msg) msg.innerHTML = '<div class="msg err">' + escapeHtml(friendlyError(err)) + '</div>'; });
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
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
