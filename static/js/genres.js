// ── State ──────────────────────────────────────────────────────────────────
// Limpiar caché de proxy de versiones anteriores
try { localStorage.removeItem('coverProxyMbids'); } catch(e) {}

let allAlbums      = [];
let heardCache     = null;     // { user, pairs:[[a,t],...], count, fetched_at }
let collCache      = {};       // slug → albums[]
let activeSlug     = null;
let activeFilter   = 'all';
let activeSort     = 'rank';
let activeGenres   = new Set();
let activeDecades  = new Set();
let loadedUser     = null;

// extra users for cross-reference / recommendation
const USER_COLORS = ['#6a9fb5','#78b56c','#b56c6c','#9b6cb5','#b59b6c','#6cb5b5','#b56ca0','#7ab5a0'];
let extraUsers = [];  // [{user, pairs:[[na,nt,oa,ot,count],...], color, count, fetched_at}]

// collection load cancellation
let _loadController = null;

// cover enrichment SSE (for albums without cover in collection)
let _enrichEs = null;

// album info cache (artist|||title → data)
const albumInfoCache = new Map();


// ── DOM refs ───────────────────────────────────────────────────────────────
const inpUser    = document.getElementById('inp-user');
const btnGo      = document.getElementById('btn-go');
const grid       = document.getElementById('grid');
const loading    = document.getElementById('loading');
const loadTxt    = document.getElementById('loading-text');
const errMsg     = document.getElementById('error-msg');
const statsBar   = document.getElementById('stats-bar');
const filtersEl  = document.getElementById('filters');
const emptyEl    = document.getElementById('empty');
const inpSession = document.getElementById('inp-session');

// ── Sidebar panel toggle ───────────────────────────────────────────────────
function togglePanel(id) {
  document.getElementById(id).classList.toggle('open');
}

// ── Mobile sidebar ─────────────────────────────────────────────────────────
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const isOpen = sb.classList.toggle('mobile-open');
  ov.classList.toggle('visible', isOpen);
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}

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
  renderIdbList();
  buildExtraUsersList();
  renderIdbExtraList();
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
    extraUsers.map(u => ({ user: u.user, pairs: u.pairs, color: u.color, count: u.count, fetched_at: u.fetched_at, image: u.image || '' }))
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
  const list = document.getElementById('extra-users-list');
  if (!extraUsers.length) { list.innerHTML = ''; }
  else {
    list.innerHTML = extraUsers.map((u, i) => {
      const avatar = u.image
        ? `<img class="eu-avatar" src="${escH(u.image)}" alt="">`
        : `<div class="eu-dot" style="background:${u.color}"></div>`;
      return `<div class="eu-row">
        ${avatar}
        <span class="eu-name">${escH(u.user)}</span>
        <span class="eu-meta">${u.count.toLocaleString()} álb.</span>
        <button class="btn-sm" data-action="sync" data-idx="${i}" title="Sincronizar">↻</button>
        <button class="btn-sm" data-action="save-json" data-idx="${i}" title="Guardar JSON">↓ JSON</button>
        <button class="eu-del" data-action="remove" data-idx="${i}" title="Eliminar">✕</button>
      </div>`;
    }).join('');
  }

  const hasExtra = extraUsers.length > 0;

  // ── Per-user filter buttons in the filters bar ───────────────────────────
  const extraFiltersEl = document.getElementById('filter-extra-users');
  if (hasExtra) {
    extraFiltersEl.innerHTML = extraUsers.map((u, i) => {
      const av = u.image
        ? `<img src="${escH(u.image)}" alt="">`
        : `<span class="fbu-dot" style="background:${u.color}"></span>`;
      return `<button class="filter-btn filter-btn-user" data-filter="extra_${i}">
        ${av}${escH(u.user)}
      </button>`;
    }).join('');
  } else {
    extraFiltersEl.innerHTML = '';
    if (activeFilter.startsWith('extra_')) { activeFilter = 'all'; renderGrid(); }
  }

}

function setExtraFilter(i) {
  document.querySelectorAll('#filters .filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`#filters .filter-btn[data-filter="extra_${i}"]`)?.classList.add('active');
  activeFilter = `extra_${i}`;
  renderGrid();
}


document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeFilter = btn.dataset.filter;
    renderGrid();
  });
});
document.getElementById('sort-select').addEventListener('change', e => {
  activeSort = e.target.value; renderGrid();
});

// ── Modal ──────────────────────────────────────────────────────────────────
// ── Detail side panel ──────────────────────────────────────────────────────
function openDetailPanel(ref) {
  // ref: {type:'collection', idx}
  let title, artist, year, cover, mbid, yt_id, heard, extraHeard, descCached;
  const a = allAlbums[ref.idx];
  if (!a) return;
  title = a.title; artist = a.artist; year = a.year; cover = a.cover;
  mbid = a.mbid; yt_id = a.yt_id; heard = a.heard; extraHeard = a.extraHeard;
  descCached = a.desc_lfm_album || a.desc_mb_album || a.desc_lfm_artist || '';

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

  // Status
  const st = document.getElementById('dp-status');
  if (heard) {
    st.className = 'dp-status heard';
    st.innerHTML = `<svg width="10" height="10" viewBox="0 0 12 9" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4l3.5 3.5L11 1"/></svg> Escuchado`;
  } else {
    st.className = 'dp-status missing';
    st.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg> Pendiente`;
  }
  st.style.display = '';

  // Extra users status
  const extraSt = document.getElementById('dp-extra-status');
  if (extraUsers.length && extraHeard) {
    extraSt.innerHTML = extraUsers.map((u, i) => {
      const h = extraHeard[i];
      const icon = u.image
        ? `<img src="${escH(u.image)}" style="width:14px;height:14px;border-radius:50%;object-fit:cover;opacity:${h?1:.3}">`
        : `<span style="width:8px;height:8px;border-radius:50%;background:${u.color};display:inline-block;opacity:${h?1:.25}"></span>`;
      return `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${h?u.color:'var(--ink3)'}">
        ${icon} ${escH(u.user)}: ${h ? '✓' : '—'}</span>`;
    }).join('');
    extraSt.style.display = 'flex';
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
  if (yt_id) {
    links.push(`<a class="dp-link" href="https://youtube.com/watch?v=${escH(yt_id)}" target="_blank">YouTube ↗</a>`);
  } else if (artist && title) {
    const ytQ = encodeURIComponent(`${artist} ${title}`);
    links.push(`<a class="dp-link" href="https://www.youtube.com/results?search_query=${ytQ}" target="_blank">Buscar YouTube ↗</a>`);
  }
  document.getElementById('dp-links').innerHTML = links.join('');

  // Open
  document.getElementById('detail-overlay').classList.add('open');
  panel.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Fetch LFM + MB info asynchronously
  fetchAlbumInfo((artist || '').replace(/[\n\r]/g, ' '), (title || '').replace(/[\n\r]/g, ' '), mbid || '');
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

  // Better cover from MBID lookup
  if (data.cover_url && coverMissing) {
    dpCover.src = data.cover_url; dpCover.style.display = '';
  }

  // Fall back to Last.fm artist image when there is no album cover
  if (data.artist?.image && (coverMissing || (!data.cover_url && dpCover.style.display === 'none'))) {
    dpCover.src = data.artist.image; dpCover.style.display = '';
  }

  // Stats
  if (data.lfm?.listeners || data.lfm?.playcount) {
    const s = document.getElementById('dp-stats');
    s.innerHTML = `<span><b>${parseInt(data.lfm.listeners||0).toLocaleString()}</b> oyentes</span>`
                + `<span><b>${parseInt(data.lfm.playcount||0).toLocaleString()}</b> plays globales</span>`;
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
  if (data.mbid) {
    const existing = document.getElementById('dp-links').innerHTML;
    if (!existing.includes('musicbrainz')) {
      document.getElementById('dp-links').innerHTML =
        `<a class="dp-link" href="https://musicbrainz.org/release-group/${data.mbid}" target="_blank">MusicBrainz</a>`
        + existing;
    }
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

// ── UI helpers ─────────────────────────────────────────────────────────────
function showLoading(msg) { loadTxt.textContent = msg || 'Cargando...'; loading.classList.add('visible'); }
function hideLoading()    { loading.classList.remove('visible'); }
function showError(msg)   { errMsg.textContent = msg; errMsg.classList.add('visible'); }
function hideError()      { errMsg.classList.remove('visible'); }
function hideResults()    {
  allAlbums = []; grid.innerHTML = '';
  statsBar.classList.remove('visible');
  filtersEl.classList.remove('visible');
  emptyEl.classList.remove('visible');
  activeGenres.clear(); activeDecades.clear();
}
function escH(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Collapsible secondary users section ──────────────────────────────────
function toggleUmExtra() {
  document.getElementById('um-sec-extra').classList.toggle('collapsed');
}

async function renderIdbExtraList() {
  const sessions = await idbList();
  const listEl   = document.getElementById('idb-extra-list');
  const sepEl    = document.getElementById('idb-extra-sep');
  if (!listEl) return;
  const primaryUser = heardCache?.user?.toLowerCase();
  const visible = sessions.filter(s => s.user !== primaryUser);
  if (!visible.length) { listEl.innerHTML = ''; if (sepEl) sepEl.style.display = 'none'; return; }
  if (sepEl) sepEl.style.display = '';
  listEl.innerHTML = visible
    .sort((a, b) => b.fetched_at - a.fetched_at)
    .map(s => {
      const already = extraUsers.some(u => u.user.toLowerCase() === s.user.toLowerCase());
      const _ts  = s.last_scrobble_ts || s.fetched_at;
      const _lbl = s.last_scrobble_artist ? ` · ${escH(s.last_scrobble_artist)} — ${escH(s.last_scrobble_track||'')}` : '';
      return `<div class="idb-entry">
        <div class="idb-entry-info">
          <div class="idb-entry-user">${escH(s.user)}</div>
          <div class="idb-entry-meta">${(s.count||s.heard?.length||0).toLocaleString()} álb. · ${new Date(_ts*1000).toLocaleDateString()}${_lbl}</div>
        </div>
        ${already
          ? `<span style="font-family:var(--mono);font-size:0.65rem;color:var(--ink3)">añadido</span>`
          : `<button class="btn-sm primary" data-action="add-extra" data-user="${escH(s.user)}">Añadir</button>`}
      </div>`;
    }).join('');
}

async function idbAddAsExtra(username) {
  const data = await idbLoad(username);
  if (!data) return;
  if (extraUsers.some(u => u.user.toLowerCase() === username.toLowerCase())) return;
  const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
  const userInfo = await fetch(`/api/check_user?user=${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>null);
  const image = userInfo?.ok ? (userInfo.image || '') : '';
  const pairs = (data.pairs || data.heard || []).map(p => [p[0],p[1],p[2]||'',p[3]||'',p[4]||1]);
  extraUsers.push({ user: data.user, pairs, color, count: pairs.length, fetched_at: data.fetched_at || 0, image });
  saveExtraUsersLS();
  buildExtraUsersList();
  renderIdbExtraList();
  document.getElementById('um-extra-progress').textContent = `✓ ${data.user} añadido`;
  if (allAlbums.length) applyCollection();
}

// ── IndexedDB ─────────────────────────────────────────────────────────────
const IDB_NAME  = 'mustlisten';
const IDB_STORE = 'sessions';

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
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ ...data, user: data.user.toLowerCase() });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
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

// ── IndexedDB list (inside user modal) ───────────────────────────────────
async function renderIdbList() {
  const sessions = await idbList();
  const listEl   = document.getElementById('idb-list');
  if (!sessions.length) {
    listEl.innerHTML = '<span class="idb-empty">Sin sesiones guardadas</span>';
    return;
  }
  listEl.innerHTML = sessions
    .sort((a, b) => b.fetched_at - a.fetched_at)
    .map(s => {
      const _ts  = s.last_scrobble_ts || s.fetched_at;
      const _lbl = s.last_scrobble_artist ? ` · ${s.last_scrobble_artist} — ${s.last_scrobble_track||''}` : '';
      return `
      <div class="idb-entry">
        <div class="idb-entry-info">
          <div class="idb-entry-user">${escH(s.user)}</div>
          <div class="idb-entry-meta">${(s.count||s.heard?.length||0).toLocaleString()} álb. · ${new Date(_ts*1000).toLocaleDateString()}${escH(_lbl)}</div>
        </div>
        <button class="btn-sm primary" data-action="load" data-user="${escH(s.user)}">Cargar</button>
        <button class="btn-sm" data-action="download" data-user="${escH(s.user)}">↓ JSON</button>
        <button class="btn-sm" data-action="delete" data-user="${escH(s.user)}">✕</button>
      </div>`;
    }).join('');
}

async function idbLoadSession(username) {
  const data = await idbLoad(username);
  if (!data) return;
  loadHeardCache(data);
  document.getElementById('um-progress').textContent = `✓ ${data.user} cargado desde BD`;
  if (activeSlug) { closeUserModal(); await loadAndRender(activeSlug); }
  else closeUserModal();
}

async function idbDeleteSession(username) {
  await idbDelete(username);
  const lc = username.toLowerCase();
  // Evict from active heardCache
  if (heardCache?.user?.toLowerCase() === lc) {
    heardCache = null;
    loadedUser = null;
    inpUser.value = '';
    hideUserBadge();
    hideResults();
  }
  // Evict from extraUsers + localStorage
  const idx = extraUsers.findIndex(u => u.user.toLowerCase() === lc);
  if (idx !== -1) {
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
    buildExtraUsersList();
    if (allAlbums.length) applyCollection();
  }
  await renderIdbList();
  await renderIdbExtraList();
}

function idbDownloadSession(username) {
  idbLoad(username).then(data => {
    if (!data) return;
    const blob = new Blob([JSON.stringify({ version:1, user: data.user, count: data.count, fetched_at: data.fetched_at, heard: data.heard }, null, 0)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mustlisten_${data.user}_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function saveExtraUserJSON(idx) {
  const u = extraUsers[idx];
  if (!u) return;
  const blob = new Blob([JSON.stringify({ version:1, user: u.user, count: u.count, fetched_at: u.fetched_at, heard: u.pairs }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mustlisten_${u.user}_${new Date().toISOString().slice(0,10)}.json`;
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
  prog.textContent = 'Conectando con Last.fm...';
  try {
    const [userInfo, lfmResult] = await Promise.all([
      fetch(`/api/check_user?user=${encodeURIComponent(user)}`).then(r=>r.json()).catch(()=>null),
      fetchScrobblesSSE(user, msg => {
        prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      }),
    ]);
    const heard     = lfmResult.heard;
    const color     = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const image     = userInfo?.ok ? (userInfo.image || '') : '';
    const realUser  = userInfo?.ok ? userInfo.username : user;
    const fetched_at = Math.floor(Date.now()/1000);
    const last_scrobble_ts     = lfmResult.last_scrobble_ts    || 0;
    const last_scrobble_artist = lfmResult.last_scrobble_artist || '';
    const last_scrobble_track  = lfmResult.last_scrobble_track  || '';
    extraUsers.push({ user: realUser, pairs: heard, color, count: heard.length, fetched_at, image, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    saveExtraUsersLS();
    await idbSave({ user: realUser, count: heard.length, fetched_at, heard, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    await renderIdbExtraList();
    buildExtraUsersList();
    inp.value = '';
    prog.textContent = `✓ ${realUser} cargado — ${heard.length.toLocaleString()} álbumes`;
    if (allAlbums.length) applyCollection();
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
    const url = `/api/scrobbles/since?user=${encodeURIComponent(u.user)}&since=${u.fetched_at || 0}`;
    const r = await fetch(url);
    if (!r.ok) { const t = await r.text(); throw new Error(`Error ${r.status}: ${t.slice(0, 120)}`); }
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    const existing = new Set(u.pairs.map(p => p[0] + '|' + p[1]));
    const added = data.new_pairs.filter(p => !existing.has(p[0] + '|' + p[1]));
    extraUsers[idx].pairs      = [...u.pairs, ...added];
    extraUsers[idx].count      = extraUsers[idx].pairs.length;
    extraUsers[idx].fetched_at = data.fetched_at;
    if (data.last_scrobble_ts && data.last_scrobble_ts > (extraUsers[idx].last_scrobble_ts || 0)) {
      extraUsers[idx].last_scrobble_ts     = data.last_scrobble_ts;
      extraUsers[idx].last_scrobble_artist = data.last_scrobble_artist || '';
      extraUsers[idx].last_scrobble_track  = data.last_scrobble_track  || '';
    }
    saveExtraUsersLS();
    await idbSave({ user: extraUsers[idx].user, count: extraUsers[idx].count, fetched_at: extraUsers[idx].fetched_at, heard: extraUsers[idx].pairs, last_scrobble_ts: extraUsers[idx].last_scrobble_ts || 0, last_scrobble_artist: extraUsers[idx].last_scrobble_artist || '', last_scrobble_track: extraUsers[idx].last_scrobble_track || '' });
    await renderIdbExtraList();
    buildExtraUsersList();
    prog.textContent = `✓ ${u.user}: +${added.length} nuevos (total ${extraUsers[idx].count.toLocaleString()})`;
    if (allAlbums.length) applyCollection();
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  }
}

document.getElementById('btn-extra-lfm').addEventListener('click', addExtraUser);
document.getElementById('inp-extra-user').addEventListener('keydown', e => { if (e.key === 'Enter') addExtraUser(); });

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
  try {
    const [userInfo, lfmResult] = await Promise.all([
      fetch(`/api/check_user?user=${encodeURIComponent(username)}`).then(r=>r.json()).catch(()=>null),
      fetchScrobblesSSE(username, msg => {
        prog.textContent = `${username}: página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      }),
    ]);
    const heard      = lfmResult.heard;
    const color      = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const image      = userInfo?.ok ? (userInfo.image || '') : '';
    const realUser   = userInfo?.ok ? userInfo.username : username;
    const fetched_at = Math.floor(Date.now()/1000);
    const last_scrobble_ts     = lfmResult.last_scrobble_ts    || 0;
    const last_scrobble_artist = lfmResult.last_scrobble_artist || '';
    const last_scrobble_track  = lfmResult.last_scrobble_track  || '';
    extraUsers.push({ user: realUser, pairs: heard, color, count: heard.length, fetched_at, image, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    saveExtraUsersLS();
    await idbSave({ user: realUser, count: heard.length, fetched_at, heard, last_scrobble_ts, last_scrobble_artist, last_scrobble_track });
    await renderIdbExtraList();
    buildExtraUsersList();
    btn.textContent = '✓';
    prog.textContent = `✓ ${realUser} cargado — ${heard.length.toLocaleString()} álbumes`;
    const frList = document.getElementById('friends-list');
    if (frList?.children.length) {
      frList.querySelectorAll('.fr-add').forEach(b => {
        const row = b.closest('.fr-row');
        const name = row?.querySelector('.fr-name')?.textContent?.trim() || '';
        if (extraUsers.some(eu => eu.user.toLowerCase() === name.toLowerCase())) {
          b.disabled = true; b.textContent = '✓';
        }
      });
    }
    if (allAlbums.length) applyCollection();
  } catch(e) {
    btn.disabled = false;
    btn.textContent = 'Añadir';
    prog.textContent = 'Error: ' + e.message;
  }
}

document.getElementById('btn-extra-json').addEventListener('click', () => {
  document.getElementById('inp-extra-json').click();
});
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
    extraUsers.push({ user: data.user, pairs: data.heard, color, count: data.heard.length, fetched_at: ft, image: '' });
    saveExtraUsersLS();
    await idbSave({ user: data.user, count: data.heard.length, fetched_at: ft, heard: data.heard });
    await renderIdbExtraList();
    buildExtraUsersList();
    prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
    if (allAlbums.length) applyCollection();
  } catch(err) {
    prog.textContent = 'Error: ' + err.message;
  }
  e.target.value = '';
});

function removeExtraUser(idx) {
  extraUsers.splice(idx, 1);
  saveExtraUsersLS();
  buildExtraUsersList();
  renderIdbExtraList();
  if (allAlbums.length) applyCollection();
}

// ── Helper: consume /api/scrobbles SSE stream ─────────────────────────────
async function fetchScrobblesSSE(user, onProgress) {
  const response = await fetch(`/api/scrobbles?user=${encodeURIComponent(user)}`);
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
      else onProgress(msg);
    }
  }
  if (!result) throw new Error('No se recibió respuesta del servidor');
  return result;
}

// ── Init: load collections into sidebar ───────────────────────────────────
(async () => {
  loadExtraUsersLS();
  if (extraUsers.length) {
    try {
      const sessions = await idbList();
      const inIdb = new Set(sessions.map(s => s.user.toLowerCase()));
      const valid = extraUsers.filter(u => inIdb.has(u.user.toLowerCase()));
      if (valid.length !== extraUsers.length) {
        extraUsers.length = 0;
        valid.forEach(u => extraUsers.push(u));
        saveExtraUsersLS();
      }
    } catch(e) {}
  }
  try {
    const [cols, tree] = await Promise.all([
      fetch('/api/collections').then(r => r.json()),
      fetch('/api/genre_tree').then(r => r.json()).catch(() => null),
    ]);
    renderCollsSidebar(cols, tree);
  } catch(e) {
    document.getElementById('colls-body').innerHTML = '<div class="sb-empty">Error cargando</div>';
  }
  await renderIdbList();
  await renderIdbExtraList();
  buildExtraUsersList();
})();

function renderCollsSidebar(cols, tree) {
  // Build lookup: json_slug → collection object (for album counts and DB slug)
  const byJsonSlug = {};
  for (const c of cols) {
    const js = c.slug.replace('rym_chart_all_time_', '').replace(/_/g, '-');
    byJsonSlug[js] = c;
  }
  const html = tree && tree.length
    ? renderJsonTree(tree, byJsonSlug, 1, '')
    : buildRymTreeFallback(cols);
  document.getElementById('colls-body').innerHTML = html;
}

function renderJsonTree(nodes, byJsonSlug, depth, pathPrefix) {
  let html = '';
  const indent = (0.5 + depth * 0.65) + 'rem';
  const fontSize = Math.max(0.68, 0.74 - (depth - 1) * 0.02) + 'rem';
  for (const node of nodes) {
    const hasKids = node.c && node.c.length > 0;
    const coll  = byJsonSlug[node.s];
    const slug  = coll ? coll.slug : '';
    const nid   = 'tree-' + (pathPrefix + node.s).replace(/[^a-z0-9]/gi, '_');
    html += `<div class="tree-genre" id="${nid}">
      <div class="tree-genre-hdr" style="padding-left:${indent}" data-nid="${nid}" data-slug="${escH(slug)}" data-has-kids="${hasKids ? '1' : ''}">
        <span class="tree-genre-name" style="font-size:${fontSize}">${escH(node.n)}</span>
        ${coll && coll.total_albums ? `<span class="sb-coll-count">${coll.total_albums}</span>` : ''}
        ${hasKids ? `<span class="tree-genre-arrow">▶</span>` : ''}
      </div>
      ${hasKids ? `<div class="tree-sub">${renderJsonTree(node.c, byJsonSlug, depth + 1, pathPrefix + node.s + '_')}</div>` : ''}
    </div>`;
  }
  return html;
}

function buildRymTreeFallback(cols) {
  // Fallback: build 2-level tree from collection tree_path when JSON tree unavailable
  const root = { self: null, children: new Map() };
  for (const c of cols) {
    const tp = c.tree_path;
    if (!tp || tp.length === 0) continue;
    let node = root;
    for (const seg of tp) {
      if (!node.children.has(seg)) node.children.set(seg, { self: null, children: new Map() });
      node = node.children.get(seg);
    }
    node.self = c;
  }
  let html = '';
  for (const [name, node] of [...root.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hasKids = node.children.size > 0;
    const slug = node.self ? node.self.slug : '';
    const nid = 'tree-' + name.replace(/[^a-z0-9]/gi, '_');
    html += `<div class="tree-genre" id="${nid}">
      <div class="tree-genre-hdr" style="padding-left:1.15rem" data-nid="${nid}" data-slug="${escH(slug)}" data-has-kids="${hasKids ? '1' : ''}">
        <span class="tree-genre-name">${escH(name)}</span>
        ${node.self && node.self.total_albums ? `<span class="sb-coll-count">${node.self.total_albums}</span>` : ''}
        ${hasKids ? `<span class="tree-genre-arrow">▶</span>` : ''}
      </div>
      ${hasKids ? `<div class="tree-sub">${[...node.children.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([n,c]) => `<div class="tree-sub-item" data-slug="${escH(c.self?.slug||'')}">${escH(n)}${c.self?.total_albums?`<span class="sb-coll-count" style="margin-left:auto">${c.self.total_albums}</span>`:''}</div>`).join('')}</div>` : ''}
    </div>`;
  }
  return html;
}

function toggleGrp(id) {
  document.getElementById(id).classList.toggle('open');
}

function toggleTree(id) {
  document.getElementById(id).classList.toggle('open');
}

async function selectCollection(slug) {
  activeSlug = slug;
  document.querySelectorAll('.sb-coll-item, .tree-genre-hdr, .tree-sub-item').forEach(el => {
    el.classList.toggle('active', el.dataset.slug === slug);
  });
  activeGenres.clear();
  activeDecades.clear();
  closeSidebar();
  await loadAndRender(slug);
}

// ── User badge (header) ────────────────────────────────────────────────────
function showUserBadge(username, img, albumCount, lastTs, lastArtist, lastTrack) {
  const setAvatar = (el, src) => { el.src = src || ''; el.style.display = src ? '' : 'none'; };
  setAvatar(document.getElementById('badge-avatar'), img);
  setAvatar(document.getElementById('um-avatar'),    img);
  const countStr = typeof albumCount === 'number' ? albumCount.toLocaleString() + ' álb.' : albumCount;
  const dateStr  = lastTs ? new Date(lastTs * 1000).toLocaleDateString() : '';
  const lastStr  = (lastArtist && lastTrack) ? `${lastArtist} — ${lastTrack}` : '';
  const metaStr  = [countStr, dateStr].filter(Boolean).join(' · ');
  document.getElementById('badge-name').textContent  = username;
  document.getElementById('badge-plays').textContent = metaStr;
  document.getElementById('badge-inline').style.display = 'flex';
  const btnU = document.getElementById('btn-usuario');
  btnU.textContent = username;
  btnU.classList.add('loaded');
  document.getElementById('um-username').textContent = username;
  document.getElementById('um-usermeta').textContent = lastStr
    ? `${countStr} · ${dateStr}${lastStr ? ' · ' + lastStr : ''}`
    : metaStr;
  document.getElementById('um-current-user').classList.add('visible');
  document.getElementById('btn-save-session').style.display  = '';
  document.getElementById('btn-sync-session').textContent    = '↻ Sync';
}
function hideUserBadge() {
  document.getElementById('badge-inline').style.display = 'none';
  const btnU = document.getElementById('btn-usuario');
  btnU.textContent = 'USUARIO'; btnU.classList.remove('loaded');
  document.getElementById('um-current-user').classList.remove('visible');
  document.getElementById('btn-save-session').style.display = 'none';
}

// ── Session: guardar JSON ─────────────────────────────────────────────────
document.getElementById('btn-save-session').addEventListener('click', () => {
  if (!heardCache) return;
  const blob = new Blob([JSON.stringify({
    version: 1, user: heardCache.user, count: heardCache.count,
    fetched_at: heardCache.fetched_at, heard: heardCache.pairs,
  }, null, 0)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mustlisten_${heardCache.user}_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Session: importar JSON ────────────────────────────────────────────────
document.getElementById('btn-import').addEventListener('click', () => inpSession.click());
inpSession.addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const prog = document.getElementById('um-progress');
  try {
    const data = JSON.parse(await file.text());
    if (!data.heard || !data.user) throw new Error('Formato inválido');
    loadHeardCache(data);
    prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
    if (activeSlug) { closeUserModal(); await loadAndRender(activeSlug); }
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
      const prev = heardCache.count;
      heardCache.pairs = data.heard; heardCache.count = data.heard.length; heardCache.fetched_at = data.fetched_at;
      const added = heardCache.count - prev;
      showUserBadge(heardCache.user, '', heardCache.count, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
      if (activeSlug && collCache[activeSlug]) applyCollection();
      prog.textContent = added > 0 ? `✓ +${added} álbumes nuevos` : '✓ Al día';
    }
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btn.disabled = false; btn.textContent = '↻ Sync';
  }
});

function loadHeardCache(data) {
  heardCache = {
    user:                data.user,
    pairs:               data.heard,
    count:               data.heard.length,
    fetched_at:          data.fetched_at          || 0,
    last_scrobble_ts:    data.last_scrobble_ts    || 0,
    last_scrobble_artist: data.last_scrobble_artist || '',
    last_scrobble_track: data.last_scrobble_track  || '',
  };
  loadedUser    = data.user.toLowerCase();
  inpUser.value = data.user;
  showUserBadge(data.user, '', data.heard.length, heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
  idbSave({
    user:                heardCache.user,
    count:               heardCache.count,
    fetched_at:          heardCache.fetched_at,
    heard:               heardCache.pairs,
    last_scrobble_ts:    heardCache.last_scrobble_ts,
    last_scrobble_artist: heardCache.last_scrobble_artist,
    last_scrobble_track: heardCache.last_scrobble_track,
  }).then(() => { renderIdbList(); renderIdbExtraList(); }).catch(() => {});
}

// ── Fuzzy match ────────────────────────────────────────────────────────────
function norm(s) { return (s || '').toLowerCase().replace(/[^\w]/g, ''); }

function checkHeard(pairs, artist, title) {
  const aN = norm(artist), tN = norm(title);
  if (!tN) return false;
  for (const [uA, uT] of pairs) {
    if (!uT) continue;
    const tm = (tN === uT) || tN.includes(uT) || (uT.includes(tN) && uT.length >= tN.length * 0.8);
    if (!tm) continue;
    if (!aN || aN.includes(uA) || uA.includes(aN)) return true;
  }
  return false;
}

// ── Main: Cargar scrobbles ─────────────────────────────────────────────────
btnGo.addEventListener('click', doLoadUser);
inpUser.addEventListener('keydown', e => { if (e.key === 'Enter') doLoadUser(); });

async function doLoadUser() {
  const user = inpUser.value.trim();
  if (!user) return;
  hideError();
  const prog = document.getElementById('um-progress');
  btnGo.disabled = true;
  try {
    prog.textContent = 'Conectando con Last.fm...';
    hideResults();
    const result = await fetchScrobblesSSE(user, msg => {
      prog.textContent = `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes únicos`;
    });
    loadHeardCache({
      user, heard: result.heard,
      fetched_at:          Math.floor(Date.now()/1000),
      last_scrobble_ts:    result.last_scrobble_ts    || 0,
      last_scrobble_artist: result.last_scrobble_artist || '',
      last_scrobble_track: result.last_scrobble_track  || '',
    });
    prog.textContent = `✓ ${result.heard.length.toLocaleString()} álbumes cargados`;
    if (activeSlug) { closeUserModal(); await loadAndRender(activeSlug); }
    else closeUserModal();
  } catch(e) {
    prog.textContent = 'Error: ' + e.message;
  } finally {
    btnGo.disabled = false;
  }
}

// ── Cover enrichment ──────────────────────────────────────────────────────
function enrichMissingCovers() {
  if (_enrichEs) { _enrichEs.close(); _enrichEs = null; }
  const toEnrich = [];
  for (let i = 0; i < allAlbums.length && toEnrich.length < 50; i++) {
    // Skip albums already tried (no cover found) to avoid infinite retries
    if (!allAlbums[i].cover && !allAlbums[i]._enrichTried)
      toEnrich.push({ idx: i, artist: allAlbums[i].artist, title: allAlbums[i].title });
  }
  if (!toEnrich.length) return;
  const albumsParam = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(toEnrich.map(a => [a.artist, a.title]))))));
  _enrichEs = new EventSource(`/api/enrich_albums?albums=${albumsParam}`);
  _enrichEs.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.done) { _enrichEs.close(); _enrichEs = null; enrichMissingCovers(); return; }
    if (typeof msg.i !== 'number') return;
    const albumIdx = toEnrich[msg.i].idx;
    // Mark as tried regardless of result so we don't retry albums with no cover anywhere
    allAlbums[albumIdx]._enrichTried = true;
    if (!msg.cover_url) return;
    allAlbums[albumIdx].cover = msg.cover_url;
    if (msg.mbid) allAlbums[albumIdx].mbid = msg.mbid;
    if (activeSlug && collCache[activeSlug]?.[albumIdx]) {
      collCache[activeSlug][albumIdx].cover = msg.cover_url;
      if (msg.mbid) collCache[activeSlug][albumIdx].mbid = msg.mbid;
    }
    const card = document.querySelector(`.card[data-idx="${albumIdx}"]`);
    if (!card) return;
    const ph = card.querySelector('.card-placeholder');
    let img = card.querySelector('.card-cover');
    if (img) {
      img.src = msg.cover_url; img.style.display = '';
      if (ph) ph.style.display = 'none';
    } else if (ph) {
      img = document.createElement('img');
      img.className = 'card-cover'; img.src = msg.cover_url;
      img.loading = 'lazy'; img.alt = '';
      img.onerror = function() { this.style.display='none'; if(ph) ph.style.display='flex'; };
      card.insertBefore(img, ph); ph.style.display = 'none';
    }
  };
  _enrichEs.onerror = () => { if (_enrichEs) { _enrichEs.close(); _enrichEs = null; } };
}

async function loadAndRender(slug) {
  if (_enrichEs) { _enrichEs.close(); _enrichEs = null; }
  if (_loadController) _loadController.abort();
  _loadController = new AbortController();
  const signal = _loadController.signal;
  grid.innerHTML = '';
  hideError();
  showLoading('Cargando colección...');
  try {
    if (!collCache[slug]) {
      const r = await fetch(`/api/collection?slug=${encodeURIComponent(slug)}`, { signal });
      const cData = await r.json();
      if (cData.error) throw new Error(cData.error);
      collCache[slug] = cData.albums;
    }
    if (!signal.aborted) {
      applyCollection(slug);
      hideLoading();
    }
  } catch(e) {
    if (e.name === 'AbortError') return;
    hideLoading();
    showError('Error: ' + e.message);
  }
}

function applyCollection(slug) {
  slug = slug || activeSlug;
  const raw = collCache[slug];
  if (!raw) return;

  allAlbums = raw.map(a => ({
    ...a,
    heard:      heardCache ? checkHeard(heardCache.pairs, a.artist, a.title) : false,
    extraHeard: extraUsers.map(u => checkHeard(u.pairs, a.artist, a.title)),
  }));

  const heardN   = allAlbums.filter(a => a.heard).length;
  const missingN = allAlbums.length - heardN;
  const pct      = allAlbums.length ? Math.round(heardN / allAlbums.length * 100) : 0;

  document.getElementById('s-total').textContent   = allAlbums.length;
  document.getElementById('s-heard').textContent   = heardN;
  document.getElementById('s-missing').textContent = missingN;
  document.getElementById('s-pct').textContent     = pct + '%';
  setTimeout(() => { document.getElementById('prog-fill').style.width = pct + '%'; }, 50);

  statsBar.classList.add('visible');
  filtersEl.classList.add('visible');
  buildExtraUsersList();

  buildGenrePills();
  buildDecadePills();
  renderGrid();
  enrichMissingCovers();
}

// ── Genre pills ────────────────────────────────────────────────────────────
function buildGenrePills() {
  const freq = {};
  for (const a of allAlbums)
    for (const g of (a.genres || []))
      freq[g.name] = (freq[g.name] || 0) + 1;
  const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,20).map(e=>e[0]);
  if (!top.length) {
    document.getElementById('genre-pills').innerHTML = '<div class="sb-empty">Sin géneros</div>';
    return;
  }
  document.getElementById('genre-pills').innerHTML = top.map(g =>
    `<span class="pill${activeGenres.has(g)?' active':''}" data-genre="${escH(g)}">${escH(g)}</span>`
  ).join('');
}

function toggleGenre(g) {
  if (activeGenres.has(g)) activeGenres.delete(g);
  else activeGenres.add(g);
  buildGenrePills();
  renderGrid();
}

// ── Decade pills ───────────────────────────────────────────────────────────
function buildDecadePills() {
  const decades = new Set();
  for (const a of allAlbums)
    if (a.year) decades.add(Math.floor(a.year / 10) * 10);
  const sorted = [...decades].sort();
  if (!sorted.length) {
    document.getElementById('decade-pills').innerHTML = '<div class="sb-empty">Sin fechas</div>';
    return;
  }
  document.getElementById('decade-pills').innerHTML = sorted.map(d =>
    `<span class="pill${activeDecades.has(d)?' active':''}" data-decade="${d}">${d}s</span>`
  ).join('');
}

function toggleDecade(d) {
  if (activeDecades.has(d)) activeDecades.delete(d);
  else activeDecades.add(d);
  buildDecadePills();
  renderGrid();
}

// ── Grid ───────────────────────────────────────────────────────────────────
function renderGrid() {
  let f = [...allAlbums];
  if (activeFilter === 'missing')    f = f.filter(a => !a.heard);
  if (activeFilter === 'heard')      f = f.filter(a =>  a.heard);
  if (activeFilter.startsWith('extra_')) {
    const idx = parseInt(activeFilter.slice(6));
    f = f.filter(a => a.extraHeard && a.extraHeard[idx]);
  }
  if (activeGenres.size)  f = f.filter(a => (a.genres||[]).some(g => activeGenres.has(g.name)));
  if (activeDecades.size) f = f.filter(a => a.year && activeDecades.has(Math.floor(a.year/10)*10));
  if (activeSort === 'year_asc')  f.sort((a,b) => (a.year||0)-(b.year||0));
  if (activeSort === 'year_desc') f.sort((a,b) => (b.year||0)-(a.year||0));
  if (activeSort === 'artist')    f.sort((a,b) => a.artist.localeCompare(b.artist));
  if (activeSort === 'rank')      f.sort((a,b) => (a.n||0)-(b.n||0));

  if (!f.length) { grid.innerHTML = ''; emptyEl.classList.add('visible'); return; }
  emptyEl.classList.remove('visible');
  grid.innerHTML = f.map(a => cardHTML(a)).join('');
  grid.querySelectorAll('img.card-cover').forEach(img => {
    img.addEventListener('error', () => {
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
    });
  });
  grid.querySelectorAll('.card').forEach(c => {
    c.addEventListener('click', () => openDetailPanel({ type:'collection', idx: parseInt(c.dataset.idx) }));
  });
}

function cardHTML(a) {
  const cls  = a.heard ? 'heard' : 'missing';
  const idx  = allAlbums.indexOf(a);
  const imgEl = a.cover
    ? `<img class="card-cover" src="${escH(a.cover)}" loading="lazy" alt="${escH(a.title)}">`
    : '';
  const ph = `<div class="card-placeholder" ${a.cover ? 'style="display:none"' : ''}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
    </svg></div>`;
  const dots = (a.extraHeard && a.extraHeard.length)
    ? `<div class="extra-dots">${a.extraHeard.map((h, i) =>
        `<div class="extra-dot${h ? ' heard' : ''}" style="color:${extraUsers[i]?.color||'#fff'};background:${extraUsers[i]?.color||'#fff'}"></div>`
      ).join('')}</div>`
    : '';
  return `<div class="card ${cls}" data-idx="${idx}">
    ${imgEl}${ph}
    <div class="card-overlay"></div>
    <div class="card-n">${a.n}</div>${dots}
    <div class="card-info">
      <div class="card-title">${escH(a.title)}</div>
      <div class="card-artist">${escH(a.artist)}</div>
      ${a.year ? `<div class="card-year">${a.year}</div>` : ''}
    </div>
  </div>`;
}

// ── Event listeners (replaces all removed inline handlers) ─────────────────

// Static elements (from HTML template)
document.getElementById('badge-inline').addEventListener('click', openUserModal);
document.getElementById('btn-usuario').addEventListener('click', openUserModal);
document.querySelector('#user-modal .modal-close').addEventListener('click', closeUserModal);
document.querySelector('#um-sec-extra .um-section-title').addEventListener('click', toggleUmExtra);
document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);
document.getElementById('sidebar-fab').addEventListener('click', toggleSidebar);
document.querySelector('#panel-colls .sb-panel-hdr').addEventListener('click', () => togglePanel('panel-colls'));
document.querySelector('#panel-genres .sb-panel-hdr').addEventListener('click', () => togglePanel('panel-genres'));
document.querySelector('#panel-dates .sb-panel-hdr').addEventListener('click', () => togglePanel('panel-dates'));
document.querySelector('button.sb-about-btn').addEventListener('click', openAboutModal);
document.getElementById('about-overlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeAboutModal(); });
document.querySelector('.about-close').addEventListener('click', closeAboutModal);
document.querySelector('.dp-close').addEventListener('click', closeDetailPanel);

// Delegation: extra-users list (sync / save-json / remove)
document.getElementById('extra-users-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx);
  if (btn.dataset.action === 'sync')      syncExtraUser(idx);
  else if (btn.dataset.action === 'save-json') saveExtraUserJSON(idx);
  else if (btn.dataset.action === 'remove')    removeExtraUser(idx);
});

// Delegation: per-user filter buttons
document.getElementById('filter-extra-users').addEventListener('click', e => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  const i = parseInt(btn.dataset.filter.replace('extra_', ''));
  setExtraFilter(i);
});

// Delegation: idb-extra-list (add-extra)
document.getElementById('idb-extra-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action="add-extra"]');
  if (btn) idbAddAsExtra(btn.dataset.user);
});

// Delegation: idb-list (load / download / delete)
document.getElementById('idb-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const user = btn.dataset.user;
  if (btn.dataset.action === 'load')     idbLoadSession(user);
  else if (btn.dataset.action === 'download') idbDownloadSession(user);
  else if (btn.dataset.action === 'delete')   idbDeleteSession(user);
});

// Delegation: friends-list (fr-add)
document.getElementById('friends-list').addEventListener('click', e => {
  const btn = e.target.closest('.fr-add[data-username]');
  if (btn && !btn.disabled) addExtraUserByName(btn.dataset.username, btn);
});

// Delegation: colls-body tree nodes (.tree-genre-hdr and .tree-sub-item)
document.getElementById('colls-body').addEventListener('click', e => {
  const hdr = e.target.closest('.tree-genre-hdr[data-nid]');
  if (hdr) {
    if (hdr.dataset.hasKids) toggleTree(hdr.dataset.nid);
    if (hdr.dataset.slug)    selectCollection(hdr.dataset.slug);
    return;
  }
  const sub = e.target.closest('.tree-sub-item[data-slug]');
  if (sub && sub.dataset.slug) selectCollection(sub.dataset.slug);
});

// Delegation: genre pills
document.getElementById('genre-pills').addEventListener('click', e => {
  const pill = e.target.closest('.pill[data-genre]');
  if (pill) toggleGenre(pill.dataset.genre);
});

// Delegation: decade pills
document.getElementById('decade-pills').addEventListener('click', e => {
  const pill = e.target.closest('.pill[data-decade]');
  if (pill) toggleDecade(Number(pill.dataset.decade));
});
