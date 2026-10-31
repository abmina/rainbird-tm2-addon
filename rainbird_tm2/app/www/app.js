'use strict';
/* Rain Bird ESP-TM2 web UI. All URLs are relative so it works behind HA ingress. */
const $ = (id) => document.getElementById(id);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let S = null; // latest state snapshot
let current = 'A'; // program being edited
const drafts = {}; // program name -> draft (only while dirty)
let zonesRendered = false;

// ------------------------------------------------------------------ api
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
    throw e;
  } finally {
    if (btn) btn.disabled = false;
  }
}
let toastT;
function toast(msg, err) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), err ? 6000 : 2500);
}

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const zoneName = (z) => (S.zones.find((x) => x.zone === Number(z)) || {}).name || `Zone ${z}`;
const fmtDur = (s) => {
  if (s == null) return '';
  const m = Math.floor(s / 60), sec = s % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(sec).padStart(2, '0')}`;
};
const fmtWhen = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
// True only while the user is typing in an input inside el - buttons keeping focus after a click don't count.
const editingIn = (el) => document.activeElement && document.activeElement.tagName === 'INPUT' && el.contains(document.activeElement);
const programOf = (name) => S && S.schedule && S.schedule.programs.find((p) => p.name === name);

// ------------------------------------------------------------------ tabs
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t.dataset.tab}`));
  if (t.dataset.tab === 'log') loadLog();
}));

// ------------------------------------------------------------------ render
let setupOpen = false;
function render() {
  if (!S) return;
  const inSetup = setupOpen || !(S.setup && S.setup.configured);
  $('setupView').hidden = !inSetup;
  document.querySelector('main').hidden = inSetup;
  document.querySelector('.tabs').hidden = inSetup;
  $('btnSetupCancel').hidden = !(S.setup && S.setup.configured);
  renderHeader();
  if (inSetup) return;
  if (!S.status) return;
  renderHero();
  renderStats();
  renderProgramSummary();
  renderQuickZones();
  renderProgramSeg();
  if (!drafts[current]) renderEditor();
  if (!zonesRendered || !editingIn($('tab-zones'))) renderZoneSettings();
  renderController();
}

function renderHeader() {
  const c = S.connection;
  const i = S.info;
  $('title').textContent = i ? `${i.model}` : 'Rain Bird';
  if (!S.setup || !S.setup.configured) { $('subtitle').textContent = 'Not set up yet'; $('conn').className = 'conn'; $('connText').textContent = 'Setup'; return; }
  $('subtitle').textContent = i ? `${i.zones.length} zones · firmware ${i.firmware || '?'} · ${i.serial || ''}` : (c.lastError || 'Connecting to controller…');
  const conn = $('conn');
  conn.className = 'conn ' + (c.online ? 'online' : S.info ? 'offline' : '');
  $('connText').textContent = c.online ? `Local · ${(c.scheme || '').toUpperCase()}` : S.info ? 'Unreachable' : 'Connecting';
  conn.title = c.lastError || '';
}

let tickBase = null;
let runMax = null;
function renderHero() {
  const st = S.status;
  const hero = $('hero');
  hero.classList.toggle('watering', st.watering);
  $('btnStop').hidden = !st.watering;
  $('btnAdvance').hidden = !st.watering;
  if (st.watering) {
    $('heroLabel').textContent = 'Watering now';
    $('heroValue').textContent = st.activeZoneName || `Zone ${st.activeZone}`;
    if (!runMax || runMax.zone !== st.activeZone) runMax = { zone: st.activeZone, max: 0 };
    runMax.max = Math.max(runMax.max, st.remainingSeconds || 0);
    tickBase = st.remainingSeconds != null ? { at: Date.parse(st.updatedAt), rem: st.remainingSeconds } : null;
    if (!tickBase) { $('heroSub').textContent = 'Running'; $('progress').hidden = true; }
    tick();
  } else {
    tickBase = null;
    $('progress').hidden = true;
    $('heroLabel').textContent = st.rainDelay ? 'Rain delay active' : 'Idle';
    if (S.nextRun) {
      $('heroValue').textContent = fmtWhen(S.nextRun.at);
      $('heroSub').textContent = `Next run: program ${S.nextRun.program} · about ${S.nextRun.minutes} min`;
    } else {
      $('heroValue').textContent = 'Nothing scheduled';
      $('heroSub').textContent = S.schedule ? 'No program has both start times and run times.' : 'Reading schedule…';
    }
  }
}
function tick() {
  if (!tickBase) return;
  const rem = Math.max(0, tickBase.rem - Math.floor((Date.now() - tickBase.at) / 1000));
  $('heroSub').textContent = `${fmtDur(rem)} remaining`;
  $('progress').hidden = false;
  const total = Math.max(rem, runMax ? runMax.max : rem, 1);
  $('progressBar').style.width = `${Math.min(100, 100 - (rem / total) * 100)}%`;
}
setInterval(tick, 1000);

function renderStats() {
  const st = S.status;
  renderRainDelay();
  const bypass = S.schedule && S.schedule.global.rainSensorBypass;
  $('rainSensor').textContent = st.rainSensor ? 'Wet' : 'Dry';
  $('rainSensorFoot').textContent = bypass ? 'Bypassed - controller ignores it' : st.rainSensor ? 'Programs are suspended' : 'Watering allowed';
  const t = st.controllerTime.split('T')[1];
  $('ctrlClock').textContent = t.slice(0, 5);
  const d = st.clockDriftSeconds;
  $('ctrlDrift').textContent = (Math.abs(d) < 60 ? 'In sync' : `${d > 0 ? 'Ahead' : 'Behind'} by ${fmtDur(Math.abs(d))}`) + (st.timezone ? ` · ${st.timezone}` : '');
}

function renderProgramSummary() {
  const el = $('programSummary');
  if (!S.schedule) { el.innerHTML = '<div class="muted">Reading schedule from the controller…</div>'; return; }
  el.innerHTML = S.schedule.programs.map((p) => {
    const active = p.summary !== 'Not scheduled';
    return `<div class="row"><div class="badge ${active ? '' : 'off'}">${p.name}</div>
      <div class="grow"><div class="row-title">${esc(p.summary)}</div>
      <div class="muted">${active ? Object.entries(p.runTimes).filter(([, m]) => m).map(([z, m]) => `${esc(zoneName(z))} ${m}m`).join(' · ') : 'Tap Edit to set it up'}${p.seasonal !== 100 ? ` · seasonal ${p.seasonal}%` : ''}</div></div>
      <button class="btn small" data-edit="${p.name}">Edit</button>
      ${active ? `<button class="btn small" data-run="${p.name}">Run</button>` : ''}</div>`;
  }).join('');
}

function renderQuickZones() {
  const el = $('quickZones');
  const focused = editingIn(el) ? document.activeElement.dataset.z : null;
  if (focused) {
    // just update active highlighting while the user is typing
    el.querySelectorAll('.zone').forEach((z) => z.classList.toggle('active', S.status.activeZone === Number(z.dataset.zone)));
    return;
  }
  el.innerHTML = S.zones.map((z) => `<div class="zone ${z.active ? 'active' : ''}" data-zone="${z.zone}">
    <div class="zone-name"><span>${esc(z.name)}</span><span class="num-tag">#${z.zone}</span></div>
    <div class="zone-run"><input type="number" class="num" min="1" max="255" value="${z.defaultMinutes}" data-z="${z.zone}" aria-label="Minutes"> min
    <span class="spacer"></span>${z.active ? `<button class="btn small danger" data-stop>Stop</button>` : `<button class="btn small" data-runzone="${z.zone}">Run</button>`}</div></div>`).join('');
}

function renderProgramSeg() {
  const seg = $('progSeg');
  const names = S.programNames || ['A', 'B', 'C'];
  seg.innerHTML = names.map((n) => `<button data-prog="${n}" class="${n === current ? 'active' : ''}">Program ${n}${drafts[n] ? ' •' : ''}</button>`).join('');
}

// ------------------------------------------------------------------ program editor
function draft() {
  return drafts[current] || clone(programOf(current) || {});
}
function setDraft(d, opts = {}) {
  const orig = programOf(current);
  const same = JSON.stringify(normalize(d)) === JSON.stringify(normalize(orig));
  if (same) delete drafts[current]; else drafts[current] = d;
  $('progDirty').hidden = same;
  renderProgramSeg();
  renderEditor(d, opts);
}
function normalize(p) {
  if (!p) return null;
  return { frequency: p.frequency, days: [...p.days].sort(), cycleDays: p.cycleDays, daysRemaining: p.daysRemaining, daysOff: [...p.daysOff].sort(), seasonal: p.seasonal, starts: [...p.starts].sort(), runTimes: p.runTimes };
}

function renderEditor(d = draft(), opts = {}) {
  if (!S.schedule || !d.name) { $('progTitle').textContent = 'Reading schedule…'; return; }
  $('progTitle').textContent = `Program ${d.name}`;
  const saved = programOf(current);
  $('progNext').textContent = drafts[current] ? 'Next run will be recalculated after saving.'
    : saved && saved.nextRun ? `Next run: ${fmtWhen(saved.nextRun)}` : saved && saved.summary === 'Not scheduled' ? '' : 'No upcoming run in the next 60 days.';
  if (d.frequency === 'cyclic' && !drafts[current] && saved && saved.nextRun) {
    const days = Math.round((new Date(saved.nextRun).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    $('remainingHint').textContent = d.daysRemaining === 0 && days > 0
      ? `(0 = today is a watering day - today's start has passed, so the next run is in ${days} day${days === 1 ? '' : 's'})`
      : '(0 = today is a watering day)';
  } else $('remainingHint').textContent = '(0 = today is a watering day)';
  $('progDirty').hidden = !drafts[current];
  document.querySelectorAll('#freqSeg button').forEach((b) => b.classList.toggle('active', b.dataset.freq === d.frequency));
  $('daysField').hidden = d.frequency !== 'custom';
  $('cyclicField').hidden = d.frequency !== 'cyclic';
  $('daysOffField').hidden = d.frequency === 'custom';
  $('dayChips').innerHTML = DAYS.map((n, i) => `<button class="chip ${d.days.includes(i) ? 'on' : ''}" data-day="${i}">${n}</button>`).join('');
  $('offChips').innerHTML = DAYS.map((n, i) => `<button class="chip ${d.daysOff.includes(i) ? 'on' : ''}" data-off="${i}">${n}</button>`).join('');
  $('offChips').classList.add('off');
  if (document.activeElement !== $('cycleDays')) $('cycleDays').value = d.cycleDays || 1;
  if (document.activeElement !== $('daysRemaining')) $('daysRemaining').value = d.daysRemaining || 0;

  const slots = d.startSlots || 4;
  const st = $('starts');
  if (!opts.keepStarts && !editingIn(st)) {
    st.innerHTML = d.starts.map((t, i) => `<div class="start"><input type="time" value="${t}" data-start="${i}"><button data-rmstart="${i}" title="Remove">✕</button></div>`).join('')
      + (d.starts.length < slots ? `<button class="btn small" id="addStart">+ Add start time</button>` : '');
  }
  $('startsHint').textContent = d.starts.length ? `${d.starts.length} of ${slots} start times. Each start runs every zone below in order.` : 'No start times - this program will not run on its own.';

  const rt = $('runtimes');
  if (!editingIn(rt)) {
    rt.innerHTML = S.zones.map((z) => {
      const m = d.runTimes[z.zone] || 0;
      return `<div class="rt ${m ? '' : 'zero'}"><span class="rt-name">${esc(z.name)}</span><span><input type="number" class="num" min="0" max="360" value="${m}" data-rt="${z.zone}"> min</span></div>`;
    }).join('');
  }
  const total = Object.values(d.runTimes).reduce((a, b) => a + (Number(b) || 0), 0);
  $('runTotal').textContent = total ? `· ${total} min per start${d.seasonal !== 100 ? ` (${Math.round((total * d.seasonal) / 100)} min at ${d.seasonal}%)` : ''}` : '';
  if (document.activeElement !== $('seasonal')) $('seasonal').value = d.seasonal;
  $('seasonalVal').textContent = `${d.seasonal}%`;
  $('btnSave').disabled = !drafts[current];
  $('btnRevert').disabled = !drafts[current];
  const active = programOf(current) && programOf(current).summary !== 'Not scheduled';
  $('btnRunProg').disabled = !active;
}

$('progSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-prog]');
  if (!b) return;
  current = b.dataset.prog;
  $('writeLog').hidden = true;
  renderProgramSeg();
  renderEditor();
});
$('freqSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-freq]');
  if (!b) return;
  const d = draft();
  d.frequency = b.dataset.freq;
  if (d.frequency === 'cyclic' && !d.cycleDays) d.cycleDays = 2;
  setDraft(d);
});
$('dayChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  const d = draft();
  const i = Number(b.dataset.day);
  d.days = d.days.includes(i) ? d.days.filter((x) => x !== i) : [...d.days, i].sort();
  setDraft(d);
});
$('offChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-off]');
  if (!b) return;
  const d = draft();
  const i = Number(b.dataset.off);
  d.daysOff = d.daysOff.includes(i) ? d.daysOff.filter((x) => x !== i) : [...d.daysOff, i].sort();
  setDraft(d);
});
$('cycleDays').addEventListener('change', (e) => { const d = draft(); d.cycleDays = Number(e.target.value); if (d.daysRemaining >= d.cycleDays) d.daysRemaining = 0; setDraft(d); });
$('daysRemaining').addEventListener('change', (e) => { const d = draft(); d.daysRemaining = Number(e.target.value); setDraft(d); });
$('seasonal').addEventListener('input', (e) => { $('seasonalVal').textContent = `${e.target.value}%`; });
$('seasonal').addEventListener('change', (e) => { const d = draft(); d.seasonal = Number(e.target.value); setDraft(d); });
$('starts').addEventListener('click', (e) => {
  const d = draft();
  if (e.target.id === 'addStart') {
    const used = new Set(d.starts);
    let t = '06:00';
    for (let h = 6; used.has(t); h = (h + 1) % 24) t = `${String(h).padStart(2, '0')}:00`;
    d.starts = [...d.starts, t];
    setDraft(d);
  }
  const rm = e.target.closest('[data-rmstart]');
  if (rm) { d.starts.splice(Number(rm.dataset.rmstart), 1); document.activeElement.blur(); setDraft(d); }
});
// Clicking anywhere on a start time opens the browser's time picker (not just the clock icon).
$('starts').addEventListener('click', (e) => {
  const input = e.target.closest('input[type=time]');
  if (input && typeof input.showPicker === 'function') {
    try { input.showPicker(); } catch {}
  }
});
// Record the new time while the user is still editing (hour, then minutes, then AM/PM).
// The time fields themselves are left alone - redrawing them would throw the user out of the
// field (Chrome briefly reports no focus between the hour and minute parts).
$('starts').addEventListener('change', (e) => {
  if (!e.target.dataset.start) return;
  const d = draft();
  if (e.target.value) d.starts[Number(e.target.dataset.start)] = e.target.value;
  setDraft(d, { keepStarts: true });
});
$('runtimes').addEventListener('change', (e) => {
  if (!e.target.dataset.rt) return;
  const d = draft();
  d.runTimes = { ...d.runTimes, [e.target.dataset.rt]: Math.max(0, Math.min(360, Math.round(Number(e.target.value) || 0))) };
  e.target.blur();
  setDraft(d);
});
$('btnRevert').addEventListener('click', () => { delete drafts[current]; $('writeLog').hidden = true; renderProgramSeg(); renderEditor(); });
$('btnSave').addEventListener('click', async () => {
  const d = drafts[current];
  if (!d) return;
  const body = { frequency: d.frequency, days: d.days, daysOff: d.daysOff, seasonal: d.seasonal, starts: [...new Set(d.starts)], runTimes: d.runTimes };
  if (d.frequency === 'cyclic') Object.assign(body, { cycleDays: d.cycleDays, daysRemaining: d.daysRemaining });
  const log = $('writeLog');
  log.hidden = false;
  log.className = 'writelog';
  log.textContent = 'Writing to the controller and reading every page back to verify… this takes a few seconds per change.';
  $('progEditor').classList.add('busy');
  try {
    const r = await api('PUT', `api/programs/${current}`, body);
    delete drafts[current];
    S.schedule = r.schedule;
    log.textContent = `Saved and verified.\n${r.log.join('\n')}`;
    toast(`Program ${current} saved`);
    render();
  } catch (e) {
    log.className = 'writelog err';
    log.textContent = e.message;
  } finally {
    $('progEditor').classList.remove('busy');
  }
});
$('btnRunProg').addEventListener('click', (e) => act(e.target, () => api('POST', `api/programs/${current}/run`), `Program ${current} started`));
$('btnClear').addEventListener('click', async (e) => {
  if (!confirm(`Clear program ${current}? This removes its days, start times and run times on the controller.`)) return;
  await act(e.target, () => api('POST', `api/programs/${current}/clear`), `Program ${current} cleared`);
  delete drafts[current];
});

// ------------------------------------------------------------------ overview actions
$('btnStop').addEventListener('click', (e) => act(e.target, () => api('POST', 'api/stop'), 'Stopped'));
$('btnAdvance').addEventListener('click', (e) => act(e.target, () => api('POST', 'api/advance'), 'Advanced'));
// Rain delay: +/- change the number on the page immediately; one request with the final value
// is sent once the user stops clicking for a moment.
let delayPending = null; // value chosen on the page but not yet confirmed by the controller
let delayTimer = null;
let delaySending = false;
function renderRainDelay() {
  const actual = S.status.rainDelay;
  if (delayPending !== null && !delayTimer && !delaySending && actual === delayPending) delayPending = null; // confirmed
  const shown = delayPending ?? actual;
  $('rainDelay').textContent = shown;
  const foot = $('rainDelayFoot');
  if (delayPending !== null) {
    foot.textContent = delaySending ? 'Sending to controller…' : `Will set to ${shown} day${shown === 1 ? '' : 's'}…`;
  } else {
    foot.textContent = actual ? `Watering resumes in ${actual} day${actual === 1 ? '' : 's'}` : 'Pauses all programs';
  }
}
async function sendRainDelay() {
  delayTimer = null;
  const days = delayPending;
  if (days === null) return;
  if (days === S.status.rainDelay) { delayPending = null; renderRainDelay(); return; }
  delaySending = true;
  renderRainDelay();
  try {
    await api('POST', 'api/rain-delay', { days });
    S.status.rainDelay = days;
    toast(days ? `Rain delay set to ${days} day${days === 1 ? '' : 's'}` : 'Rain delay cleared');
  } catch (e) {
    toast(e.message, true);
  } finally {
    delaySending = false;
    if (delayPending === days) delayPending = null; // otherwise the user changed it again meanwhile
    renderRainDelay();
    if (delayPending !== null && !delayTimer) delayTimer = setTimeout(sendRainDelay, 1000);
  }
}
document.querySelectorAll('[data-delay]').forEach((b) => b.addEventListener('click', () => {
  const current = delayPending ?? S.status.rainDelay;
  const days = Math.max(0, Math.min(14, current + Number(b.dataset.delay)));
  if (days === current) return;
  delayPending = days;
  clearTimeout(delayTimer);
  delayTimer = delaySending ? null : setTimeout(sendRainDelay, 1000);
  renderRainDelay();
}));

$('programSummary').addEventListener('click', (e) => {
  const ed = e.target.closest('[data-edit]');
  if (ed) { current = ed.dataset.edit; document.querySelector('.tab[data-tab="programs"]').click(); renderProgramSeg(); renderEditor(); }
  const run = e.target.closest('[data-run]');
  if (run) act(run, () => api('POST', `api/programs/${run.dataset.run}/run`), `Program ${run.dataset.run} started`);
});
$('quickZones').addEventListener('click', (e) => {
  const b = e.target.closest('[data-runzone]');
  if (b) {
    const z = b.dataset.runzone;
    const minutes = Number($('quickZones').querySelector(`input[data-z="${z}"]`).value);
    act(b, () => api('POST', `api/zones/${z}/run`, { minutes }), `${zoneName(z)} running for ${minutes} min`);
  }
  if (e.target.closest('[data-stop]')) act(e.target, () => api('POST', 'api/stop'), 'Stopped');
});

// ------------------------------------------------------------------ zones tab
function renderZoneSettings() {
  zonesRendered = true;
  $('zoneSettings').innerHTML = '<div class="h">#</div><div class="h">Name</div><div class="h">Default run</div>'
    + S.zones.map((z) => `<div>${z.zone}</div><input class="text" maxlength="40" data-name="${z.zone}" value="${esc(z.name === `Zone ${z.zone}` ? '' : z.name)}" placeholder="Zone ${z.zone}">
      <div><input type="number" class="num" min="1" max="255" data-def="${z.zone}" value="${z.defaultMinutes}"> min</div>`).join('');
}
$('btnSaveZones').addEventListener('click', (e) => {
  const zoneNames = {}, defaultMinutes = {};
  document.querySelectorAll('[data-name]').forEach((i) => (zoneNames[i.dataset.name] = i.value));
  document.querySelectorAll('[data-def]').forEach((i) => (defaultMinutes[i.dataset.def] = Number(i.value)));
  document.activeElement.blur();
  act(e.target, () => api('PUT', 'api/settings', { zoneNames, defaultMinutes }), 'Zones saved');
});

// ------------------------------------------------------------------ controller tab
function renderController() {
  const g = S.schedule ? S.schedule.global : {};
  $('bypass').checked = !!g.rainSensorBypass;
  if (document.activeElement !== $('stationDelay')) $('stationDelay').value = g.stationDelaySeconds ?? 0;
  const st = S.status;
  $('clockInfo').textContent = `Controller: ${st.controllerTime.replace('T', ' ')} · drift ${st.clockDriftSeconds}s · time zone ${st.timezone || '?'}`;
  $('connInfo').textContent = `${S.setup.host} · set in ${S.setup.source === 'web' ? 'this web UI' : 'the app configuration'}`;
  const i = S.info || {};
  const w = i.wifi || {};
  const rows = [
    ['Model', `${i.model} (${i.modelId}) · protocol ${i.protocol}`],
    ['Firmware', i.firmware], ['Serial', i.serial], ['Zones', (i.zones || []).join(', ')],
    ['WiFi module', w.stickVersion || w.sick_version || '—'], ['Signal', w.rssi != null ? `${w.rssi} dBm` : '—'],
    ['MAC', w.macAddress || w.mac_address || '—'], ['Transport', (() => { const t = S.connection.stats || {}; return `${(S.connection.scheme || '').toUpperCase()} · ${t.requests || 0} requests over ${t.connections || 0} connections · avg ${t.avgMs || 0} ms · ${t.retries || 0} retries`; })()],
    ['Last error', S.connection.lastError || '—'], ['Schedule read', S.schedule && S.schedule.readAt ? new Date(S.schedule.readAt).toLocaleString() : '—'],
  ];
  $('deviceInfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v ?? '—')}</dd>`).join('');
}
$('bypass').addEventListener('change', (e) => act(null, () => api('PUT', 'api/global', { rainSensorBypass: e.target.checked }), e.target.checked ? 'Rain sensor bypassed' : 'Rain sensor active').catch(() => { e.target.checked = !e.target.checked; }));
$('btnStationDelay').addEventListener('click', (e) => act(e.target, () => api('PUT', 'api/global', { stationDelaySeconds: Number($('stationDelay').value) }), 'Station delay saved'));
$('btnSync').addEventListener('click', (e) => act(e.target, () => api('POST', 'api/clock/sync'), 'Clock synced'));
$('btnRefresh').addEventListener('click', (e) => act(e.target, () => api('POST', 'api/refresh'), 'Refreshed'));
$('btnScan').addEventListener('click', async (e) => {
  $('diag').textContent = 'Scanning…';
  try {
    const d = await act(e.target, () => api('GET', 'api/diagnostics?scan=1'));
    const sup = Object.entries(d.commandSupport).map(([c, v]) => `0x${c}: ${v === true ? 'supported' : v === false ? 'no' : v}`).join('\n');
    const pages = d.schedulePages ? Object.entries(d.schedulePages).map(([p, v]) => `${p}: ${v}`).join('\n') : '';
    $('diag').textContent = `Command support\n${sup}\n\nSchedule pages\n${pages}`;
  } catch (err) {
    $('diag').textContent = err.message;
  }
});

// ------------------------------------------------------------------ setup
function setupMsg(text, kind) {
  const m = $('setupMsg');
  m.hidden = !text;
  m.className = 'writelog' + (kind ? ` ${kind}` : '');
  m.textContent = text || '';
}
$('btnDiscover').addEventListener('click', async (e) => {
  const list = $('found');
  list.innerHTML = '<div class="muted">Listening for Rain Bird modules…</div>';
  try {
    const r = await act(e.target, () => api('POST', 'api/setup/discover'));
    list.innerHTML = r.found.length
      ? r.found.map((d) => `<button class="btn" data-ip="${esc(d.ip)}"><span>${esc(d.ip)}</span><span class="muted">${esc(d.mac || d.uuid || (d.certificate ? 'Rain Bird WiFi module' : 'Rain Bird module'))}</span></button>`).join('')
      : `<div class="muted">Nothing answered${r.scanned && r.scanned.length ? ` on ${esc(r.scanned.join(', '))}` : ''}. If the controller is on another network range, enter its IP address from your router's client list instead.</div>`;
  } catch { list.innerHTML = ''; }
});
$('found').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ip]');
  if (!b) return;
  $('setupHost').value = b.dataset.ip;
  $('found').querySelectorAll('button').forEach((x) => x.classList.toggle('picked', x === b));
  $('setupPw').focus();
});
async function setupCall(btn, path) {
  setupMsg(path.endsWith('test') ? 'Connecting…' : 'Connecting and saving…');
  btn.disabled = true;
  try {
    const r = await api('POST', path, { host: $('setupHost').value.trim(), password: $('setupPw').value });
    setupMsg(`Found ${r.model} (${r.modelId}) with ${r.zones.length} zones over ${String(r.scheme).toUpperCase()}${r.family === 'tm2' || r.family === 'me' ? '' : ' - note: this app is built for the ESP-TM2 / ESP-Me family'}.`, 'ok');
    return r;
  } catch (err) {
    setupMsg(err.message, 'err');
    return null;
  } finally {
    btn.disabled = false;
  }
}
$('btnTest').addEventListener('click', (e) => setupCall(e.target, 'api/setup/test'));
$('btnConnect').addEventListener('click', async (e) => {
  const r = await setupCall(e.target, 'api/setup');
  if (r) { setupOpen = false; $('setupPw').value = ''; toast(`Connected to ${r.model}`); setTimeout(render, 300); }
});
$('btnChangeCtl').addEventListener('click', () => {
  setupOpen = true;
  $('setupHost').value = S.setup.host || '';
  setupMsg('');
  render();
});
$('btnSetupCancel').addEventListener('click', () => { setupOpen = false; render(); });

// ------------------------------------------------------------------ log
function logLine(l) {
  const d = new Date(l.ts);
  return `<div class="${l.level}"><span class="t">${d.toLocaleTimeString()}</span><span>${esc(l.msg)}</span></div>`;
}
async function loadLog() {
  try {
    const lines = await api('GET', 'api/log');
    $('log').innerHTML = lines.slice().reverse().map(logLine).join('');
  } catch {}
}

// ------------------------------------------------------------------ live updates
function connect() {
  const es = new EventSource('api/events');
  es.addEventListener('state', (e) => { S = JSON.parse(e.data); render(); });
  es.addEventListener('log', (e) => {
    const l = JSON.parse(e.data);
    $('log').insertAdjacentHTML('afterbegin', logLine(l));
    if (l.level === 'error') toast(l.msg, true);
  });
  es.onerror = () => {
    $('conn').className = 'conn offline';
    $('connText').textContent = 'App unreachable';
  };
}
connect();
