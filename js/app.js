// ────────────────────────────────────────────────────────────────
// 여행 계획표 앱 로직
// ────────────────────────────────────────────────────────────────
'use strict';

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const ROOM_KEY = 'vp_room_id';

// ---------- 유틸 ----------
function pad2(n) { return String(n).padStart(2, '0'); }

function uid() {
  return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d;
}

function dateLabel(d) {
  return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
}

// key 형식: d{dayIndex}_h{hour}_m{minute}
function parseKey(key) {
  const m = /^d(\d+)_h(\d+)_m(\d+)$/.exec(key);
  if (!m) return null;
  return { dayIndex: +m[1], h: +m[2], m: +m[3] };
}

// ---------- 기본 데이터 ----------
// 여행 한 건(trip)의 데이터: 일정표 설정 + 숙소 정보 + 대안 계획들
function defaultTripData(tripName) {
  return {
    meta: {
      tripName: tripName || '여행 계획표',
      startDate: '2026-09-07',
      days: 3,
      startHour: 4,
      endHour: 26
    },
    accommodations: [],
    places: [],
    plans: [
      { id: 'plan1', label: '1안', cells: {}, merges: {}, links: {} }
    ],
    activePlanId: 'plan1'
  };
}

// db: 접속 암호(방) 하나 안에 여러 개의 여행을 담는 최상위 구조
// { activeTripId, trips: { [tripId]: <trip data> } }
function defaultDb() {
  const tid = uid();
  return { activeTripId: tid, trips: { [tid]: defaultTripData('여행 계획표') } };
}

let db = defaultDb();
let state = db.trips[db.activeTripId]; // 현재 보고 있는 여행의 데이터(참조)

// ---------- 저장/동기화 ----------
let dbMode = 'local';     // 'firebase' | 'local'
let dbRef = null;
let storageKey = null;
let lastAppliedJSON = null;   // 마지막으로 반영된(로컬 or 원격) 상태의 JSON
let roomId = null;

function isFirebaseConfigured() {
  const c = window.FIREBASE_CONFIG || {};
  return c.apiKey && c.apiKey !== 'YOUR_API_KEY' && c.databaseURL;
}

function setSyncStatus(text, cls) {
  const el = document.getElementById('syncStatus');
  el.textContent = text;
  el.className = 'sync-status' + (cls ? ' ' + cls : '');
}

function pushState() {
  const json = JSON.stringify(db);
  if (json === lastAppliedJSON) return;
  lastAppliedJSON = json;
  if (dbMode === 'firebase' && dbRef) {
    dbRef.set(db).catch(err => {
      console.error('Firebase 저장 실패', err);
      setSyncStatus('저장 실패 (연결 확인)', 'err');
    });
  } else {
    localStorage.setItem(storageKey, json);
  }
}
const debouncedPush = debounce(pushState, 350);

function connect(id) {
  roomId = id;

  if (isFirebaseConfigured()) {
    try {
      if (!firebase.apps || !firebase.apps.length) {
        firebase.initializeApp(window.FIREBASE_CONFIG);
      }
      dbMode = 'firebase';
      dbRef = firebase.database().ref('trips/' + roomId);
      setSyncStatus('연결 중…', '');

      dbRef.on('value', snap => {
        const remote = snap.val();
        const remoteJSON = remote ? JSON.stringify(remote) : null;
        if (remoteJSON === lastAppliedJSON) {
          setSyncStatus('실시간 동기화 중', 'ok');
          return; // 내가 방금 보낸 내용의 echo
        }
        if (remote) {
          db = normalizeDb(remote);
          lastAppliedJSON = JSON.stringify(db);
        } else {
          // DB에 아직 데이터가 없으면 현재 로컬 기본값을 최초 업로드
          lastAppliedJSON = JSON.stringify(db);
          dbRef.set(db);
        }
        state = db.trips[db.activeTripId];
        renderAll();
        setSyncStatus('실시간 동기화 중', 'ok');
      }, err => {
        console.error('Firebase 읽기 실패', err);
        setSyncStatus('연결 실패 → 로컬 저장 모드', 'err');
        dbMode = 'local';
        storageKey = 'vp_data_' + roomId;
        loadLocal();
      });
    } catch (err) {
      console.error('Firebase 초기화 실패', err);
      dbMode = 'local';
      storageKey = 'vp_data_' + roomId;
      loadLocal();
      setSyncStatus('로컬 저장 모드', '');
    }
  } else {
    dbMode = 'local';
    storageKey = 'vp_data_' + roomId;
    loadLocal();
    setSyncStatus('로컬 저장 모드 (이 기기에만 저장)', '');
  }
}

function loadLocal() {
  const raw = localStorage.getItem(storageKey);
  if (raw) {
    try { db = normalizeDb(JSON.parse(raw)); } catch (e) { db = defaultDb(); }
  } else {
    db = defaultDb();
  }
  state = db.trips[db.activeTripId];
  lastAppliedJSON = JSON.stringify(db);
  renderAll();
}

// 여행 데이터 하나에 누락된 필드가 있으면 기본값으로 보강
function normalizeTrip(t) {
  const def = defaultTripData();
  t.meta = Object.assign({}, def.meta, t.meta || {});
  t.accommodations = Array.isArray(t.accommodations) ? t.accommodations : [];
  t.places = Array.isArray(t.places) ? t.places : [];
  t.plans = Array.isArray(t.plans) && t.plans.length ? t.plans : def.plans;
  t.plans.forEach(p => {
    p.cells = p.cells || {};
    p.merges = p.merges || {};
    p.links = p.links || {};
  });
  t.activePlanId = t.plans.find(p => p.id === t.activePlanId) ? t.activePlanId : t.plans[0].id;
  return t;
}

// 저장된 db 전체를 불러올 때 누락/구버전 데이터를 보강
function normalizeDb(raw) {
  if (!raw) return defaultDb();
  // 예전 버전(여행 1개짜리) 데이터가 남아있다면 새 구조로 감싸준다
  if (raw.meta && !raw.trips) {
    const tid = uid();
    raw = { activeTripId: tid, trips: { [tid]: raw } };
  }
  if (!raw.trips || typeof raw.trips !== 'object' || !Object.keys(raw.trips).length) {
    return defaultDb();
  }
  Object.keys(raw.trips).forEach(id => { raw.trips[id] = normalizeTrip(raw.trips[id]); });
  if (!raw.trips[raw.activeTripId]) {
    raw.activeTripId = Object.keys(raw.trips)[0];
  }
  return raw;
}

// ---------- 잠금 화면 ----------
const lockScreen = document.getElementById('lockScreen');
const appEl = document.getElementById('app');
const passcodeInput = document.getElementById('passcodeInput');
const unlockBtn = document.getElementById('unlockBtn');
const lockMsg = document.getElementById('lockMsg');

async function unlock(passcode) {
  if (!passcode) {
    lockMsg.textContent = '암호를 입력하세요.';
    return;
  }
  const hash = await sha256Hex('vacation-planner::' + passcode);
  const id = hash.slice(0, 24);
  localStorage.setItem(ROOM_KEY, id);
  lockScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  connect(id);
}

unlockBtn.addEventListener('click', () => unlock(passcodeInput.value.trim()));
passcodeInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') unlock(passcodeInput.value.trim());
});

document.getElementById('lockBtn').addEventListener('click', () => {
  if (dbRef) dbRef.off();
  localStorage.removeItem(ROOM_KEY);
  location.reload();
});

// ---------- 메인 탭 전환 ----------
document.querySelectorAll('.main-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// ---------- 렌더링 ----------
function renderAll() {
  document.getElementById('tripNameDisplay').textContent = state.meta.tripName || '여행 계획표';
  exitMergeMode();
  renderPlanTabs();
  renderScheduleHead();
  renderScheduleBody();
  renderStayList();
  renderPlaceList();
  renderTripsList();
}

function currentPlan() {
  return state.plans.find(p => p.id === state.activePlanId) || state.plans[0];
}

function renderPlanTabs() {
  const wrap = document.getElementById('planTabs');
  wrap.innerHTML = '';
  state.plans.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'plan-tab' + (p.id === state.activePlanId ? ' active' : '');
    btn.innerHTML = `<span class="plan-label">${escapeHtml(p.label)}</span>`;
    if (state.plans.length > 1) {
      const del = document.createElement('span');
      del.className = 'plan-del';
      del.textContent = '✕';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`"${p.label}" 계획을 삭제할까요?`)) {
          state.plans = state.plans.filter(x => x.id !== p.id);
          if (state.activePlanId === p.id) state.activePlanId = state.plans[0].id;
          debouncedPush();
          renderAll();
        }
      });
      btn.appendChild(del);
    }
    btn.addEventListener('click', () => {
      state.activePlanId = p.id;
      exitMergeMode();
      renderPlanTabs();
      renderScheduleBody();
    });
    wrap.appendChild(btn);
  });
}

document.getElementById('addPlanBtn').addEventListener('click', () => {
  const nextNum = state.plans.length + 1;
  const label = prompt('새 대안 계획 이름', `${nextNum}안`);
  if (label === null) return;
  const p = { id: uid(), label: label || `${nextNum}안`, cells: {}, merges: {}, links: {} };
  state.plans.push(p);
  state.activePlanId = p.id;
  debouncedPush();
  renderAll();
});

function getDateList() {
  const list = [];
  for (let i = 0; i < state.meta.days; i++) {
    const d = addDays(state.meta.startDate, i);
    list.push({ dayIndex: i, label: dateLabel(d) });
  }
  return list;
}

function getTimeSlots() {
  const slots = [];
  for (let h = state.meta.startHour; h < state.meta.endHour; h++) {
    for (const m of [0, 30]) {
      slots.push({ h, m, isNextDay: h >= 24 });
    }
  }
  return slots;
}

function renderScheduleHead() {
  const head = document.getElementById('scheduleHead');
  head.innerHTML = '<th class="time-col-head">시간</th>';
  getDateList().forEach(d => {
    const th = document.createElement('th');
    th.textContent = d.label;
    head.appendChild(th);
  });
}

// ---------- 셀 합치기(병합) 모드 ----------
// 흐름: 병합모드 ON → 합치고 싶은 칸들을 원하는 만큼(2칸이든 5칸이든) 탭해서
// 선택 → "합치기" 버튼을 눌러 한 번에 병합. 이미 합쳐진 칸은 탭하면 바로 해제.
let mergeMode = false;
let mergeSelection = new Set(); // 선택된 칸들의 key (같은 날짜 세로줄 안에서만)

const mergeModeBtn = document.getElementById('mergeModeBtn');
const mergeHint = document.getElementById('mergeHint');
const mergeConfirmBtn = document.getElementById('mergeConfirmBtn');

function resetMergeSelection() {
  mergeSelection.clear();
  updateMergeConfirmBtn();
}

// 병합 모드를 완전히 끄고 관련 UI를 초기 상태로 되돌림
// (여행/계획 전환처럼 화면 전체를 다시 그릴 때 사용)
function exitMergeMode() {
  mergeMode = false;
  mergeSelection.clear();
  mergeModeBtn.classList.remove('active');
  mergeHint.classList.add('hidden');
  mergeConfirmBtn.classList.add('hidden');
}

function updateMergeConfirmBtn() {
  const n = mergeSelection.size;
  if (mergeMode && n >= 2) {
    mergeConfirmBtn.textContent = `✅ 합치기 (${n}칸)`;
    mergeConfirmBtn.classList.remove('hidden');
  } else {
    mergeConfirmBtn.classList.add('hidden');
  }
}

mergeModeBtn.addEventListener('click', () => {
  mergeMode = !mergeMode;
  resetMergeSelection();
  mergeModeBtn.classList.toggle('active', mergeMode);
  mergeHint.classList.toggle('hidden', !mergeMode);
  renderScheduleBody();
});

mergeConfirmBtn.addEventListener('click', () => {
  if (mergeSelection.size < 2) return;
  const plan = currentPlan();
  plan.merges = plan.merges || {};
  const slots = getTimeSlots();
  const idxOf = (h, m) => slots.findIndex(s => s.h === h && s.m === m);

  const parsedList = Array.from(mergeSelection).map(k => Object.assign({ key: k }, parseKey(k)));
  const dayIndex = parsedList[0].dayIndex;
  const indices = parsedList.map(p => idxOf(p.h, p.m));
  const startIdx = Math.min(...indices);
  const endIdx = Math.max(...indices);
  const span = endIdx - startIdx + 1;
  const startSlot = slots[startIdx];
  const realStartKey = `d${dayIndex}_h${startSlot.h}_m${startSlot.m}`;

  // 범위 안에 겹치는 기존 병합이 있다면 정리
  Object.keys(plan.merges).forEach(k => {
    const kp = parseKey(k);
    if (kp && kp.dayIndex === dayIndex) {
      const kIdx = idxOf(kp.h, kp.m);
      if (kIdx >= startIdx && kIdx <= endIdx) delete plan.merges[k];
    }
  });
  plan.merges[realStartKey] = span;

  // 맨 앞 칸의 글자만 남기고 나머지 칸의 글자는 비움
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const s = slots[i];
    const k = `d${dayIndex}_h${s.h}_m${s.m}`;
    delete plan.cells[k];
  }

  resetMergeSelection();
  debouncedPush();
  renderScheduleBody();
});

function renderScheduleBody() {
  const body = document.getElementById('scheduleBody');
  body.innerHTML = '';
  const dates = getDateList();
  const slots = getTimeSlots();
  const plan = currentPlan();
  plan.merges = plan.merges || {};

  const skip = {}; // dayIndex -> 남은 스킵 행 수(병합으로 이미 칸이 그려진 만큼)
  dates.forEach(d => { skip[d.dayIndex] = 0; });

  slots.forEach((slot, rowIdx) => {
    const tr = document.createElement('tr');
    const displayHour = slot.h % 24;
    const timeLabel = `${pad2(displayHour)}:${pad2(slot.m)}`;

    const timeTd = document.createElement('td');
    timeTd.className = 'time-cell' + (slot.isNextDay ? ' nextday' : '') + (slot.m === 0 ? ' hour-mark' : '');
    timeTd.innerHTML = slot.isNextDay
      ? `${timeLabel}<span class="nd-mark">익일</span>`
      : timeLabel;
    tr.appendChild(timeTd);

    dates.forEach(d => {
      if (skip[d.dayIndex] > 0) {
        skip[d.dayIndex]--;
        return; // 이 칸은 위쪽 병합 셀에 이미 포함되어 있으므로 새로 그리지 않음
      }
      const key = `d${d.dayIndex}_h${slot.h}_m${slot.m}`;
      const remaining = slots.length - rowIdx;
      const span = Math.min(plan.merges[key] || 1, remaining);

      const td = document.createElement('td');
      td.className = 'day-cell' + (slot.isNextDay ? ' nextday-row' : '') + (slot.m === 0 ? ' hour-mark' : '');
      if (span > 1) {
        td.rowSpan = span;
        td.classList.add('merged-cell');
        skip[d.dayIndex] = span - 1;
      }

      const div = document.createElement('div');
      div.className = 'cell-inner' + (mergeSelection.has(key) ? ' selected' : '');
      div.contentEditable = mergeMode ? 'false' : 'true';
      div.dataset.key = key;
      div.textContent = plan.cells[key] || '';
      td.appendChild(div);

      // 병합 모드가 아닐 때만 숙소/부가시설/주변정보 연결 배지 표시
      if (!mergeMode) {
        const isLinked = !!(plan.links && plan.links[key]);
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'link-badge' + (isLinked ? ' linked' : '');
        badge.title = isLinked ? '연결된 정보 보기' : '숙소/부가시설/주변정보 연결하기';
        badge.textContent = isLinked ? '🔗' : '＋';
        badge.dataset.key = key;
        td.appendChild(badge);
      }

      tr.appendChild(td);
    });

    body.appendChild(tr);
  });
}

// 셀 입력 → 상태 저장 (이벤트 위임, 일반 모드에서만 동작)
document.getElementById('scheduleBody').addEventListener('input', e => {
  if (mergeMode) return;
  const el = e.target.closest('.cell-inner');
  if (!el) return;
  const plan = currentPlan();
  const val = el.textContent;
  if (val) plan.cells[el.dataset.key] = val;
  else delete plan.cells[el.dataset.key];
  debouncedPush();
});

// 셀 클릭 → ① 연결 배지 클릭 시 정보 확인/연결 모달, ② 병합 모드에서는 선택/병합/해제
document.getElementById('scheduleBody').addEventListener('click', e => {
  const badge = e.target.closest('.link-badge');
  if (badge) {
    e.stopPropagation();
    openLinkModal(badge.dataset.key);
    return;
  }
  if (!mergeMode) return;
  const el = e.target.closest('.cell-inner');
  if (!el) return;
  handleMergeClick(el);
});

function handleMergeClick(el) {
  const key = el.dataset.key;
  const plan = currentPlan();
  plan.merges = plan.merges || {};

  // 이미 합쳐진 칸을 탭하면 그 자리에서 바로 낱개로 해제
  if (plan.merges[key] && plan.merges[key] > 1) {
    delete plan.merges[key];
    resetMergeSelection();
    debouncedPush();
    renderScheduleBody();
    return;
  }

  const parsed = parseKey(key);

  // 이미 선택해둔 칸이 다른 날짜(세로줄)라면, 새 날짜로 선택을 다시 시작
  if (mergeSelection.size) {
    const firstParsed = parseKey(mergeSelection.values().next().value);
    if (firstParsed.dayIndex !== parsed.dayIndex) {
      mergeSelection.clear();
    }
  }

  if (mergeSelection.has(key)) {
    mergeSelection.delete(key); // 다시 탭하면 선택 취소
  } else {
    mergeSelection.add(key);
  }

  updateMergeConfirmBtn();
  renderScheduleBody();
}

// ---------- 숙소 정보 ----------
const stayList = document.getElementById('stayList');
const stayCardTpl = document.getElementById('stayCardTpl');
const facilityRowTpl = document.getElementById('facilityRowTpl');

function renderStayList() {
  stayList.innerHTML = '';
  state.accommodations.forEach(stay => {
    const node = stayCardTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = stay.id;
    node.querySelector('.stay-name').value = stay.name || '';
    node.querySelector('.stay-location').value = stay.location || '';
    node.querySelector('.stay-checkin').value = stay.checkIn || '';
    node.querySelector('.stay-checkout').value = stay.checkOut || '';

    const facList = node.querySelector('.facility-list');
    (stay.facilities || []).forEach(f => {
      facList.appendChild(buildFacilityRow(f));
    });

    stayList.appendChild(node);
  });
}

function buildFacilityRow(f) {
  const row = facilityRowTpl.content.firstElementChild.cloneNode(true);
  row.dataset.id = f.id;
  row.querySelector('.facility-name').value = f.name || '';
  row.querySelector('.facility-time').value = f.time || '';
  row.querySelector('.facility-details').value = f.details || '';
  return row;
}

document.getElementById('addStayBtn').addEventListener('click', () => {
  state.accommodations.push({
    id: uid(), name: '', location: '', checkIn: '', checkOut: '', facilities: []
  });
  debouncedPush();
  renderStayList();
});

// 숙소/시설 입력 및 버튼 이벤트 위임
stayList.addEventListener('input', e => {
  const card = e.target.closest('.stay-card');
  if (!card) return;
  const stay = state.accommodations.find(s => s.id === card.dataset.id);
  if (!stay) return;

  if (e.target.classList.contains('stay-name')) stay.name = e.target.value;
  else if (e.target.classList.contains('stay-location')) stay.location = e.target.value;
  else if (e.target.classList.contains('stay-checkin')) stay.checkIn = e.target.value;
  else if (e.target.classList.contains('stay-checkout')) stay.checkOut = e.target.value;
  else {
    const row = e.target.closest('.facility-row');
    if (row) {
      const fac = stay.facilities.find(f => f.id === row.dataset.id);
      if (fac) {
        if (e.target.classList.contains('facility-name')) fac.name = e.target.value;
        else if (e.target.classList.contains('facility-time')) fac.time = e.target.value;
        else if (e.target.classList.contains('facility-details')) fac.details = e.target.value;
      }
    }
  }
  debouncedPush();
});

stayList.addEventListener('click', e => {
  const card = e.target.closest('.stay-card');
  if (!card) return;
  const stay = state.accommodations.find(s => s.id === card.dataset.id);
  if (!stay) return;

  if (e.target.classList.contains('stay-remove')) {
    if (confirm('이 숙소 정보를 삭제할까요?')) {
      state.accommodations = state.accommodations.filter(s => s.id !== stay.id);
      debouncedPush();
      renderStayList();
    }
    return;
  }
  if (e.target.classList.contains('add-facility-btn')) {
    const fac = { id: uid(), name: '', time: '', details: '' };
    stay.facilities = stay.facilities || [];
    stay.facilities.push(fac);
    card.querySelector('.facility-list').appendChild(buildFacilityRow(fac));
    debouncedPush();
    return;
  }
  if (e.target.classList.contains('facility-remove')) {
    const row = e.target.closest('.facility-row');
    stay.facilities = stay.facilities.filter(f => f.id !== row.dataset.id);
    row.remove();
    debouncedPush();
    return;
  }
  if (e.target.classList.contains('facility-up') || e.target.classList.contains('facility-down')) {
    const row = e.target.closest('.facility-row');
    const idx = stay.facilities.findIndex(f => f.id === row.dataset.id);
    const dir = e.target.classList.contains('facility-up') ? -1 : 1;
    const newIdx = idx + dir;
    if (idx === -1 || newIdx < 0 || newIdx >= stay.facilities.length) return;
    const tmp = stay.facilities[idx];
    stay.facilities[idx] = stay.facilities[newIdx];
    stay.facilities[newIdx] = tmp;
    debouncedPush();
    // 이 카드의 시설 목록만 다시 그려서 순서 변경을 반영
    const facList = card.querySelector('.facility-list');
    facList.innerHTML = '';
    stay.facilities.forEach(f => facList.appendChild(buildFacilityRow(f)));
  }
});

// ---------- 주변 정보(식당/가볼만한 곳) ----------
const placeList = document.getElementById('placeList');
const placeCardTpl = document.getElementById('placeCardTpl');

function renderPlaceList() {
  placeList.innerHTML = '';
  (state.places || []).forEach(place => {
    const node = placeCardTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = place.id;
    node.querySelector('.place-name').value = place.name || '';
    node.querySelector('.place-category').value = place.category || '식당';
    node.querySelector('.place-location').value = place.location || '';
    node.querySelector('.place-hours').value = place.hours || '';
    node.querySelector('.place-details').value = place.details || '';
    placeList.appendChild(node);
  });
}

document.getElementById('addPlaceBtn').addEventListener('click', () => {
  state.places = state.places || [];
  state.places.push({ id: uid(), name: '', category: '식당', location: '', hours: '', details: '' });
  debouncedPush();
  renderPlaceList();
});

function handlePlaceFieldChange(e) {
  const card = e.target.closest('.place-card');
  if (!card) return;
  const place = (state.places || []).find(p => p.id === card.dataset.id);
  if (!place) return;
  if (e.target.classList.contains('place-name')) place.name = e.target.value;
  else if (e.target.classList.contains('place-category')) place.category = e.target.value;
  else if (e.target.classList.contains('place-location')) place.location = e.target.value;
  else if (e.target.classList.contains('place-hours')) place.hours = e.target.value;
  else if (e.target.classList.contains('place-details')) place.details = e.target.value;
  debouncedPush();
}
placeList.addEventListener('input', handlePlaceFieldChange);
placeList.addEventListener('change', handlePlaceFieldChange);

placeList.addEventListener('click', e => {
  const card = e.target.closest('.place-card');
  if (!card) return;
  if (e.target.classList.contains('place-remove')) {
    if (confirm('이 장소 정보를 삭제할까요?')) {
      state.places = state.places.filter(p => p.id !== card.dataset.id);
      debouncedPush();
      renderPlaceList();
    }
  }
});

// ---------- 계획표 칸 ↔ 숙소/부가시설/주변정보 연결 ----------
const linkModal = document.getElementById('linkModal');
const linkModalTitle = document.getElementById('linkModalTitle');
const linkModalBody = document.getElementById('linkModalBody');
let currentLinkKey = null;

document.getElementById('linkModalClose').addEventListener('click', () => {
  linkModal.classList.add('hidden');
  currentLinkKey = null;
});

// 연결 가능한 모든 항목(숙소/부가시설/주변정보)을 하나의 목록으로 모음
function getAllLinkables() {
  const items = [];
  (state.accommodations || []).forEach(stay => {
    items.push({
      type: 'stay',
      refId: stay.id,
      title: stay.name || '(이름 없는 숙소)',
      group: '숙소',
      rows: [
        stay.location ? ['위치', stay.location] : null,
        (stay.checkIn || stay.checkOut) ? ['체크인/아웃', `${stay.checkIn || '-'} / ${stay.checkOut || '-'}`] : null
      ].filter(Boolean)
    });
    (stay.facilities || []).forEach(f => {
      items.push({
        type: 'facility',
        refId: f.id,
        title: f.name || '(이름 없는 시설)',
        group: `${stay.name || '숙소'} · 부가시설`,
        rows: [
          f.time ? ['이용시간', f.time] : null,
          f.details ? ['세부내용', f.details] : null
        ].filter(Boolean)
      });
    });
  });
  (state.places || []).forEach(place => {
    items.push({
      type: 'place',
      refId: place.id,
      title: place.name || '(이름 없는 장소)',
      group: `📍 주변 정보 · ${place.category || '기타'}`,
      rows: [
        place.location ? ['위치', place.location] : null,
        place.hours ? ['영업시간', place.hours] : null,
        place.details ? ['세부내용', place.details] : null
      ].filter(Boolean)
    });
  });
  return items;
}

function findLinkable(type, refId) {
  return getAllLinkables().find(it => it.type === type && it.refId === refId) || null;
}

function openLinkModal(cellKey) {
  currentLinkKey = cellKey;
  const plan = currentPlan();
  const link = plan.links && plan.links[cellKey];
  if (link) {
    renderLinkDetail(link);
  } else {
    renderLinkPicker();
  }
  linkModal.classList.remove('hidden');
}

function renderLinkPicker() {
  linkModalTitle.textContent = '연결할 항목 선택';
  const items = getAllLinkables();
  if (!items.length) {
    linkModalBody.innerHTML = '<p class="hint">아직 등록된 숙소/부가시설/주변 정보가 없어요. 먼저 🏨 숙소 정보나 📍 주변 정보 탭에서 추가해주세요.</p>';
    return;
  }
  const groups = {};
  items.forEach(it => { (groups[it.group] = groups[it.group] || []).push(it); });

  linkModalBody.innerHTML = '';
  Object.entries(groups).forEach(([groupName, list]) => {
    const h = document.createElement('div');
    h.className = 'link-pick-group-title';
    h.textContent = groupName;
    linkModalBody.appendChild(h);
    list.forEach(it => {
      const row = document.createElement('div');
      row.className = 'link-pick-row';
      row.textContent = it.title;
      row.addEventListener('click', () => chooseLink(it.type, it.refId));
      linkModalBody.appendChild(row);
    });
  });
}

function chooseLink(type, refId) {
  const plan = currentPlan();
  plan.links = plan.links || {};
  plan.links[currentLinkKey] = { type, refId };
  const item = findLinkable(type, refId);
  // 칸이 비어 있었다면 연결한 항목의 이름을 자동으로 채워줌
  if (item && !plan.cells[currentLinkKey]) {
    plan.cells[currentLinkKey] = item.title;
  }
  debouncedPush();
  linkModal.classList.add('hidden');
  currentLinkKey = null;
  renderScheduleBody();
}

function renderLinkDetail(link) {
  const item = findLinkable(link.type, link.refId);
  linkModalTitle.textContent = '연결된 정보';
  if (!item) {
    linkModalBody.innerHTML = '<p class="hint">연결된 항목을 찾을 수 없어요. (삭제되었을 수 있어요)</p>';
    return;
  }
  const rowsHtml = item.rows.map(([k, v]) =>
    `<div class="link-detail-row"><b>${escapeHtml(k)}:</b> ${escapeHtml(v)}</div>`
  ).join('') || '<div class="link-detail-row">등록된 세부 정보가 없어요.</div>';

  linkModalBody.innerHTML = `
    <div class="link-detail-card">
      <div class="link-detail-sub">${escapeHtml(item.group)}</div>
      <div class="link-detail-title">${escapeHtml(item.title)}</div>
      ${rowsHtml}
    </div>
    <div class="link-detail-actions">
      <button type="button" class="btn-change" id="linkChangeBtn">🔁 변경</button>
      <button type="button" class="btn-unlink" id="linkUnlinkBtn">❌ 연결 해제</button>
    </div>
  `;
  document.getElementById('linkChangeBtn').addEventListener('click', renderLinkPicker);
  document.getElementById('linkUnlinkBtn').addEventListener('click', () => {
    const plan = currentPlan();
    if (plan.links) delete plan.links[currentLinkKey];
    debouncedPush();
    linkModal.classList.add('hidden');
    currentLinkKey = null;
    renderScheduleBody();
  });
}

// ---------- 설정 모달 (현재 여행의 이름/날짜/시간범위) ----------
const settingsModal = document.getElementById('settingsModal');
document.getElementById('settingsBtn').addEventListener('click', () => {
  document.getElementById('cfgTripName').value = state.meta.tripName;
  document.getElementById('cfgStartDate').value = state.meta.startDate;
  document.getElementById('cfgDays').value = state.meta.days;
  document.getElementById('cfgStartHour').value = state.meta.startHour;
  document.getElementById('cfgEndHour').value = state.meta.endHour;
  settingsModal.classList.remove('hidden');
});
document.getElementById('cfgCancel').addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});
document.getElementById('cfgSave').addEventListener('click', () => {
  const tripName = document.getElementById('cfgTripName').value.trim() || '여행 계획표';
  const startDate = document.getElementById('cfgStartDate').value || state.meta.startDate;
  const days = Math.max(1, parseInt(document.getElementById('cfgDays').value, 10) || 1);
  const startHour = Math.max(0, parseInt(document.getElementById('cfgStartHour').value, 10) || 0);
  let endHour = parseInt(document.getElementById('cfgEndHour').value, 10) || 24;
  if (endHour <= startHour) endHour = startHour + 1;

  state.meta = { tripName, startDate, days, startHour, endHour };
  debouncedPush();
  renderAll();
  settingsModal.classList.add('hidden');
});

// ---------- 여행 목록(여러 여행 관리) ----------
const tripsModal = document.getElementById('tripsModal');
const tripsListArea = document.getElementById('tripsListArea');

function openTripsModal() {
  renderTripsList();
  tripsModal.classList.remove('hidden');
}
document.getElementById('tripSwitchTrigger').addEventListener('click', openTripsModal);
document.getElementById('tripsBtn').addEventListener('click', openTripsModal);
document.getElementById('tripsModalClose').addEventListener('click', () => {
  tripsModal.classList.add('hidden');
});

function renderTripsList() {
  tripsListArea.innerHTML = '';
  Object.entries(db.trips).forEach(([id, trip]) => {
    const row = document.createElement('div');
    row.className = 'trip-row' + (id === db.activeTripId ? ' active' : '');
    row.dataset.id = id;

    const name = document.createElement('span');
    name.className = 'trip-row-name';
    name.textContent = trip.meta.tripName || '(이름 없음)';
    name.addEventListener('click', () => switchTrip(id));
    row.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'trip-row-actions';

    const renameBtn = document.createElement('button');
    renameBtn.textContent = '✏️';
    renameBtn.title = '이름 변경';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = prompt('여행 이름 변경', trip.meta.tripName);
      if (newName === null) return;
      trip.meta.tripName = newName.trim() || trip.meta.tripName;
      if (id === db.activeTripId) {
        document.getElementById('tripNameDisplay').textContent = trip.meta.tripName;
      }
      debouncedPush();
      renderTripsList();
    });
    actions.appendChild(renameBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = '🗑';
    delBtn.title = '삭제';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (Object.keys(db.trips).length <= 1) {
        alert('마지막 남은 여행은 삭제할 수 없어요.');
        return;
      }
      if (!confirm(`"${trip.meta.tripName}" 여행을 삭제할까요? 되돌릴 수 없어요.`)) return;
      delete db.trips[id];
      if (db.activeTripId === id) {
        db.activeTripId = Object.keys(db.trips)[0];
        state = db.trips[db.activeTripId];
        renderAll();
      }
      debouncedPush();
      renderTripsList();
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);
    tripsListArea.appendChild(row);
  });
}

function switchTrip(id) {
  if (id === db.activeTripId) { tripsModal.classList.add('hidden'); return; }
  db.activeTripId = id;
  state = db.trips[id];
  debouncedPush();
  renderAll();
  tripsModal.classList.add('hidden');
}

document.getElementById('newTripBtn').addEventListener('click', () => {
  const name = prompt('새 여행 이름', '새 여행');
  if (name === null) return;
  const id = uid();
  db.trips[id] = defaultTripData(name.trim() || '새 여행');
  db.activeTripId = id;
  state = db.trips[id];
  debouncedPush();
  renderAll();
  renderTripsList();
  tripsModal.classList.add('hidden');
});

// ---------- 이스케이프 ----------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

// ---------- 자동 재접속 ----------
// 이 파일의 모든 선언/이벤트 바인딩이 끝난 뒤 마지막에 실행되어야
// (이전에 잠금 해제한 적이 있으면) connect() 호출 시점에 아직 초기화되지
// 않은 변수를 참조하는 문제가 생기지 않는다.
(function initialCheck() {
  const saved = localStorage.getItem(ROOM_KEY);
  if (saved) {
    lockScreen.classList.add('hidden');
    appEl.classList.remove('hidden');
    connect(saved);
  }
})();
