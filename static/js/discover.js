// ── IndexedDB constants (must be before any async init that uses them) ──────
const IDB_NAME  = 'mustlisten';
const IDB_STORE = 'sessions';

// ── State ──────────────────────────────────────────────────────────────────
let heardCache   = null;   // { user, pairs:[[a,t],...], count, fetched_at }
let loadedUser   = null;

// extra users for cross-reference / recommendation
const USER_COLORS = ['#6a9fb5','#78b56c','#b56c6c','#9b6cb5','#b59b6c','#6cb5b5','#b56ca0','#7ab5a0'];
let extraUsers = [];  // [{user, pairs:[[na,nt,oa,ot,count],...], color, count, fetched_at}]

// discover state
let discoverMode          = false;
let discoverAllCandidates = [];
let discoverCandidates    = [];
let discoverAlbums        = [];
let discoverOffset        = 0;
let discoverSearching     = false;
let discoverEs            = null;
let discoverDecadeFilter  = new Set();
let discoverPage          = 0;
let discoverLimit         = 20;
let discoverModeType      = 'albums';
let discoverUserIdx       = 0;
let activeDiscoverUserIdx = 0;

// album info cache (artist|||title → data)
const albumInfoCache = new Map();

// ── DOM refs ───────────────────────────────────────────────────────────────
const inpUser    = document.getElementById('inp-user');
const btnGo      = document.getElementById('btn-go');
const loading    = document.getElementById('loading');
const loadTxt    = document.getElementById('loading-text');
const errMsg     = document.getElementById('error-msg');
const inpSession = document.getElementById('inp-session');

// ── Sidebar panel toggle ───────────────────────────────────────────────────
function closeSidebar() {} // no-op (sidebar eliminado)

// ── About modal ───────────────────────────────────────────────────────────
function openAboutModal() {
  document.getElementById('about-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeAboutModal() {
  document.getElementById('about-overlay').classList.remove('open');
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('about-overlay').classList.contains('open'))
    closeAboutModal();
});

// ── User modal open/close ──────────────────────────────────────────────────
function openUserModal() {
  document.getElementById('user-modal-bg').classList.add('open');
  document.body.style.overflow = 'hidden';
  renderSecondaryUsers();
}
function closeUserModal() {
  document.getElementById('user-modal-bg').classList.remove('open');
  document.body.style.overflow = '';
}
document.getElementById('user-modal-bg').addEventListener('click', e => {
  if (e.target === document.getElementById('user-modal-bg')) closeUserModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('user-modal-bg').classList.contains('open')) closeUserModal();
  }
});

// ── Extra users (recommendation) ──────────────────────────────────────────
function saveExtraUsersLS() {
  localStorage.setItem('ml_extra_users', JSON.stringify(
    extraUsers.map(u => ({ user: u.user, pairs: u.pairs, color: u.color, count: u.count, fetched_at: u.fetched_at, image: u.image || '', source: u.source || 'lfm' }))
  ));
}

function loadExtraUsersLS() {
  try {
    const saved = JSON.parse(localStorage.getItem('ml_extra_users') || '[]');
    for (const u of saved) {
      if (u.user && u.pairs) extraUsers.push({ ...u, image: u.image || '' });
    }
  } catch(e) {}
}

function buildExtraUsersList() {
  const hasExtra = extraUsers.length > 0;
  const ctrlBar = document.getElementById('discover-ctrl-bar');
  if (ctrlBar) ctrlBar.style.display = hasExtra ? '' : 'none';
  if (hasExtra) {
    if (activeDiscoverUserIdx >= extraUsers.length) activeDiscoverUserIdx = 0;
    _updateDiscoverIndicator();
  } else {
    // No active users: hide discover results if shown
    const _dv = document.getElementById('discover-view');
    if (_dv) _dv.classList.remove('visible');
    if (discoverEs) { discoverEs.close(); discoverEs = null; }
    discoverMode = false;
  }
  renderSecondaryUsers();
}

function selectDiscoverUser(i) { setActiveDiscoverUser(i); }

function setActiveDiscoverUser(i) {
  activeDiscoverUserIdx = i;
  // Highlight in secondary-bar
  document.querySelectorAll('.sbar-user').forEach((el, j) =>
    el.classList.toggle('active', j === i));
  _updateDiscoverIndicator();
}

function _updateDiscoverIndicator() {
  const el = document.getElementById('disc-user-indicator');
  if (!el) return;
  if (!extraUsers.length) { el.innerHTML = ''; return; }
  el.innerHTML = extraUsers.map((uu, i) =>
    `<div class="disc-user-line${i===activeDiscoverUserIdx?' active':''}" data-idx="${i}">
      ${uu.image
        ? `<img src="${escH(uu.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;flex-shrink:0">`
        : `<span style="width:8px;height:8px;border-radius:50%;background:${uu.color};display:inline-block;flex-shrink:0"></span>`}
      <span class="disc-user-line-name">${escH(uu.user)}</span>
    </div>`
  ).join('');
}

async function triggerDiscover() {
  if (!extraUsers.length) return;
  const mode = document.getElementById('disc-mode-select')?.value || 'albums';
  const limit = Math.min(100, Math.max(1,
    parseInt(document.getElementById('disc-limit-global')?.value || '20')
  ));
  // Songs data is too large for localStorage — load from IDB on demand
  if (mode === 'songs') {
    const u = extraUsers[activeDiscoverUserIdx];
    if (u && u.songs === undefined) {
      const data = await idbLoad(u.user).catch(() => null);
      if (data) u.songs = data.songs || [];
    }
  }
  enterDiscoverMode(activeDiscoverUserIdx, limit, mode);
}

function saveExtraUserJSON(idx) {
  const u = extraUsers[idx];
  if (!u) return;
  const blob = new Blob([JSON.stringify({ version:1, user: u.user, count: u.count, fetched_at: u.fetched_at, heard: u.pairs, songs: u.songs || [] }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${u.user}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}


async function addExtraUser() {
  const inp = document.getElementById('inp-extra-user');
  const prog = document.getElementById('um-extra-progress');
  const user = inp.value.trim();
  if (!user) return;
  if (extraUsers.some(u => u.user.toLowerCase() === user.toLowerCase())) {
    inp.value = ''; return;
  }
  const btn = document.getElementById('btn-extra-lfm');
  btn.disabled = true; inp.disabled = true;
  const src = umSource();
  prog.textContent = src === 'lb' ? 'Conectando con ListenBrainz...' : 'Conectando con Last.fm...';
  try {
    const [userInfo, lfmResult] = await Promise.all([
      fetch(checkUserEndpoint(user, src)).then(r=>r.json()).catch(()=>null),
      fetchScrobblesSSE(user, msg => {
        if (msg._waiting) prog.textContent = `⏳ Límite Last.fm — esperando ${msg.waiting}s… (pág ${msg.page}/${msg.total_pages})`;
        else prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      }, src),
    ]);
    const heard     = lfmResult.heard;
    const songs     = lfmResult.heard_songs || [];
    const color     = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const image     = userInfo?.ok ? (userInfo.image || '') : '';
    const realUser  = userInfo?.ok ? userInfo.username : user;
    const fetched_at = Math.floor(Date.now()/1000);
    const last_scrobble_ts     = lfmResult.last_scrobble_ts    || 0;
    const last_scrobble_artist = lfmResult.last_scrobble_artist || '';
    const last_scrobble_track  = lfmResult.last_scrobble_track  || '';
    extraUsers.push({ user: realUser, pairs: heard, songs, color, count: heard.length, fetched_at, image, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    saveExtraUsersLS();
    await idbSave({ user: realUser, count: heard.length, fetched_at, heard, songs, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track, complete: true, total_pages: lfmResult.total_pages || 0, heard_artists: lfmResult.heard_artists || [] });
    await renderIdbExtraList();
    buildExtraUsersList();
    inp.value = '';
    prog.textContent = `✓ ${realUser} cargado — ${heard.length.toLocaleString()} álbumes, ${songs.length.toLocaleString()} canciones`;
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; inp.disabled = false;
  }
}

async function syncExtraUser(idx) {
  const u = extraUsers[idx];
  if (!u) return;
  const prog = document.getElementById('um-extra-progress');
  prog.textContent = `Sincronizando ${u.user}...`;
  try {
    const url = sinceEndpoint(u.user, u.fetched_at || 0, u.source || 'lfm');
    const r = await fetch(url);
    if (!r.ok) { const t = await r.text(); throw new Error(`Error ${r.status}: ${t.slice(0, 120)}`); }
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    // merge: add only pairs not already present
    const existing = new Set(u.pairs.map(p => p[0] + '|' + p[1]));
    const added = data.new_pairs.filter(p => !existing.has(p[0] + '|' + p[1]));
    extraUsers[idx].pairs      = [...u.pairs, ...added];
    extraUsers[idx].count      = extraUsers[idx].pairs.length;
    extraUsers[idx].fetched_at = data.fetched_at;
    // Merge new songs
    if (data.new_songs?.length) {
      const existSongs = new Set((extraUsers[idx].songs || []).map(s => s[0] + '|' + s[1]));
      const addedSongs = data.new_songs.filter(s => !existSongs.has(s[0] + '|' + s[1]));
      extraUsers[idx].songs = [...(extraUsers[idx].songs || []), ...addedSongs];
    }
    // Update last scrobble info if sync returned newer data
    if (data.last_scrobble_ts && data.last_scrobble_ts > (extraUsers[idx].last_scrobble_ts || 0)) {
      extraUsers[idx].last_scrobble_ts     = data.last_scrobble_ts;
      extraUsers[idx].last_scrobble_artist = data.last_scrobble_artist || '';
      extraUsers[idx].last_scrobble_track  = data.last_scrobble_track  || '';
    }
    saveExtraUsersLS();
    await idbSave({ user: extraUsers[idx].user, count: extraUsers[idx].count, fetched_at: extraUsers[idx].fetched_at, heard: extraUsers[idx].pairs, songs: extraUsers[idx].songs || [], last_scrobble_ts: extraUsers[idx].last_scrobble_ts || 0, last_scrobble_artist: extraUsers[idx].last_scrobble_artist || '', last_scrobble_track: extraUsers[idx].last_scrobble_track || '' });
    await renderIdbExtraList();
    buildExtraUsersList();
    prog.textContent = `✓ ${u.user}: +${added.length} nuevos (total ${extraUsers[idx].count.toLocaleString()})`;
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  }
}

// (inp-extra-user / btn-extra-lfm removed — search box now handles both primary and secondary)

// ── Friends loader ─────────────────────────────────────────────────────────
document.getElementById('btn-load-friends').addEventListener('click', loadFriends);

async function loadFriends() {
  const listEl = document.getElementById('friends-list');
  const btn    = document.getElementById('btn-load-friends');
  const user   = heardCache?.user || document.getElementById('inp-user').value.trim();
  if (!user) {
    listEl.innerHTML = '<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Carga primero el usuario principal.</div>';
    return;
  }
  btn.disabled = true;
  listEl.innerHTML = '<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Cargando amigos…</div>';
  try {
    const data = await fetch(`/api/friends?user=${encodeURIComponent(user)}`).then(r => r.json());
    if (!data.ok || !data.friends.length) {
      listEl.innerHTML = `<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">${escH(data.error || 'Este usuario no tiene amigos en Last.fm.')}</div>`;
      return;
    }
    renderFriendsList(data.friends);
  } catch(e) {
    listEl.innerHTML = `<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Error: ${escH(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderFriendsList(friends) {
  const listEl = document.getElementById('friends-list');
  const alreadyAdded = new Set(extraUsers.map(u => u.user.toLowerCase()));
  listEl.innerHTML = friends.map(f => {
    const added = alreadyAdded.has(f.username.toLowerCase());
    const avatar = f.image
      ? `<img class="fr-avatar" src="${escH(f.image)}" alt="">`
      : `<span class="fr-avatar" style="background:var(--bg3);display:inline-block"></span>`;
    return `<div class="fr-row" id="fr-row-${escH(f.username.toLowerCase().replace(/[^a-z0-9]/g,''))}">
      ${avatar}
      <span class="fr-name">${escH(f.username)}</span>
      <button class="btn-sm fr-add" ${added ? 'disabled' : ''} data-username="${escH(f.username)}">
        ${added ? '✓' : 'Añadir'}
      </button>
    </div>`;
  }).join('');
  listEl.querySelectorAll('img.fr-avatar').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });
}

async function addExtraUserByName(username, btn) {
  if (!username) return;
  if (extraUsers.some(u => u.user.toLowerCase() === username.toLowerCase())) return;
  const prog = document.getElementById('um-extra-progress');
  btn.disabled = true;
  btn.textContent = '…';
  prog.textContent = `Cargando ${username}…`;
  const src = umSource();
  try {
    const [userInfo, lfmResult] = await Promise.all([
      fetch(checkUserEndpoint(username, src)).then(r=>r.json()).catch(()=>null),
      fetchScrobblesSSE(username, msg => {
        if (msg._waiting) prog.textContent = `⏳ Límite Last.fm — esperando ${msg.waiting}s… (pág ${msg.page}/${msg.total_pages})`;
        else prog.textContent = `${username}: página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      }, src),
    ]);
    const heard      = lfmResult.heard;
    const songs      = lfmResult.heard_songs || [];
    const color      = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const image      = userInfo?.ok ? (userInfo.image || '') : '';
    const realUser   = userInfo?.ok ? userInfo.username : username;
    const fetched_at = Math.floor(Date.now()/1000);
    const last_scrobble_ts     = lfmResult.last_scrobble_ts    || 0;
    const last_scrobble_artist = lfmResult.last_scrobble_artist || '';
    const last_scrobble_track  = lfmResult.last_scrobble_track  || '';
    extraUsers.push({ user: realUser, pairs: heard, songs, color, count: heard.length, fetched_at, image, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    saveExtraUsersLS();
    await idbSave({ user: realUser, count: heard.length, fetched_at, heard, songs, source: src, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    await renderIdbExtraList();
    buildExtraUsersList();
    btn.textContent = '✓';
    prog.textContent = `✓ ${realUser} cargado — ${heard.length.toLocaleString()} álbumes, ${songs.length.toLocaleString()} canciones`;
    // Refresh friends list so the newly added user shows as already added
    const frList = document.getElementById('friends-list');
    if (frList?.children.length) {
      frList.querySelectorAll('.fr-add').forEach(b => {
        const row = b.closest('.fr-row');
        const name = row?.querySelector('.fr-name')?.textContent?.trim() || '';
        if (extraUsers.some(eu => eu.user.toLowerCase() === name.toLowerCase())) {
          b.disabled = true;
          b.textContent = '✓';
        }
      });
    }
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Añadir';
    prog.textContent = 'Error: ' + e.message;
  }
}

// inp-extra-json is still in DOM (appended after modal), handle it for back-compat
document.getElementById('inp-extra-json').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const prog = document.getElementById('um-extra-progress');
  try {
    const data = JSON.parse(await file.text());
    if (!data.heard || !data.user) throw new Error('Formato inválido');
    if (extraUsers.some(u => u.user.toLowerCase() === data.user.toLowerCase())) {
      prog.textContent = `${data.user} ya está en la lista.`; return;
    }
    const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const ft = data.fetched_at || 0;
    const importedSongs = data.songs || [];
    extraUsers.push({ user: data.user, pairs: data.heard, songs: importedSongs, color, count: data.heard.length, fetched_at: ft, image: '' });
    saveExtraUsersLS();
    await idbSave({ user: data.user, count: data.heard.length, fetched_at: ft, heard: data.heard, songs: importedSongs });
    buildExtraUsersList();
    prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
  } catch(err) {
    prog.textContent = 'Error: ' + err.message;
  }
  e.target.value = '';
});

function removeExtraUser(idx) {
  extraUsers.splice(idx, 1);
  saveExtraUsersLS();
  buildExtraUsersList();
}

// Legacy alias kept for call sites that haven't been updated yet
async function renderIdbExtraList() { return renderSecondaryUsers(); }

async function idbAddAsExtra(username) {
  const data = await idbLoad(username);
  if (!data) return;
  if (extraUsers.some(u => u.user.toLowerCase() === username.toLowerCase())) return;
  const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
  // try to get avatar
  const userInfo = await fetch(`/api/check_user?user=${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>null);
  const image = userInfo?.ok ? (userInfo.image || '') : '';
  extraUsers.push({ user: data.user, pairs: data.heard, songs: data.songs || [], color, count: data.heard.length, fetched_at: data.fetched_at || 0, image });
  saveExtraUsersLS();
  buildExtraUsersList();
  renderIdbExtraList();
  document.getElementById('um-extra-progress').textContent = `✓ ${data.user} añadido`;
}

/// ── Source helpers ────────────────────────────────────────────────────────
function umSource() {
  return document.getElementById('um-src-lb')?.checked ? 'lb' : 'lfm';
}
function sbSource() { return umSource(); } // sidebar eliminado, usar modal
function scrobblesEndpoint(user, source) {
  const base = source === 'lb' ? '/api/scrobbles/lb' : '/api/scrobbles';
  return `${base}?user=${encodeURIComponent(user)}`;
}
function sinceEndpoint(user, since, source) {
  const base = source === 'lb' ? '/api/scrobbles/lb/since' : '/api/scrobbles/since';
  return `${base}?user=${encodeURIComponent(user)}&since=${since}`;
}
function checkUserEndpoint(user, source) {
  const suffix = source === 'lb' ? '&source=lb' : '';
  return `/api/check_user?user=${encodeURIComponent(user)}${suffix}`;
}

// Sync placeholder text and .checked label class when source radio changes
function _syncSourceGroup(groupName, inputId, labels) {
  // labels: [{radioId, placeholder}]
  const radios = labels.map(l => document.getElementById(l.radioId));
  const inp    = document.getElementById(inputId);
  function update() {
    radios.forEach((r, i) => {
      if (!r) return;
      r.closest('label')?.classList.toggle('checked', r.checked);
      if (inp && r.checked) inp.placeholder = labels[i].placeholder;
    });
  }
  radios.forEach(r => r?.addEventListener('change', update));
  update(); // set initial state
}
document.addEventListener('DOMContentLoaded', () => {
  _syncSourceGroup('um-source', 'inp-user', [
    { radioId: 'um-src-lfm', placeholder: 'Usuario Last.fm' },
    { radioId: 'um-src-lb',  placeholder: 'Usuario ListenBrainz' },
  ]);
  // sb-source (sidebar eliminado) — no sync needed
});

// ── Helper: consume /api/scrobbles SSE stream ─────────────────────────────
async function fetchScrobblesSSE(user, onProgress, source = 'lfm') {
  const response = await fetch(scrobblesEndpoint(user, source));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader   = response.body.getReader();
  const decoder  = new TextDecoder();
  let buffer = '';
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.startsWith('data: ')) continue;
      const msg = JSON.parse(part.slice(6));
      if (msg.error) throw new Error(msg.error);
      if (msg.done) result = msg;
      else if (msg.waiting) onProgress({ ...msg, _waiting: true });
      else onProgress(msg);
    }
  }
  if (!result) throw new Error('No se recibió respuesta del servidor');
  return result; // {heard, last_scrobble_ts, last_scrobble_artist, last_scrobble_track, ...}
}

// (duplicate init block removed — single init at bottom of script)

// (toggleUmExtra removed — secondary section is now always visible in modal)

// ── Discover mode ─────────────────────────────────────────────────────────
function discoverCardHTML(a, i) {
  if (a.type === 'song') {
    const userBadges = (a.users || []).map(u =>
      u.image
        ? `<img class="rc-avatar" src="${escH(u.image)}" title="${escH(u.user)}: ${u.count} plays" alt="">`
        : `<div class="rc-dot" style="background:${u.color}" title="${escH(u.user)}: ${u.count} plays"></div>`
    ).join('');
    const cover = a.cover_url
      ? `<img class="card-cover" src="${escH(a.cover_url)}" loading="lazy" alt="">`
      : '';
    return `<div class="card rec-card disc-song-card" data-disc="${i}" style="cursor:pointer">
      ${cover}
      <div class="disc-song-ph"${a.cover_url ? ' style="display:none"' : ''}>
        <div class="disc-song-icon">♪</div>
      </div>
      <div class="card-overlay"></div>
      <div class="card-info">
        <div class="card-title">${escH(a.orig_t)}</div>
        <div class="card-artist">${escH(a.orig_a)}</div>
        ${a.orig_album ? `<div class="card-album-hint">${escH(a.orig_album)}</div>` : ''}
        <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
      </div>
    </div>`;
  }
  if (a.type === 'artist') {
    const userBadges = (a.users || []).map(u =>
      u.image
        ? `<img class="rc-avatar" src="${escH(u.image)}" title="${escH(u.user)}: ${u.count} plays" alt="">`
        : `<div class="rc-dot" style="background:${u.color}" title="${escH(u.user)}: ${u.count} plays"></div>`
    ).join('');
    const coverEl = a.cover_url
      ? `<img class="card-cover disc-artist-img" src="${escH(a.cover_url)}" alt="">`
      : `<img class="card-cover disc-artist-img" src="data:," alt="" style="display:none">
         <div class="disc-artist-icon">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
             <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
           </svg>
         </div>`;
    return `<div class="card rec-card disc-artist-card" data-disc="${i}" style="cursor:pointer">
      ${coverEl}
      <div class="card-overlay"></div>
      <div class="card-info">
        <div class="card-title">${escH(a.orig_a)}</div>
        <div class="card-artist" style="opacity:0.6">${a.album_count} álbum${a.album_count !== 1 ? 'es' : ''}</div>
        <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
      </div>
    </div>`;
  }
  const cover = a.cover_url
    ? `<img class="card-cover" src="${escH(a.cover_url)}" loading="lazy" alt="">`
    : '';
  const ph = `<div class="card-placeholder" ${a.cover_url ? 'style="display:none"' : ''}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
    </svg></div>`;
  const userBadges = (a.users || []).map(u =>
    u.image
      ? `<img class="rc-avatar" src="${escH(u.image)}" title="${escH(u.user)}: ${u.count} plays" alt="">`
      : `<div class="rc-dot" style="background:${u.color}" title="${escH(u.user)}: ${u.count} plays"></div>`
  ).join('');
  return `<div class="card rec-card" data-disc="${i}" style="cursor:pointer">
    ${cover}${ph}
    <div class="card-overlay"></div>
    <div class="card-info">
      <div class="card-title">${escH(a.mb_title || a.orig_t)}</div>
      <div class="card-artist">${escH(a.mb_artist || a.orig_a)}</div>
      ${a.date ? `<div class="card-year">${escH(a.date.slice(0,4))}</div>` : ''}
      <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
    </div>
  </div>`;
}

function renderDiscoverGrid() {
  const dg = document.getElementById('discover-grid');
  let filtered = discoverAlbums;
  if (discoverDecadeFilter.size) {
    filtered = filtered.filter(a => {
      const yr = parseInt((a.date || '').slice(0,4));
      if (!yr) return false;
      return discoverDecadeFilter.has(Math.floor(yr / 10) * 10);
    });
  }
  dg.innerHTML = filtered.map((a, i) => discoverCardHTML(a, discoverAlbums.indexOf(a))).join('');
  dg.querySelectorAll('img.card-cover').forEach(img => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
    });
  });
  dg.querySelectorAll('.card[data-disc]').forEach(c => {
    c.addEventListener('click', () => {
      const idx = parseInt(c.dataset.disc);
      const entry = discoverAlbums[idx];
      if (entry?.type === 'artist') {
        openDetailPanel({ type: 'discover_artist', idx });
      } else if (entry?.type === 'song') {
        openDetailPanel({ type: 'discover_song', idx });
      } else {
        openDetailPanel({ type: 'discover', idx });
      }
    });
  });
  // Update count label (element may not exist if removed from template)
  const noun = discoverModeType === 'songs' ? 'canciones' : discoverModeType === 'artists' ? 'artistas' : 'álbumes';
  const _countEl = document.getElementById('discover-count');
  if (_countEl) _countEl.textContent =
    `${filtered.length} ${noun}${discoverCandidates.length > discoverAlbums.length ? ` de ${discoverCandidates.length} candidatos` : ''}`;
  // Decade pills
  const decades = new Set();
  discoverAlbums.forEach(a => {
    const yr = parseInt((a.date || '').slice(0,4));
    if (yr) decades.add(Math.floor(yr / 10) * 10);
  });
  const pillsEl = document.getElementById('discover-decade-pills');
  pillsEl.innerHTML = [...decades].sort().map(d =>
    `<button class="filter-pill${discoverDecadeFilter.has(d) ? ' active' : ''}" data-decade="${d}">${d}s</button>`
  ).join('');
  pillsEl.querySelectorAll('.filter-pill').forEach(b => {
    b.addEventListener('click', () => {
      const d = parseInt(b.dataset.decade);
      if (discoverDecadeFilter.has(d)) discoverDecadeFilter.delete(d);
      else discoverDecadeFilter.add(d);
      renderDiscoverGrid();
    });
  });
}

function enterDiscoverMode(userIdx, limit = 20, mode = 'albums') {
  if (!extraUsers.length) return;
  const u = extraUsers[userIdx];
  if (!u) return;
  limit = Math.min(100, Math.max(1, limit));

  discoverMode     = true;
  discoverPage     = 0;
  discoverLimit    = limit;
  discoverModeType = mode;
  discoverUserIdx  = userIdx;
  discoverAllCandidates = [];
  discoverDecadeFilter.clear();
  if (discoverEs) { discoverEs.close(); discoverEs = null; }

  const primaryPairs = heardCache ? new Set(heardCache.pairs.map(p => p[0] + '|' + p[1])) : new Set();

  if (mode === 'artists') {
    // ── Artists mode: exclude artists heard by primary (uses full artist set if available) ──
    const primaryArtists = heardCache
      ? (heardCache.artist_set || new Set(heardCache.pairs.map(p => p[0])))
      : new Set();
    const amap = {};
    for (const p of u.pairs) {
      const normA = p[0];
      if (primaryArtists.has(normA)) continue;
      const origA = p[2] || p[0];
      if (!amap[normA]) amap[normA] = { norm_a: normA, orig_a: origA, orig_t: '', total: 0, album_count: 0, users: [], type: 'artist' };
      const count = p[4] || 1;
      amap[normA].total += count;
      amap[normA].album_count++;
      if (!amap[normA].users.length)
        amap[normA].users.push({ user: u.user, count: 0, color: u.color, image: u.image || '' });
      amap[normA].users[0].count += count;
    }
    discoverAllCandidates = Object.values(amap).sort((a, b) => b.total - a.total);
  } else if (mode === 'songs') {
    // ── Songs mode: exclude songs heard by primary ───────────────────────────
    const primarySongs = heardCache
      ? (heardCache.song_set || new Set((heardCache.songs || []).map(s => s[0] + '|' + s[1])))
      : new Set();
    const smap = {};
    for (const s of (u.songs || [])) {
      // s = [norm_a, norm_track, orig_a, orig_album, orig_track, count]
      const key = s[0] + '|' + s[1];
      if (primarySongs.has(key)) continue;
      if (!smap[key]) smap[key] = {
        norm_a: s[0], norm_t: s[1],
        orig_a: s[2] || s[0], orig_album: s[3] || '',
        orig_t: s[4] || s[1],
        total: 0, users: [], type: 'song',
      };
      const count = s[5] || 1;
      smap[key].total += count;
      smap[key].users.push({ user: u.user, count, color: u.color, image: u.image || '' });
    }
    discoverAllCandidates = Object.values(smap).sort((a, b) => b.total - a.total);
  } else {
    // ── Albums mode (default) ────────────────────────────────────────────────
    const cmap = {};
    for (const p of u.pairs) {
      const key = p[0] + '|' + p[1];
      if (primaryPairs.has(key)) continue;
      if (!cmap[key]) cmap[key] = {
        norm_a: p[0], norm_t: p[1],
        orig_a: p[2] || p[0], orig_t: p[3] || p[1],
        total: 0, users: [],
      };
      const count = p[4] || 1;
      cmap[key].total += count;
      cmap[key].users.push({ user: u.user, count, color: u.color, image: u.image || '' });
    }
    discoverAllCandidates = Object.values(cmap).sort((a, b) => b.total - a.total);
  }

  // Show discover view
  document.getElementById('discover-view').classList.add('visible');
  const _es = document.getElementById('empty-state'); if (_es) _es.style.display = 'none';
  closeSidebar();

  _loadDiscoverPage();
}

function _enrichSongCovers() {
  // Collect unique (orig_a, orig_album) pairs that still need covers, keyed by "a|||album"
  const needed = {};  // "a|||album" -> [idx, ...]
  discoverAlbums.forEach((a, i) => {
    if (a.type !== 'song' || a.cover_url || !a.orig_album) return;
    const k = (a.orig_a || '') + '|||' + (a.orig_album || '');
    if (!needed[k]) needed[k] = { orig_a: a.orig_a, orig_album: a.orig_album, idxs: [] };
    needed[k].idxs.push(i);
  });
  const pairs = Object.values(needed);
  if (!pairs.length) return;

  // Use api_enrich_albums SSE to fetch missing covers
  const url = '/api/enrich_albums?albums=' + encodeURIComponent(JSON.stringify(
    pairs.map(p => [p.orig_a, p.orig_album])
  ));
  const es = new EventSource(url);
  es.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.done || msg.error) { es.close(); return; }
    if (!msg.artist || !msg.album || !msg.cover_url) return;
    const k = msg.artist + '|||' + msg.album;
    enrichCacheSet(msg.artist, msg.album, { cover_url: msg.cover_url, mbid: msg.mbid || '' });
    const entry = needed[k];
    if (!entry) return;
    entry.idxs.forEach(idx => {
      if (!discoverAlbums[idx]) return;
      discoverAlbums[idx].cover_url = msg.cover_url;
      // Patch the card in the DOM
      const card = document.querySelector(`#discover-grid .card[data-disc="${idx}"]`);
      if (!card) return;
      let img = card.querySelector('.card-cover');
      const ph = card.querySelector('.disc-song-ph');
      if (!img) {
        img = document.createElement('img');
        img.className = 'card-cover';
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = function() {
          this.style.display = 'none';
          if (ph) ph.style.display = 'flex';
        };
        card.insertBefore(img, card.firstChild);
      }
      if (ph) ph.style.display = 'none';
      img.style.display = '';
      img.src = msg.cover_url;
    });
  };
  es.onerror = () => es.close();
}

function _loadDiscoverPage() {
  discoverAlbums  = [];
  discoverOffset  = 0;
  discoverSearching = false;
  discoverDecadeFilter.clear();
  if (discoverEs) { discoverEs.close(); discoverEs = null; }

  discoverCandidates = discoverAllCandidates.slice(
    discoverPage * discoverLimit,
    (discoverPage + 1) * discoverLimit
  );

  _updateDiscoverPagination();

  const u = extraUsers[discoverUserIdx];
  const uName = u ? escH(u.user) : '?';

  if (!discoverCandidates.length) {
    document.getElementById('discover-progress').textContent = 'Sin candidatos para este usuario';
    document.getElementById('discover-footer').style.display = '';
    renderDiscoverGrid();
    return;
  }

  if (discoverModeType === 'artists') {
    discoverAlbums = discoverCandidates.map(c => ({
      ...c, mb_artist: c.orig_a, mb_title: '', cover_url: '', date: '', mbid: '',
    }));
    renderDiscoverGrid();
    document.getElementById('discover-footer').style.display = '';
    document.getElementById('discover-progress').textContent =
      `${discoverAlbums.length} artistas de ${uName} (pág. ${discoverPage + 1})`;
    // Load artist images: try Last.fm first, fall back to album cover from enrichment cache
    discoverAlbums.forEach((a, i) => {
      const hit = enrichCacheGet(a.orig_a, '');
      if (hit?.cover_url) {
        _applyArtistCover(i, hit.cover_url);
        return;
      }
      // Fallback: look for any album cover from this artist in enrichment cache
      const u2 = extraUsers[discoverUserIdx];
      if (u2) {
        for (const p of u2.pairs) {
          if (p[0] === a.norm_a) {
            const albumHit = enrichCacheGet(p[2] || p[0], p[3] || p[1]);
            if (albumHit?.cover_url) {
              enrichCacheSet(a.orig_a, '', { cover_url: albumHit.cover_url });
              _applyArtistCover(i, albumHit.cover_url);
              return;
            }
          }
        }
      }
      fetch(`/api/artist_info?artist=${encodeURIComponent(a.orig_a)}`)
        .then(r => r.json())
        .then(info => {
          const imgUrl = info?.image || '';
          if (!imgUrl) return;
          discoverAlbums[i].cover_url = imgUrl;
          enrichCacheSet(a.orig_a, '', { cover_url: imgUrl });
          _applyArtistCover(i, imgUrl);
        }).catch(() => {});
    });
  } else if (discoverModeType === 'songs') {
    discoverAlbums = discoverCandidates.map(c => {
      const entry = { ...c };
      // Pre-fill cover from enrichment cache if we have an album name
      if (!entry.cover_url && entry.orig_album) {
        const hit = enrichCacheGet(entry.orig_a, entry.orig_album);
        if (hit?.cover_url) entry.cover_url = hit.cover_url;
      }
      return entry;
    });
    renderDiscoverGrid();
    document.getElementById('discover-footer').style.display = '';
    document.getElementById('discover-progress').textContent =
      `${discoverAlbums.length} canciones de ${uName} (pág. ${discoverPage + 1})`;
    _enrichSongCovers();
  } else {
    document.getElementById('discover-footer').style.display = '';
    document.getElementById('discover-progress').textContent =
      `Buscando ${discoverCandidates.length} álbumes de ${uName}…`;
    loadMoreDiscover();
  }
}

function _updateDiscoverPagination() {
  const total   = discoverAllCandidates.length;
  const maxPage = Math.ceil(total / discoverLimit) - 1;
  const pag  = document.getElementById('discover-pagination');
  pag.style.display = total > discoverLimit ? '' : 'none';
  document.getElementById('disc-prev').disabled = discoverPage <= 0;
  document.getElementById('disc-next').disabled = discoverPage >= maxPage;
  const from = discoverPage * discoverLimit + 1;
  const to   = Math.min((discoverPage + 1) * discoverLimit, total);
  document.getElementById('disc-page-info').textContent = `${from}–${to} de ${total}`;
}

function discoverPrevPage() {
  if (discoverPage <= 0 || discoverSearching) return;
  discoverPage--;
  _loadDiscoverPage();
}

function discoverNextPage() {
  const maxPage = Math.ceil(discoverAllCandidates.length / discoverLimit) - 1;
  if (discoverPage >= maxPage || discoverSearching) return;
  discoverPage++;
  _loadDiscoverPage();
}

function leaveDiscoverMode() {
  discoverMode = false;
  if (discoverEs) { discoverEs.close(); discoverEs = null; }
  document.getElementById('discover-view').classList.remove('visible');
  const _es2 = document.getElementById('empty-state'); if (_es2) _es2.style.display = '';
}

function loadMoreDiscover() {
  if (discoverSearching) return;
  // Load all remaining candidates (limit was chosen at entry)
  const batch = discoverCandidates.slice(discoverOffset);
  if (!batch.length) {
    document.getElementById('discover-progress').textContent = '✓ No hay más candidatos';
    return;
  }

  discoverSearching = true;
  const prog = document.getElementById('discover-progress');
  document.getElementById('discover-footer').style.display = '';

  // Build placeholders, separating cached vs uncached items
  const startIdx   = discoverAlbums.length;
  const uncachedJs = [];  // batch indices that need SSE enrichment

  batch.forEach((c, j) => {
    const hit = enrichCacheGet(c.orig_a, c.orig_t);
    discoverAlbums.push({
      ...c,
      mbid:      hit?.mbid      || '',
      cover_url: hit?.cover_url || '',
      mb_title:  hit?.mb_title  || c.orig_t,
      mb_artist: hit?.mb_artist || c.orig_a,
      date:      hit?.date      || '',
    });
    if (!hit) uncachedJs.push(j);
  });
  renderDiscoverGrid();

  // If everything was cached, no SSE needed
  if (!uncachedJs.length) {
    discoverOffset  += batch.length;
    discoverSearching = false;
    prog.textContent  = `✓ ${discoverAlbums.length} álbumes`;
    return;
  }

  prog.textContent = `Consultando… (0 / ${uncachedJs.length})`;

  if (discoverEs) { discoverEs.close(); discoverEs = null; }
  const sseBatch    = uncachedJs.map(j => [batch[j].orig_a, batch[j].orig_t]);
  const albumsParam = encodeURIComponent(JSON.stringify(sseBatch));
  discoverEs = new EventSource(`/api/enrich_albums?albums=${albumsParam}`);

  discoverEs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.done) {
      discoverEs.close(); discoverEs = null;
      discoverOffset  += batch.length;
      discoverSearching = false;
      prog.textContent  = `✓ ${discoverAlbums.length} álbumes encontrados`;
      return;
    }
    if (typeof msg.i === 'number') {
      const aIdx = startIdx + uncachedJs[msg.i];  // map SSE index → discoverAlbums index
      if (!discoverAlbums[aIdx]) return;
      const cover_url = msg.cover_url || (msg.mbid ? `/api/cover?mbid=${encodeURIComponent(msg.mbid)}` : '');
      const enriched  = {
        mbid:      msg.mbid      || '',
        cover_url,
        mb_title:  msg.mb_title  || discoverAlbums[aIdx].orig_t,
        mb_artist: msg.mb_artist || discoverAlbums[aIdx].orig_a,
        date:      msg.date      || '',
      };
      Object.assign(discoverAlbums[aIdx], enriched);
      enrichCacheSet(discoverAlbums[aIdx].orig_a, discoverAlbums[aIdx].orig_t, enriched);
      _patchDiscoverCard(aIdx, discoverAlbums[aIdx]);
    }
    prog.textContent = `Buscando… (${msg.i + 1} / ${uncachedJs.length})`;
  };

  discoverEs.onerror = () => {
    discoverEs.close(); discoverEs = null;
    discoverOffset  += batch.length;
    discoverSearching = false;
    prog.textContent  = `✓ ${discoverAlbums.length} álbumes encontrados`;
  };
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
  });
});

// ── Enrich cache ─────────────────────────────────────────────────────────
// Key: "artist|||title" (title='' for artist-mode entries)
// Value: {cover_url, mbid?, mb_title?, mb_artist?, date?}
const ENRICH_CACHE_KEY = 'enrich_cache_v1';
function enrichCacheGet(artist, title) {
  try {
    const c = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
    return c[artist + '|||' + title] || null;
  } catch(e) { return null; }
}
function enrichCacheSet(artist, title, data) {
  if (!data?.cover_url) return;
  try {
    const c = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
    c[artist + '|||' + title] = data;
    localStorage.setItem(ENRICH_CACHE_KEY, JSON.stringify(c));
  } catch(e) {}
}

// ── YouTube cache & embed ─────────────────────────────────────────────────
const YT_CACHE_KEY = 'yt_ids_v1';
function ytCacheGet(artist, album) {
  try {
    const c = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
    const v = c[artist + '|||' + album];
    return v !== undefined ? v : null;
  } catch(e) { return null; }
}
function ytCacheSet(artist, album, videoId) {
  try {
    const c = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
    c[artist + '|||' + album] = videoId;
    localStorage.setItem(YT_CACHE_KEY, JSON.stringify(c));
  } catch(e) {}
}
function embedYT(videoId) {
  const ytDiv = document.getElementById('dp-yt');
  if (!videoId) { ytDiv.style.display = 'none'; ytDiv.innerHTML = ''; return; }
  ytDiv.style.display = '';
  ytDiv.innerHTML = `<iframe src="https://www.youtube.com/embed/${escH(videoId)}?rel=0"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowfullscreen></iframe>`;
  // Swap "Buscar YouTube" search link → direct watch link
  const linksEl = document.getElementById('dp-links');
  const searchA = linksEl.querySelector('a[href*="results?search_query"]');
  if (searchA) {
    searchA.href = `https://www.youtube.com/watch?v=${escH(videoId)}`;
    searchA.textContent = 'YouTube ↗';
  } else if (!linksEl.querySelector('a[href*="watch?v="]')) {
    linksEl.insertAdjacentHTML('beforeend',
      `<a class="dp-link" href="https://www.youtube.com/watch?v=${escH(videoId)}" target="_blank">YouTube ↗</a>`);
  }
}
async function fetchAndEmbedYT(artist, album) {
  if (!artist || !album) return;
  const cached = ytCacheGet(artist, album);
  if (cached !== null) { embedYT(cached); return; }
  try {
    const r = await fetch(`/api/yt_search?${new URLSearchParams({ artist, album })}`);
    if (!r.ok) return;
    const data = await r.json();
    if (typeof data.videoId === 'string') {
      ytCacheSet(artist, album, data.videoId);
      embedYT(data.videoId);
    }
  } catch(e) {}
}

// ── Modal ──────────────────────────────────────────────────────────────────
// ── Detail side panel ──────────────────────────────────────────────────────
function openDetailPanel(ref) {
  // ref: {type:'discover'|'discover_artist'|'discover_song', idx}
  let title, artist, year, cover, mbid, yt_id, heard, extraHeard, descCached;
  if (ref.type === 'discover_artist') {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.orig_a; artist = a.orig_a;
    year = ''; cover = a.cover_url || ''; mbid = ''; yt_id = ''; heard = false; extraHeard = null;
    descCached = '';
    // title kept as artist name for display; album passed as '' to fetchAlbumInfo
  } else if (ref.type === 'discover_song') {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.orig_t; artist = a.orig_a;
    year = '';
    const _songHit = a.orig_album ? enrichCacheGet(a.orig_a, a.orig_album) : null;
    cover = a.cover_url || _songHit?.cover_url || '';
    mbid = ''; yt_id = ''; heard = false; extraHeard = null;
    descCached = '';
  } else {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.mb_title || a.orig_t; artist = a.mb_artist || a.orig_a;
    year = a.date ? a.date.slice(0,4) : ''; cover = a.cover_url;
    mbid = a.mbid; yt_id = ''; heard = false; extraHeard = null;
    descCached = '';
  }

  // Reset panel
  const panel = document.getElementById('detail-panel');
  document.getElementById('dp-loading').style.display = 'none';
  document.getElementById('dp-stats').style.display   = 'none';
  document.getElementById('dp-tags').innerHTML        = '';
  document.getElementById('dp-yt').style.display      = 'none';
  document.getElementById('dp-yt').innerHTML          = '';
  document.getElementById('dp-album-wiki').style.display  = 'none';
  document.getElementById('dp-artist-bio').style.display  = 'none';
  document.getElementById('dp-links').innerHTML       = '';

  // Cover
  const dpCover = document.getElementById('dp-cover');
  if (cover) { dpCover.src = cover; dpCover.style.display = ''; }
  else        { dpCover.src = ''; dpCover.style.display = 'none'; }

  document.getElementById('dp-title').textContent  = title  || '';
  document.getElementById('dp-artist').textContent = artist || '';
  document.getElementById('dp-year').textContent   = year   || '';

  // Status not shown for discover entries
  document.getElementById('dp-status').style.display = 'none';

  // Extra users status
  const extraSt = document.getElementById('dp-extra-status');
  if (false) { // collection extra-status not used in app_discover
    extraSt.innerHTML = extraUsers.map((u, i) => {
      const h = extraHeard[i];
      const icon = u.image
        ? `<img src="${escH(u.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;opacity:${h?1:.3}">`
        : `<span style="width:8px;height:8px;border-radius:50%;background:${u.color};display:inline-block;opacity:${h?1:.25}"></span>`;
      return `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${h?u.color:'var(--ink3)'}">
        ${icon} ${escH(u.user)}: ${h ? '✓' : '—'}</span>`;
    }).join('');
    extraSt.style.display = 'flex';
  } else if (['discover','discover_artist','discover_song'].includes(ref.type)) {
    const a = discoverAlbums[ref.idx];
    if (a?.users?.length) {
      const extraLabel = ref.type === 'discover_artist'
        ? a.users.map(u => `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${u.color}">
            ${u.image ? `<img src="${escH(u.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover">` : `<span style="width:8px;height:8px;border-radius:50%;background:${u.color};display:inline-block"></span>`}
            ${escH(u.user)}: ${a.total} plays · ${a.album_count} álbum${a.album_count!==1?'es':''}</span>`)
        : a.users.map(u => `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${u.color}">
            ${u.image ? `<img src="${escH(u.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover">` : `<span style="width:8px;height:8px;border-radius:50%;background:${u.color};display:inline-block"></span>`}
            ${escH(u.user)}: ${u.count} plays</span>`);
      extraSt.innerHTML = extraLabel.join('');
      extraSt.style.display = 'flex';
    } else { extraSt.innerHTML = ''; extraSt.style.display = 'none'; }
  } else { extraSt.innerHTML = ''; extraSt.style.display = 'none'; }

  // YouTube
  if (yt_id) {
    const ytDiv = document.getElementById('dp-yt');
    ytDiv.style.display = '';
    ytDiv.innerHTML = `<iframe src="https://www.youtube.com/embed/${escH(yt_id)}?rel=0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen></iframe>`;
  }

  // Cached description
  if (descCached) {
    document.getElementById('dp-wiki-text').textContent = descCached;
    document.getElementById('dp-album-wiki').style.display = '';
  }

  // Links
  const links = [];
  if (mbid)  links.push(`<a class="dp-link" href="https://musicbrainz.org/release-group/${mbid}" target="_blank">MusicBrainz</a>`);
  if (artist && title) {
    const ytQ = encodeURIComponent(`${artist} ${title}`);
    links.push(`<a class="dp-link" href="https://www.youtube.com/results?search_query=${ytQ}" target="_blank">Buscar YouTube ↗</a>`);
  }
  document.getElementById('dp-links').innerHTML = links.join('');

  // Open
  document.getElementById('detail-overlay').classList.add('open');
  panel.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Fetch LFM + MB info asynchronously
  // discover_artist: album=''; discover_song: use orig_album if available; discover: full album name
  let fetchAlbum;
  if (ref.type === 'discover_artist') {
    fetchAlbum = '';
  } else if (ref.type === 'discover_song') {
    fetchAlbum = discoverAlbums[ref.idx]?.orig_album || '';
  } else {
    fetchAlbum = title || '';
  }
  fetchAlbumInfo(artist || '', fetchAlbum, mbid || '');

  // Fetch YouTube embed for album and song entries
  if ((ref.type === 'discover' || ref.type === 'discover_song') && title) {
    fetchAndEmbedYT(artist, title);
  }
}

function closeDetailPanel() {
  document.getElementById('dp-yt').innerHTML = '';
  document.getElementById('dp-yt').style.display = 'none';
  document.getElementById('detail-overlay').classList.remove('open');
  document.getElementById('detail-panel').classList.remove('open');
  document.body.style.overflow = '';
}

document.getElementById('detail-overlay').addEventListener('click', closeDetailPanel);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.getElementById('detail-panel').classList.contains('open'))
    closeDetailPanel();
});

function _applyAlbumInfoToPanel(data, artist) {
  const dpCover = document.getElementById('dp-cover');
  const coverMissing = !dpCover.src || dpCover.src.endsWith('undefined') || dpCover.style.display === 'none';

  // Cover priority: MBID → Last.fm artist image (never both — avoids NS_BINDING_ABORTED)
  if (data.cover_url && coverMissing) {
    dpCover.src = data.cover_url; dpCover.style.display = '';
  } else if (data.artist?.image && coverMissing) {
    dpCover.src = data.artist.image; dpCover.style.display = '';
  }

  // Stats — album listeners first, fall back to artist listeners
  const listeners = data.lfm?.listeners || data.artist?.listeners || '';
  const playcount  = data.lfm?.playcount || '';
  if (listeners || playcount) {
    const s = document.getElementById('dp-stats');
    s.innerHTML = (listeners ? `<span><b>${parseInt(listeners||0).toLocaleString()}</b> oyentes</span>` : '')
                + (playcount ? `<span><b>${parseInt(playcount||0).toLocaleString()}</b> plays globales</span>` : '');
    s.style.display = 'flex';
  }

  // Tags
  if (data.lfm?.tags?.length) {
    document.getElementById('dp-tags').innerHTML =
      data.lfm.tags.map(t => `<span class="dp-tag">${escH(t)}</span>`).join('');
  }

  // Album wiki
  if (data.lfm?.wiki) {
    document.getElementById('dp-wiki-text').textContent = data.lfm.wiki;
    document.getElementById('dp-album-wiki').style.display = '';
  }

  // Artist bio
  if (data.artist?.bio) {
    document.getElementById('dp-artist-bio-title').textContent = artist;
    document.getElementById('dp-bio-text').textContent = data.artist.bio;
    document.getElementById('dp-artist-bio').style.display = '';
  }

  // Update links if we got a new MBID
  const linksEl = document.getElementById('dp-links');
  if (data.mbid && !linksEl.innerHTML.includes('musicbrainz')) {
    linksEl.innerHTML =
      `<a class="dp-link" href="https://musicbrainz.org/release-group/${data.mbid}" target="_blank">MusicBrainz</a>`
      + linksEl.innerHTML;
  }
  // Last.fm album link
  if (data.lfm?.url && !linksEl.innerHTML.includes('last.fm')) {
    linksEl.insertAdjacentHTML('beforeend',
      `<a class="dp-link" href="${escH(data.lfm.url)}" target="_blank">Last.fm álbum</a>`);
  }
  // Last.fm artist link
  if (data.artist?.url && !linksEl.innerHTML.includes('Last.fm artista')) {
    linksEl.insertAdjacentHTML('beforeend',
      `<a class="dp-link" href="${escH(data.artist.url)}" target="_blank">Last.fm artista</a>`);
  }
}

async function fetchAlbumInfo(artist, album, mbid) {
  const loading = document.getElementById('dp-loading');
  loading.style.display = '';
  const cacheKey = `${artist}|||${album}`;
  try {
    // Use in-memory cache to avoid repeated server calls for same album
    if (albumInfoCache.has(cacheKey)) {
      _applyAlbumInfoToPanel(albumInfoCache.get(cacheKey), artist);
      loading.style.display = 'none';
      return;
    }
    const p = new URLSearchParams({ artist, album });
    if (mbid) p.set('mbid', mbid);
    const data = await fetch(`/api/album_info?${p}`).then(r => r.json());
    if (data.error) { loading.style.display = 'none'; return; }
    albumInfoCache.set(cacheKey, data);
    _applyAlbumInfoToPanel(data, artist);
  } catch(e) {}
  loading.style.display = 'none';
}

// ── Artist cover: apply to card via background-image (most reliable approach) ──
function _applyArtistCover(idx, url) {
  if (!url) return;
  discoverAlbums[idx] = discoverAlbums[idx] || {};
  discoverAlbums[idx].cover_url = url;
  const card = document.querySelector(`#discover-grid .card[data-disc="${idx}"]`);
  if (!card) return;
  // Use background-image directly on the card — avoids all img display/src timing issues
  card.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
  card.style.backgroundSize = 'cover';
  card.style.backgroundPosition = 'center';
  // Hide the person icon placeholder
  const icon = card.querySelector('.disc-artist-icon');
  if (icon) icon.style.display = 'none';
  // Hide the dummy img if present
  const img = card.querySelector('.disc-artist-img');
  if (img) img.style.display = 'none';
}

// ── _patchDiscoverCard: update single card without re-render ───────────────
function _patchDiscoverCard(idx, a) {
  const card = document.querySelector(`#discover-grid .card[data-disc="${idx}"]`);
  if (!card) return;
  if (a.cover_url) {
    let img = card.querySelector('.card-cover');
    const ph = card.querySelector('.card-placeholder');
    const artistIcon = card.querySelector('.disc-artist-icon');
    if (!img) {
      img = document.createElement('img');
      img.className = 'card-cover';
      img.alt = '';
      card.insertBefore(img, card.firstChild);
    }
    if (img.src !== a.cover_url) {
      img.onerror = function() {
        this.style.display = 'none';
        if (ph) ph.style.display = 'flex';
        if (artistIcon) artistIcon.style.display = 'flex';
      };
      if (ph) ph.style.display = 'none';
      if (artistIcon) artistIcon.style.display = 'none';
      img.style.display = '';   // visible BEFORE src to avoid hidden-element load suppression
      img.src = a.cover_url;
    }
  }
  const titleEl  = card.querySelector('.card-title');
  const artistEl = card.querySelector('.card-artist');
  if (titleEl  && a.mb_title)  titleEl.textContent  = a.mb_title;
  if (artistEl && a.mb_artist) artistEl.textContent = a.mb_artist;
  if (a.date) {
    let yearEl = card.querySelector('.card-year');
    if (!yearEl) {
      yearEl = document.createElement('div');
      yearEl.className = 'card-year';
      const rcUsers = card.querySelector('.rc-users');
      const info = card.querySelector('.card-info');
      if (info && rcUsers) info.insertBefore(yearEl, rcUsers);
      else if (info) info.appendChild(yearEl);
    }
    yearEl.textContent = a.date.slice(0, 4);
  }
}

// ── Sidebar USUARIOS panel ────────────────────────────────────────────────
// renderSbUsersList was the old sidebar renderer — now just an alias so old call sites work
async function renderSbUsersList() { return renderSecondaryUsers(); }

async function sbSyncPrimary() {
  if (!heardCache) return;
  const prog = document.getElementById('um-extra-progress');
  if (prog) prog.textContent = 'Sincronizando...';
  try {
    const url = `/api/scrobbles/update?user=${encodeURIComponent(heardCache.user)}&known_count=${heardCache.count||0}`;
    const data = await fetch(url).then(r => r.json());
    if (data.error) { if (prog) prog.textContent = 'Error: ' + data.error; return; }
    if (data.new_count === 0) { if (prog) prog.textContent = '✓ Al día'; return; }
    if (data.full_replace) {
      heardCache.pairs = data.heard; heardCache.count = data.heard.length; heardCache.fetched_at = data.fetched_at;
      showUserBadge(heardCache.user, document.getElementById('badge-avatar')?.src||'', heardCache.count, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
      if (prog) prog.textContent = '✓ Al día';
      await renderSecondaryUsers();
    }
  } catch(e) { if (prog) prog.textContent = 'Error: ' + e.message; }
}

function sbSavePrimaryJson() {
  if (!heardCache) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
  const blob = new Blob([JSON.stringify({ version:1, user:heardCache.user, count:heardCache.count, fetched_at:heardCache.fetched_at, heard:heardCache.pairs, songs: heardCache.songs||[], yt_ids, covers }, null, 0)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${heardCache.user}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function idbExportAll() {
  const sessions = await idbList();
  if (!sessions.length) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
  const blob = new Blob([JSON.stringify({ version: 1, exported_at: Date.now(), sessions, yt_ids, covers }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function showCacheNotice() {
  const notice = document.getElementById('sb-cache-notice');
  if (!notice || notice.dataset.shown) return;
  const sessions = await idbList();
  const secondarySessions = sessions.filter(s => s.user.toLowerCase() !== (heardCache?.user||'').toLowerCase());
  if (!secondarySessions.length) return;
  const oldest = secondarySessions.sort((a,b) => a.fetched_at - b.fetched_at)[0];
  const oldestDate = oldest ? new Date(oldest.fetched_at * 1000).toLocaleDateString() : '';
  let storageInfo = '';
  if (navigator.storage?.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const pct = Math.round(usage / quota * 100);
      const usedMB = (usage / 1048576).toFixed(0);
      storageInfo = ` (almacenamiento: ${pct}%, ${usedMB} MB usados)`;
    } catch {}
  }
  notice.dataset.shown = '1';
  notice.style.display = '';
  notice.innerHTML = `
    <b>⚠ Aviso de caché</b>${storageInfo}<br>
    Tienes <b>${secondarySessions.length}</b> usuario${secondarySessions.length > 1 ? 's' : ''} secundario${secondarySessions.length > 1 ? 's' : ''} guardado${secondarySessions.length > 1 ? 's' : ''}.
    Si se agota el espacio del navegador al añadir uno nuevo, el más antiguo
    (<b>${escH(oldest?.user || '')}</b>, descargado el ${oldestDate}) podría eliminarse automáticamente.
    <b>Se recomienda hacer una copia de seguridad antes de continuar.</b>
    <div class="notice-btns">
      <button class="btn-sm" data-action="export">↓ Exportar todo (backup)</button>
      <button class="btn-sm" data-action="close-notice">✕ Cerrar</button>
    </div>`;
}


// ── UI helpers ─────────────────────────────────────────────────────────────
function showLoading(msg) { loadTxt.textContent = msg || 'Cargando...'; loading.classList.add('visible'); }
function hideLoading()    { loading.classList.remove('visible'); }
function showError(msg)   { errMsg.textContent = msg; errMsg.classList.add('visible'); }
function hideError()      { errMsg.classList.remove('visible'); }
function hideResults() { heardCache = null; loadedUser = null; }
function escH(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── IndexedDB ─────────────────────────────────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath: 'user' });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbSave(data) {
  const db = await openIDB();
  const _put = payload => new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ ...payload, user: payload.user.toLowerCase() });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
  try {
    return await _put(data);
  } catch(e) {
    if (e.name !== 'QuotaExceededError') throw e;
    // Sin canciones (songs pueden ser varios MB para usuarios grandes)
    console.warn('[idb] QuotaExceededError — guardando sin canciones');
    try {
      return await _put({ ...data, songs: [] });
    } catch(e2) {
      if (e2.name !== 'QuotaExceededError') throw e2;
      // Sin heard tampoco — solo metadatos para que el usuario aparezca en la lista
      console.warn('[idb] QuotaExceededError — guardando solo metadatos');
      const { heard, songs, ...meta } = data;
      return await _put({ ...meta, heard: [], songs: [], partial: true }).catch(() => null);
    }
  }
}
async function idbLoad(username) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(username.toLowerCase());
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbList() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
async function idbDelete(username) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(username.toLowerCase());
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

// ── Unified secondary users list ─────────────────────────────────────────
async function renderSecondaryUsers() {
  const sessions = await idbList();
  const el = document.getElementById('secondary-users-list');
  if (!el) return;
  const primaryUser = heardCache?.user?.toLowerCase();
  const visible = sessions
    .filter(s => s.user.toLowerCase() !== primaryUser)
    .sort((a, b) => b.fetched_at - a.fetched_at);

  if (!visible.length) {
    el.innerHTML = '<div class="idb-empty">Sin sesiones guardadas</div>';
    return;
  }
  el.innerHTML = visible.map(s => {
    const eu = extraUsers.find(u => u.user.toLowerCase() === s.user.toLowerCase());
    const isActive = !!eu;
    const _ts = s.last_scrobble_ts || s.fetched_at;
    const dateStr = new Date(_ts * 1000).toLocaleDateString();
    const lastLbl = s.last_scrobble_artist ? ` · ${s.last_scrobble_artist}` : '';
    const incompleteTag = s.complete === false ? ' <span style="color:var(--red);font-size:0.7rem" title="Descarga incompleta — usa ↻ Sync">⚠</span>' : '';
    const avatar = eu?.image
      ? `<img class="eu-avatar" src="${escH(eu.image)}" alt="" style="width:22px;height:22px;border-radius:50%;object-fit:cover;flex-shrink:0">`
      : `<div class="eu-dot" style="width:10px;height:10px;border-radius:50%;flex-shrink:0;background:${eu?.color || 'var(--ink3)'}"></div>`;
    return `<div class="sec-user-row${isActive ? ' active' : ''}">
      <div class="sec-user-left">
        ${avatar}
        <div class="sec-user-info">
          <div class="sec-user-name">${escH(s.user)}</div>
          <div class="sec-user-meta">${s.count.toLocaleString()} álb. · ${dateStr}${escH(lastLbl)}${incompleteTag}</div>
        </div>
      </div>
      <div class="sec-user-btns">
        <button class="btn-sm" data-action="sync" data-user="${escH(s.user)}" title="Sincronizar desde Last.fm">↻ Sync</button>
        <button class="btn-sm${isActive ? ' act' : ''}" data-action="toggle" data-user="${escH(s.user)}">${isActive ? 'ACTIVO' : 'CARGAR'}</button>
        <button class="btn-sm" data-action="download" data-user="${escH(s.user)}" title="Guardar JSON">↓ JSON</button>
        <button class="btn-sm" data-action="set-primary" data-user="${escH(s.user)}" title="Cargar como usuario principal">→ Prin.</button>
        <button class="eu-del" data-action="delete" data-user="${escH(s.user)}" title="Eliminar">✕</button>
      </div>
    </div>`;
  }).join('');
}

async function idbLoadSession(username) {
  const data = await idbLoad(username);
  if (!data) return;
  loadHeardCache(data);
  document.getElementById('um-progress').textContent = `✓ ${data.user} cargado desde BD`;
  closeUserModal();
}

async function idbDeleteSession(username) {
  await idbDelete(username);
  const lc = username.toLowerCase();
  // Evict from active heardCache
  if (heardCache?.user?.toLowerCase() === lc) {
    heardCache = null; loadedUser = null;
    inpUser.value = '';
    hideUserBadge(); hideResults();
  }
  // Evict from extraUsers + localStorage
  const idx = extraUsers.findIndex(u => u.user.toLowerCase() === lc);
  if (idx !== -1) {
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
    buildExtraUsersList();
  }
  renderSecondaryUsers();
}

function idbDownloadSession(username) {
  idbLoad(username).then(data => {
    if (!data) return;
    const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
    const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
    const blob = new Blob([JSON.stringify({ version:1, user: data.user, count: data.count, fetched_at: data.fetched_at, heard: data.heard, yt_ids, covers }, null, 0)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tumtumpa_${data.user}_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ── User badge (header) ────────────────────────────────────────────────────
function showUserBadge(username, img, albumCount, lastTs, lastArtist, lastTrack) {
  if (img) {
    const av = document.getElementById('badge-avatar');
    if (av) { av.src = img; av.style.display = ''; }
    const umAv = document.getElementById('um-avatar');
    if (umAv) { umAv.src = img; umAv.style.display = ''; }
  }
  document.getElementById('badge-name').textContent = username;
  document.getElementById('badge-inline').style.display = 'flex';
  const countStr = typeof albumCount === 'number' ? albumCount.toLocaleString() + ' álb.' : albumCount;
  const dateStr  = lastTs ? new Date(lastTs * 1000).toLocaleDateString() : '';
  const lastStr  = (lastArtist && lastTrack) ? `${lastArtist} — ${lastTrack}` : '';
  const metaStr  = [countStr, dateStr].filter(Boolean).join(' · ');
  const umUser = document.getElementById('um-username');
  const umMeta = document.getElementById('um-usermeta');
  if (umUser) umUser.textContent = username;
  if (umMeta) umMeta.textContent = lastStr ? `${countStr} · ${dateStr} · ${lastStr}` : metaStr;
  const secPrim = document.getElementById('um-sec-primary');
  if (secPrim) secPrim.style.display = '';
  const saveSess = document.getElementById('btn-save-session');
  if (saveSess) saveSess.style.display = '';
  renderSecondaryUsers();
}
function hideUserBadge() {
  document.getElementById('badge-inline').style.display = 'none';
  const secPrim = document.getElementById('um-sec-primary');
  if (secPrim) secPrim.style.display = 'none';
  const saveSess = document.getElementById('btn-save-session');
  if (saveSess) saveSess.style.display = 'none';
  renderSecondaryUsers();
}

// ── Unload primary user ────────────────────────────────────────────────────
function unloadPrimaryUser() {
  heardCache = null; loadedUser = null;
  inpUser.value = '';
  hideUserBadge();
  hideResults();
  renderSecondaryUsers();
}

// ── Toggle secondary user active state (adds/removes from extraUsers) ──────
async function toggleSecondaryUser(username) {
  const idx = extraUsers.findIndex(u => u.user.toLowerCase() === username.toLowerCase());
  if (idx !== -1) {
    // Already active → deactivate
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
    buildExtraUsersList();
    renderSecondaryUsers();
    return;
  }
  // Not active → activate (load from IDB + get image)
  const data = await idbLoad(username);
  if (!data) return;
  const prog = document.getElementById('um-extra-progress');
  const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
  const userInfo = await fetch(`/api/check_user?user=${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>null);
  const image = userInfo?.ok ? (userInfo.image || '') : '';
  extraUsers.push({ user: data.user, pairs: data.heard, songs: data.songs || [], color, count: data.heard.length, fetched_at: data.fetched_at || 0, image });
  saveExtraUsersLS();
  buildExtraUsersList();
  renderSecondaryUsers();
  if (prog) prog.textContent = `✓ ${data.user} cargado`;
}

// ── Sync a secondary user from Last.fm (by username in IDB) ───────────────
async function syncSecondaryIdb(username) {
  const prog = document.getElementById('um-extra-progress');
  if (prog) prog.textContent = `Sincronizando ${username}...`;
  try {
    const existing = await idbLoad(username);
    const euSrc = extraUsers.find(u => u.user.toLowerCase() === username.toLowerCase())?.source
                  || existing?.source || 'lfm';
    // Si la sesión no está marcada como completa, descargar todo desde cero
    if (existing && existing.complete === false) {
      if (prog) prog.textContent = `Sesión incompleta — descargando completo...`;
      const lfmResult = await fetchScrobblesSSE(username, msg => {
        if (prog) prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álb.`;
      }, euSrc);
      const heard = lfmResult.heard;
      const songs = lfmResult.heard_songs || [];
      const newFetched = Math.floor(Date.now()/1000);
      await idbSave({ user: username, count: heard.length, fetched_at: newFetched, heard, songs,
        last_scrobble_ts: lfmResult.last_scrobble_ts || 0,
        last_scrobble_artist: lfmResult.last_scrobble_artist || '',
        last_scrobble_track: lfmResult.last_scrobble_track || '',
        complete: true, total_pages: lfmResult.total_pages || 0, source: euSrc });
      const eu = extraUsers.find(u => u.user.toLowerCase() === username.toLowerCase());
      if (eu) { eu.pairs = heard; eu.songs = songs; eu.count = heard.length; eu.fetched_at = newFetched; saveExtraUsersLS(); }
      renderSecondaryUsers();
      if (prog) prog.textContent = `✓ ${username}: ${heard.length.toLocaleString()} álbumes (descarga completa)`;
      return;
    }
    const since = existing?.fetched_at || 0;
    const url = sinceEndpoint(username, since, euSrc);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    // merge new pairs into existing
    const existSet = new Set((existing?.heard || []).map(p => p[0] + '|' + p[1]));
    const added = (data.new_pairs || []).filter(p => !existSet.has(p[0] + '|' + p[1]));
    const merged = [...(existing?.heard || []), ...added];
    // merge songs
    const existSongSet = new Set((existing?.songs || []).map(s => s[0] + '|' + s[1]));
    const addedSongs = (data.new_songs || []).filter(s => !existSongSet.has(s[0] + '|' + s[1]));
    const mergedSongs = [...(existing?.songs || []), ...addedSongs];
    const newFetched = data.fetched_at || Math.floor(Date.now()/1000);
    await idbSave({ user: username, count: merged.length, fetched_at: newFetched, heard: merged,
      songs: mergedSongs,
      last_scrobble_ts: data.last_scrobble_ts || existing?.last_scrobble_ts || 0,
      last_scrobble_artist: data.last_scrobble_artist || existing?.last_scrobble_artist || '',
      last_scrobble_track: data.last_scrobble_track || existing?.last_scrobble_track || '',
      complete: true, total_pages: existing?.total_pages || 0 });
    // update in-memory if in extraUsers
    const eu = extraUsers.find(u => u.user.toLowerCase() === username.toLowerCase());
    if (eu) {
      eu.pairs = merged; eu.songs = mergedSongs; eu.count = merged.length; eu.fetched_at = newFetched;
      saveExtraUsersLS();
    }
    renderSecondaryUsers();
    if (prog) prog.textContent = `✓ ${username}: +${added.length} nuevos (total ${merged.length.toLocaleString()})`;
  } catch(e) {
    if (prog) prog.textContent = 'Error: ' + e.message;
  }
}

// ── Load secondary user as primary ────────────────────────────────────────
async function setPrimaryFromSecondary(username) {
  const data = await idbLoad(username);
  if (!data) return;
  // Remove from extraUsers if present
  const idx = extraUsers.findIndex(u => u.user.toLowerCase() === username.toLowerCase());
  if (idx !== -1) { extraUsers.splice(idx, 1); saveExtraUsersLS(); }
  loadHeardCache(data);
  document.getElementById('um-progress').textContent = `✓ ${data.user} cargado como principal`;
  buildExtraUsersList();
}

function loadHeardCache(data) {
  heardCache = {
    user:                data.user,
    pairs:               data.heard,
    songs:               data.songs || data.heard_songs || [],
    count:               data.heard.length,
    fetched_at:          data.fetched_at          || 0,
    last_scrobble_ts:    data.last_scrobble_ts    || 0,
    last_scrobble_artist: data.last_scrobble_artist || '',
    last_scrobble_track: data.last_scrobble_track  || '',
    complete:            data.complete !== undefined ? data.complete : true,
    total_pages:         data.total_pages          || 0,
    // Set de artistas normalizados para filtro en modo Descubrir artistas
    artist_set:          data.heard_artists
                           ? new Set(data.heard_artists)
                           : new Set((data.heard || []).map(p => p[0])),
  };
  // song_set: fast lookup for songs mode — key is norm_a + '|' + norm_track
  heardCache.song_set = new Set(heardCache.songs.map(s => s[0] + '|' + s[1]));
  loadedUser    = data.user.toLowerCase();
  inpUser.value = data.user;
  showUserBadge(data.user, '', data.heard.length, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
  idbSave({
    user:                heardCache.user,
    count:               heardCache.count,
    fetched_at:          heardCache.fetched_at,
    heard:               heardCache.pairs,
    songs:               heardCache.songs,
    last_scrobble_ts:    heardCache.last_scrobble_ts,
    last_scrobble_artist: heardCache.last_scrobble_artist,
    last_scrobble_track: heardCache.last_scrobble_track,
    complete:            heardCache.complete,
    total_pages:         heardCache.total_pages,
    heard_artists:       [...heardCache.artist_set],
  }).then(() => { renderIdbList(); renderIdbExtraList(); }).catch(() => {});
  dismissWelcome();
}

// ── Session: guardar JSON ─────────────────────────────────────────────────
document.getElementById('btn-save-session').addEventListener('click', () => {
  if (!heardCache) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
  const blob = new Blob([JSON.stringify({
    version: 1, user: heardCache.user, count: heardCache.count,
    fetched_at: heardCache.fetched_at, heard: heardCache.pairs,
    songs: heardCache.songs || [],
    yt_ids, covers,
  }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${heardCache.user}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Session: importar JSON (routes to primary or secondary) ───────────────
document.getElementById('btn-import').addEventListener('click', () => inpSession.click());
inpSession.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const prog = document.getElementById('um-progress');
  try {
    const data = JSON.parse(await file.text());
    if (!data.heard || !data.user) throw new Error('Formato inválido');
    // Restore enrich and YT caches (merge; existing takes priority as it's more recent)
    if (data.covers && typeof data.covers === 'object') {
      try {
        const existing = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || '{}');
        localStorage.setItem(ENRICH_CACHE_KEY, JSON.stringify({ ...data.covers, ...existing }));
      } catch(_) {}
    }
    if (data.yt_ids && typeof data.yt_ids === 'object') {
      try {
        const existing = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || '{}');
        localStorage.setItem(YT_CACHE_KEY, JSON.stringify({ ...data.yt_ids, ...existing }));
      } catch(_) {}
    }
    const addAsSecondary = !!heardCache && heardCache.user.toLowerCase() !== data.user.toLowerCase();
    if (addAsSecondary) {
      if (extraUsers.some(u => u.user.toLowerCase() === data.user.toLowerCase())) {
        prog.textContent = `${data.user} ya está activo`; e.target.value = ''; return;
      }
      const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
      const ft = data.fetched_at || 0;
      extraUsers.push({ user: data.user, pairs: data.heard, songs: data.songs || [], color, count: data.heard.length, fetched_at: ft, image: '' });
      saveExtraUsersLS();
      await idbSave({ user: data.user, count: data.heard.length, fetched_at: ft, heard: data.heard, songs: data.songs || [] });
      buildExtraUsersList();
      prog.textContent = `✓ ${data.user} importado como secundario — ${data.heard.length.toLocaleString()} álbumes`;
      // Fetch avatar in background
      fetch(`/api/check_user?user=${encodeURIComponent(data.user)}`).then(r=>r.json()).then(info => {
        if (!info?.ok || !info.image) return;
        const eu = extraUsers.find(u => u.user.toLowerCase() === data.user.toLowerCase());
        if (eu) { eu.image = info.image; saveExtraUsersLS(); renderSecondaryUsers(); }
        idbLoad(data.user).then(d => { if (d) idbSave({ ...d, image: info.image }); }).catch(()=>{});
      }).catch(()=>{});
    } else {
      loadHeardCache(data);
      prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
      closeUserModal();
    }
  } catch(err) {
    prog.textContent = 'Error: ' + err.message;
  }
  e.target.value = '';
});

// ── Session: sync incremental ──────────────────────────────────────────────
document.getElementById('btn-sync-session').addEventListener('click', async () => {
  if (!heardCache) return;
  const btn = document.getElementById('btn-sync-session');
  const prog = document.getElementById('um-progress');
  btn.disabled = true;
  btn.textContent = '↻ ...';
  prog.textContent = 'Sincronizando con Last.fm...';
  try {
    const knownCount = heardCache.count || 0;
    const url = `/api/scrobbles/update?user=${encodeURIComponent(heardCache.user)}&known_count=${knownCount}`;
    const data = await fetch(url).then(r => r.json());
    if (data.error) { prog.textContent = 'Error: ' + data.error; return; }
    if (data.new_count === 0) {
      prog.textContent = '✓ Al día'; btn.textContent = '↻ Sync'; return;
    }
    if (data.full_replace) {
      heardCache.pairs = data.heard; heardCache.count = data.heard.length; heardCache.fetched_at = data.fetched_at;
      showUserBadge(heardCache.user, '', heardCache.count, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
      prog.textContent = `✓ Al día`;
    }
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '↻ Sync';
  }
});

// ── Unload primary button ──────────────────────────────────────────────────
document.getElementById('btn-unload-primary').addEventListener('click', unloadPrimaryUser);

// ── Main: Cargar scrobbles ─────────────────────────────────────────────────
btnGo.addEventListener('click', doLoadUser);
inpUser.addEventListener('keydown', e => { if (e.key === 'Enter') doLoadUser(); });

async function doLoadUser() {
  const user = inpUser.value.trim();
  if (!user) return;
  hideError();
  const prog = document.getElementById('um-progress');
  btnGo.disabled = true;

  // If primary already loaded AND this user is not the primary → add as secondary
  const addAsSecondary = !!heardCache && heardCache.user.toLowerCase() !== user.toLowerCase();
  const src = umSource();

  try {
    if (addAsSecondary) {
      // Always do a full fresh download via the search box — never short-circuit
      // from IDB here; the IDB may contain a truncated previous download.
      // Use the "CARGAR" button on the secondary list to load from IDB instead.
      prog.textContent = src === 'lb' ? 'Conectando con ListenBrainz...' : 'Conectando con Last.fm...';
      const [userInfo, lfmResult] = await Promise.all([
        fetch(checkUserEndpoint(user, src)).then(r=>r.json()).catch(()=>null),
        fetchScrobblesSSE(user, msg => {
          prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álb.`;
        }, src),
      ]);
      const heard = lfmResult.heard;
      const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
      const image = userInfo?.ok ? (userInfo.image || '') : '';
      const realUser = userInfo?.ok ? userInfo.username : user;
      const fetched_at = Math.floor(Date.now()/1000);
      // Replace existing extraUsers entry if present, else push new
      const euIdx = extraUsers.findIndex(u => u.user.toLowerCase() === realUser.toLowerCase());
      const eu = { user: realUser, pairs: heard, songs: lfmResult.heard_songs||[], color: euIdx !== -1 ? extraUsers[euIdx].color : color,
        count: heard.length, fetched_at, image, source: src,
        last_scrobble_ts: lfmResult.last_scrobble_ts || 0,
        last_scrobble_artist: lfmResult.last_scrobble_artist || '',
        last_scrobble_track: lfmResult.last_scrobble_track || '' };
      if (euIdx !== -1) extraUsers[euIdx] = eu; else extraUsers.push(eu);
      saveExtraUsersLS();
      await idbSave({ user: realUser, count: heard.length, fetched_at, heard,
        songs: lfmResult.heard_songs || [],
        last_scrobble_ts: lfmResult.last_scrobble_ts || 0,
        last_scrobble_artist: lfmResult.last_scrobble_artist || '',
        last_scrobble_track: lfmResult.last_scrobble_track || '',
        complete: true, total_pages: lfmResult.total_pages || 0,
        heard_artists: lfmResult.heard_artists || [], source: src });
      buildExtraUsersList();
      prog.textContent = `✓ ${realUser} añadido — ${heard.length.toLocaleString()} álbumes`;
      inpUser.value = '';
    } else {
      // Load as primary
      prog.textContent = src === 'lb' ? 'Conectando con ListenBrainz...' : 'Conectando con Last.fm...';
      const result = await fetchScrobblesSSE(user, msg => {
        prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes únicos`;
      }, src);
      loadHeardCache({
        user, heard: result.heard, heard_songs: result.heard_songs || [],
        fetched_at:           Math.floor(Date.now()/1000),
        last_scrobble_ts:     result.last_scrobble_ts    || 0,
        last_scrobble_artist: result.last_scrobble_artist || '',
        last_scrobble_track:  result.last_scrobble_track  || '',
        complete:             true,
        total_pages:          result.total_pages          || 0,
        heard_artists:        result.heard_artists         || [],
      });
      prog.textContent = `✓ ${result.heard.length.toLocaleString()} álbumes cargados`;
      closeUserModal();
    }
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btnGo.disabled = false;
  }
}

// ── Welcome screen ─────────────────────────────────────────────────────────
function dismissWelcome() {
  localStorage.setItem('tt_welcomed', '1');
  document.getElementById('welcome-screen').style.display = 'none';
}

function startFromWelcome() {
  dismissWelcome();
  openUserModal();
}

// ── PWA Service Worker registration ───────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

// ── Init ─────────────────────────────────────────────────────────────────
(async () => {
  loadExtraUsersLS();
  // Purge extra users no longer in IDB
  if (extraUsers.length) {
    try {
      const sessions = await idbList();
      const inIdb = new Set(sessions.map(s => s.user.toLowerCase()));
      const valid = extraUsers.filter(u => inIdb.has(u.user.toLowerCase()));
      if (valid.length !== extraUsers.length) {
        extraUsers.length = 0; valid.forEach(u => extraUsers.push(u));
        saveExtraUsersLS();
      }
    } catch(e) {}
  }
  await renderSecondaryUsers();
  buildExtraUsersList();

  // Show welcome screen if no data at all and never seen before
  const welcomed = localStorage.getItem('tt_welcomed');
  if (!welcomed) {
    const sessions = await idbList().catch(() => []);
    if (!sessions.length && !extraUsers.length) {
      document.getElementById('welcome-screen').style.display = 'block';
    }
  }
})();

// ── Event listeners (replaces all removed inline handlers) ─────────────────

// Static elements (from HTML template)
document.getElementById('btn-start-welcome').addEventListener('click', startFromWelcome);
document.getElementById('btn-open-users').addEventListener('click', openUserModal);
document.querySelector('#user-modal .modal-close').addEventListener('click', closeUserModal);
document.getElementById('about-overlay').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAboutModal();
});
document.querySelector('.about-close').addEventListener('click', closeAboutModal);
document.getElementById('disc-play-btn').addEventListener('click', triggerDiscover);
document.getElementById('disc-prev').addEventListener('click', discoverPrevPage);
document.getElementById('disc-next').addEventListener('click', discoverNextPage);
document.querySelector('.dp-close').addEventListener('click', closeDetailPanel);

// Delegation: disc-user-indicator (user selector pills)
document.getElementById('disc-user-indicator').addEventListener('click', e => {
  const line = e.target.closest('.disc-user-line[data-idx]');
  if (line) setActiveDiscoverUser(parseInt(line.dataset.idx));
});

// Delegation: friends-list (fr-add)
document.getElementById('friends-list').addEventListener('click', e => {
  const btn = e.target.closest('.fr-add[data-username]');
  if (btn && !btn.disabled) addExtraUserByName(btn.dataset.username, btn);
});

// Delegation: sb-cache-notice (export / close)
document.getElementById('sb-cache-notice').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'export') {
    idbExportAll();
  } else if (btn.dataset.action === 'close-notice') {
    const notice = document.getElementById('sb-cache-notice');
    notice.style.display = 'none';
    delete notice.dataset.shown;
  }
});

// Delegation: secondary-users-list (sync / toggle / download / set-primary / delete)
document.getElementById('secondary-users-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action][data-user]');
  if (!btn) return;
  const user = btn.dataset.user;
  switch (btn.dataset.action) {
    case 'sync':        syncSecondaryIdb(user); break;
    case 'toggle':      toggleSecondaryUser(user); break;
    case 'download':    idbDownloadSession(user); break;
    case 'set-primary': setPrimaryFromSecondary(user); break;
    case 'delete':      idbDeleteSession(user); break;
  }
});
