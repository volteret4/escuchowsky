// ── IndexedDB constants (must be before any async init that uses them) ──────
const IDB_NAME = "mustlisten";
const IDB_STORE = "sessions";

// ── State ──────────────────────────────────────────────────────────────────
let heardCache = null; // { user, pairs:[[a,t],...], count, fetched_at }
let loadedUser = null;

// extra users for cross-reference / recommendation
const USER_COLORS = [
  "#6a9fb5",
  "#78b56c",
  "#b56c6c",
  "#9b6cb5",
  "#b59b6c",
  "#6cb5b5",
  "#b56ca0",
  "#7ab5a0",
];
let extraUsers = []; // [{user, pairs:[[na,nt,oa,ot,count],...], color, count, fetched_at}]
// Session cache: survives deactivation within same page load. username.lc → data
const _sessionCache = new Map();

// discover state
let discoverMode = false;
let discoverAllCandidates = [];
let discoverCandidates = [];
let discoverAlbums = [];
let discoverOffset = 0;
let discoverSearching = false;
let discoverEs = null;
let discoverGeneration = 0;
let discoverDecadeFilter = new Set();
let discoverPage = 0;
let discoverLimit = 20;
let discoverModeType = "albums";
let discoverUserIdxs        = [0];       // active discover users (snapshot at trigger)
let activeDiscoverUserIdxs  = new Set([0]); // selected users in indicator (toggleable)
let discoverRelMode         = 'discover'; // 'discover' | 'share' | 'enjoy'

// album info cache (artist|||title → data)
const albumInfoCache = new Map();

// ── DOM refs ───────────────────────────────────────────────────────────────
const inpUser = document.getElementById("inp-user");
const btnGo = document.getElementById("btn-go");
const loading = document.getElementById("loading");
const loadTxt = document.getElementById("loading-text");
const errMsg = document.getElementById("error-msg");
const inpSession = document.getElementById("inp-session");

// ── Sidebar panel toggle ───────────────────────────────────────────────────
function closeSidebar() {} // no-op (sidebar eliminado)

// ── About modal ───────────────────────────────────────────────────────────
function openAboutModal() {
  document.getElementById("about-overlay").classList.add("open");
  document.body.style.overflow = "hidden";
}
function closeAboutModal() {
  document.getElementById("about-overlay").classList.remove("open");
  document.body.style.overflow = "";
}
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    document.getElementById("about-overlay").classList.contains("open")
  )
    closeAboutModal();
});

// ── Avatar helper ──────────────────────────────────────────────────────────
// source="lb"  → always show initial (LB has no profile pictures)
// source="lfm" → show image if available, grey circle if missing (initial is fetched later)
function _avatarHtml(username, imgSrc, sizePx, color, source) {
  const sz = sizePx || 22;
  const bg = color || "var(--accent)";
  const fs = Math.max(7, Math.round(sz * 0.44));
  const isLb = source === "lb";

  if (!imgSrc) {
    if (isLb) {
      const initial = ((username || "?")[0] || "?").toUpperCase();
      return `<div style="width:${sz}px;height:${sz}px;border-radius:50%;flex-shrink:0;background:${bg};display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:700;color:#fff;line-height:1;font-family:var(--serif)">${initial}</div>`;
    }
    return `<div style="width:${sz}px;height:${sz}px;border-radius:50%;flex-shrink:0;background:var(--bg3)"></div>`;
  }

  // Build fallback: initial for LB, grey circle for LFM (broken image)
  const fbDiv = isLb
    ? `<div style="width:${sz}px;height:${sz}px;border-radius:50%;flex-shrink:0;background:${bg};display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:700;color:#fff;line-height:1;font-family:var(--serif)">${((username || "?")[0] || "?").toUpperCase()}</div>`
    : `<div style="width:${sz}px;height:${sz}px;border-radius:50%;flex-shrink:0;background:var(--bg3)"></div>`;
  return `<img src="${escH(imgSrc)}" alt="" data-fb="${escH(fbDiv)}" style="width:${sz}px;height:${sz}px;border-radius:50%;object-fit:cover;flex-shrink:0" loading="eager" onerror="this.outerHTML=this.dataset.fb">`;
}

// ── Topbar avatar button ───────────────────────────────────────────────────
function _updateTopbarAvatar(imgSrc, username, source) {
  const btn = document.getElementById("btn-open-users");
  if (!btn) return;
  if (imgSrc || username) {
    btn.innerHTML = _avatarHtml(username || "?", imgSrc || "", 28, "var(--accent)", source || heardCache?.source || "lfm");
    btn.style.overflow = "hidden";
    btn.style.padding = "0";
  } else {
    btn.textContent = "👤";
    btn.style.overflow = "";
    btn.style.padding = "";
  }
}

// ── User modal open/close ──────────────────────────────────────────────────
function openUserModal() {
  document.getElementById("user-modal-bg").classList.add("open");
  document.body.style.overflow = "hidden";
  renderSecondaryUsers();
}
function closeUserModal() {
  document.getElementById("user-modal-bg").classList.remove("open");
  document.body.style.overflow = "";
}
document.getElementById("user-modal-bg").addEventListener("click", (e) => {
  if (e.target === document.getElementById("user-modal-bg")) closeUserModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (document.getElementById("user-modal-bg").classList.contains("open"))
      closeUserModal();
  }
});

// ── Extra users (recommendation) ──────────────────────────────────────────
function saveExtraUsersLS() {
  try {
    localStorage.setItem(
      "ml_extra_users",
      JSON.stringify(
        extraUsers.map((u) => ({
          user: u.user,
          color: u.color,
          count: u.count,
          fetched_at: u.fetched_at,
          image: u.image || "",
          source: u.source || "lfm",
        })),
      ),
    );
  } catch (_) {}
}

function loadExtraUsersLS() {
  try {
    const saved = JSON.parse(localStorage.getItem("ml_extra_users") || "[]");
    for (const u of saved) {
      if (u.user) extraUsers.push({ ...u, pairs: [], songs: [], image: u.image || "" });
    }
  } catch (e) {}
}

async function hydrateExtraUsersFromIdb() {
  for (let i = 0; i < extraUsers.length; i++) {
    if (!extraUsers[i].pairs?.length) {
      const data = await idbLoad(extraUsers[i].user).catch(() => null);
      if (data?.heard?.length) {
        extraUsers[i].pairs = data.heard;
        extraUsers[i].songs = data.songs || [];
        extraUsers[i].count = data.count || data.heard.length;
        extraUsers[i].tracks_loaded = data.tracks_loaded || false;
        extraUsers[i].last_scrobble_ts = data.last_scrobble_ts || 0;
        extraUsers[i].last_scrobble_artist = data.last_scrobble_artist || "";
        extraUsers[i].last_scrobble_track = data.last_scrobble_track || "";
        _sessionCache.set(extraUsers[i].user.toLowerCase(), {
          pairs: data.heard, songs: data.songs || [],
          count: data.count || data.heard.length,
          fetched_at: data.fetched_at || 0,
          color: extraUsers[i].color,
          image: extraUsers[i].image || "",
          source: data.source || "lfm",
          tracks_loaded: data.tracks_loaded || false,
        });
      }
    }
  }
}

function buildExtraUsersList() {
  const hasExtra = extraUsers.length > 0;
  const ctrlBar = document.getElementById("discover-ctrl-bar");
  if (ctrlBar) ctrlBar.style.display = hasExtra ? "" : "none";
  if (hasExtra) {
    // Prune stale indices
    activeDiscoverUserIdxs = new Set([...activeDiscoverUserIdxs].filter(i => i < extraUsers.length));
    if (!activeDiscoverUserIdxs.size) activeDiscoverUserIdxs.add(0);
    _updateDiscoverIndicator();
  } else {
    // No active users: hide discover results if shown
    const _dv = document.getElementById("discover-view");
    if (_dv) _dv.classList.remove("visible");
    ++discoverGeneration;
    if (discoverEs) {
      discoverEs.close();
      discoverEs = null;
    }
    discoverSearching = false;
    discoverMode = false;
  }
  renderSecondaryUsers();
}

function selectDiscoverUser(i) { setActiveDiscoverUser(i); }

function setActiveDiscoverUser(i) {
  activeDiscoverUserIdxs = new Set([i]);
  document.querySelectorAll(".sbar-user")
    .forEach((el, j) => el.classList.toggle("active", j === i));
  _updateDiscoverIndicator();
}

function toggleDiscoverUser(i) {
  if (activeDiscoverUserIdxs.has(i)) {
    if (activeDiscoverUserIdxs.size > 1) activeDiscoverUserIdxs.delete(i);
  } else {
    activeDiscoverUserIdxs.add(i);
  }
  document.querySelectorAll(".sbar-user")
    .forEach((el, j) => el.classList.toggle("active", activeDiscoverUserIdxs.has(j)));
  _updateDiscoverIndicator();
}

function _updateDiscoverIndicator() {
  const el = document.getElementById("disc-user-indicator");
  if (!el) return;

  if (!extraUsers.length) {
    el.innerHTML = "";
    return;
  }

  // Build summary label (truncate each name at 20 chars)
  const _trunc = (s) => s.length > 20 ? s.slice(0, 19) + "…" : s;
  const activeIdxs = [...activeDiscoverUserIdxs].filter(i => i < extraUsers.length);
  const summary = activeIdxs.length === 0
    ? "Ninguno"
    : activeIdxs.length <= 2
      ? activeIdxs.map(i => _trunc(extraUsers[i].user)).join(", ")
      : `${activeIdxs.length} activos`;

  // Build dropdown items HTML
  const itemsHtml = extraUsers.map((uu, i) => {
    const sel = activeDiscoverUserIdxs.has(i);
    const dot = _avatarHtml(uu.user, uu.image || "", 14, uu.color, uu.source || "lfm");
    return `<div class="disc-dd-item${sel ? " sel" : ""}" data-idx="${i}">
      <span class="disc-chk${sel ? " sel" : ""}">${sel ? "✓" : ""}</span>
      ${dot}
      <span class="disc-dd-name">${escH(uu.user)}</span>
    </div>`;
  }).join("");

  // Reuse structure if already built, update content only
  let btn = el.querySelector(".disc-user-btn");
  let dd = el.querySelector(".disc-user-dd");

  if (!btn) {
    el.style.cssText = "position:relative;flex:1;min-width:0";
    el.innerHTML = `<button class="disc-user-btn">
      <span class="disc-user-summary"></span>
      <span class="disc-dd-arrow">▾</span>
    </button>
    <div class="disc-user-dd" style="display:none"></div>`;
    btn = el.querySelector(".disc-user-btn");
    dd = el.querySelector(".disc-user-dd");

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dd.style.display = dd.style.display === "none" ? "" : "none";
    });
    dd.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = e.target.closest(".disc-dd-item[data-idx]");
      if (!item) return;
      const idx = parseInt(item.dataset.idx, 10);
      if (activeDiscoverUserIdxs.has(idx)) activeDiscoverUserIdxs.delete(idx);
      else activeDiscoverUserIdxs.add(idx);
      document.querySelectorAll(".sbar-user")
        .forEach((el, j) => el.classList.toggle("active", activeDiscoverUserIdxs.has(j)));
      _updateDiscoverIndicator();
    });
  }

  btn.querySelector(".disc-user-summary").textContent = summary;
  dd.innerHTML = itemsHtml;
}

// Close dropdown when clicking outside
document.addEventListener("click", () => {
  document.querySelectorAll(".disc-user-dd").forEach(dd => { dd.style.display = "none"; });
});

async function triggerDiscover() {
  if (!extraUsers.length) return;
  const mode = document.getElementById("disc-mode-select")?.value || "albums";
  const limit = Math.min(100, Math.max(1, parseInt(document.getElementById("disc-limit-global")?.value || "20")));
  const idxs = [...activeDiscoverUserIdxs].filter(i => i < extraUsers.length);
  if (!idxs.length) return;
  if (mode === "songs") {
    for (const i of idxs) {
      const u = extraUsers[i];
      if (u && u.songs === undefined) {
        const data = await idbLoad(u.user).catch(() => null);
        if (data) u.songs = data.songs || [];
      }
    }
  }
  enterDiscoverMode(idxs, limit, mode, discoverRelMode);
}

function saveExtraUserJSON(idx) {
  const u = extraUsers[idx];
  if (!u) return;
  const blob = new Blob(
    [
      JSON.stringify(
        {
          version: 1,
          user: u.user,
          count: u.count,
          fetched_at: u.fetched_at,
          heard: u.pairs,
          songs: u.songs || [],
        },
        null,
        0,
      ),
    ],
    { type: "application/json" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${u.user}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function addExtraUser() {
  const inp = document.getElementById("inp-extra-user");
  const prog = document.getElementById("um-extra-progress");
  const user = inp.value.trim();
  if (!user) return;
  if (extraUsers.some((u) => u.user.toLowerCase() === user.toLowerCase())) {
    inp.value = "";
    return;
  }
  const btn = document.getElementById("btn-extra-lfm");
  const src = umSource();
  const userInfo = await checkUserClient(user, src);
  if (!userInfo.ok) {
    prog.textContent = "Error: " + (userInfo.error || "Usuario no encontrado");
    return;
  }
  const method = await showFetchMethodModal(userInfo.username || user, src);
  if (method === null) return;
  btn.disabled = true;
  inp.disabled = true;
  prog.textContent = "Conectando…";
  try {
    const result = await fetchScrobblesClient(
      userInfo.username || user,
      (msg) => {
        prog.textContent = msg.reconnecting
          ? `Reconectando… (${msg.page}/${msg.total_pages || '?'})`
          : `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      },
      src,
      method,
    );
    const realUser = userInfo.username || user;
    const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const fetched_at = Math.floor(Date.now() / 1000);
    _sessionCache.set(realUser.toLowerCase(), {
      pairs: result.heard, songs: result.heard_songs || [],
      count: result.heard.length, fetched_at, color,
      image: userInfo.image || "", source: src,
      tracks_loaded: result.tracks_loaded || false,
    });
    extraUsers.push({
      user: realUser,
      pairs: result.heard,
      songs: result.heard_songs || [],
      color,
      count: result.heard.length,
      fetched_at,
      image: userInfo.image || "",
      source: src,
      tracks_loaded: result.tracks_loaded || false,
      last_scrobble_ts: result.last_scrobble_ts || 0,
      last_scrobble_artist: result.last_scrobble_artist || "",
      last_scrobble_track: result.last_scrobble_track || "",
    });
    saveExtraUsersLS();
    await idbSaveOrModal({
      user: realUser,
      count: result.heard.length,
      fetched_at,
      heard: result.heard,
      songs: result.heard_songs || [],
      source: src,
      tracks_loaded: result.tracks_loaded || false,
      last_scrobble_ts: result.last_scrobble_ts || 0,
      last_scrobble_artist: result.last_scrobble_artist || "",
      last_scrobble_track: result.last_scrobble_track || "",
      complete: true,
      total_pages: result.total_pages || 0,
      heard_artists: result.heard_artists || [],
    });
    await renderIdbExtraList();
    buildExtraUsersList();
    inp.value = "";
    prog.textContent = `✓ ${realUser} — ${result.heard.length.toLocaleString()} álbumes${result.tracks_loaded ? ", " + (result.heard_songs?.length || 0).toLocaleString() + " canciones" : ""}`;
  } catch (e) {
    prog.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
    inp.disabled = false;
  }
}

async function syncExtraUser(idx) {
  const u = extraUsers[idx];
  if (!u) return;
  const prog = document.getElementById("um-extra-progress");
  prog.textContent = `Sincronizando ${u.user}...`;
  try {
    const data = await syncSinceClient(
      u.user,
      u.fetched_at || 0,
      u.source || "lfm",
    );
    if (data.error) throw new Error(data.error);
    // merge: add only pairs not already present
    const existing = new Set(u.pairs.map((p) => p[0] + "|" + p[1]));
    const added = data.new_pairs.filter(
      (p) => !existing.has(p[0] + "|" + p[1]),
    );
    extraUsers[idx].pairs = [...u.pairs, ...added];
    extraUsers[idx].count = extraUsers[idx].pairs.length;
    extraUsers[idx].fetched_at = data.fetched_at;
    // Merge new songs
    if (data.new_songs?.length) {
      const existSongs = new Set(
        (extraUsers[idx].songs || []).map((s) => s[0] + "|" + s[1]),
      );
      const addedSongs = data.new_songs.filter(
        (s) => !existSongs.has(s[0] + "|" + s[1]),
      );
      extraUsers[idx].songs = [...(extraUsers[idx].songs || []), ...addedSongs];
    }
    // Update last scrobble info if sync returned newer data
    if (
      data.last_scrobble_ts &&
      data.last_scrobble_ts > (extraUsers[idx].last_scrobble_ts || 0)
    ) {
      extraUsers[idx].last_scrobble_ts = data.last_scrobble_ts;
      extraUsers[idx].last_scrobble_artist = data.last_scrobble_artist || "";
      extraUsers[idx].last_scrobble_track = data.last_scrobble_track || "";
    }
    saveExtraUsersLS();
    await idbSaveOrModal({
      user: extraUsers[idx].user,
      count: extraUsers[idx].count,
      fetched_at: extraUsers[idx].fetched_at,
      heard: extraUsers[idx].pairs,
      songs: extraUsers[idx].songs || [],
      last_scrobble_ts: extraUsers[idx].last_scrobble_ts || 0,
      last_scrobble_artist: extraUsers[idx].last_scrobble_artist || "",
      last_scrobble_track: extraUsers[idx].last_scrobble_track || "",
    });
    // Fetch avatar if missing
    if (!extraUsers[idx].image) {
      const _syncUser = extraUsers[idx].user;
      const _syncSrc = extraUsers[idx].source || "lfm";
      checkUserClient(_syncUser, _syncSrc).then((info) => {
        if (!info?.ok || !info.image) return;
        const eu = extraUsers.find((u) => u.user.toLowerCase() === _syncUser.toLowerCase());
        if (eu) {
          eu.image = info.image;
          saveExtraUsersLS();
          renderSecondaryUsers();
          idbLoad(_syncUser).then((d) => { if (d) idbSave({ ...d, image: info.image }); }).catch(() => {});
        }
      }).catch(() => {});
    }
    await renderIdbExtraList();
    buildExtraUsersList();
    prog.textContent = `✓ ${u.user}: +${added.length} nuevos (total ${extraUsers[idx].count.toLocaleString()})`;
  } catch (e) {
    prog.textContent = "Error: " + e.message;
  }
}

// (inp-extra-user / btn-extra-lfm removed — search box now handles both primary and secondary)

// ── Friends loader ─────────────────────────────────────────────────────────
document
  .getElementById("btn-load-friends")
  .addEventListener("click", loadFriends);

async function loadFriends() {
  const listEl = document.getElementById("friends-list");
  const btn = document.getElementById("btn-load-friends");
  const user =
    heardCache?.user || document.getElementById("inp-user").value.trim();
  if (!user) {
    listEl.innerHTML =
      '<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Carga primero el usuario principal.</div>';
    return;
  }
  btn.disabled = true;
  listEl.innerHTML =
    '<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Cargando amigos…</div>';
  try {
    const data = await fetch(
      `/api/friends?user=${encodeURIComponent(user)}`,
    ).then((r) => r.json());
    if (!data.ok || !data.friends.length) {
      listEl.innerHTML = `<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">${escH(data.error || "Este usuario no tiene amigos en Last.fm.")}</div>`;
      return;
    }
    renderFriendsList(data.friends);
  } catch (e) {
    listEl.innerHTML = `<div class="um-progress" style="padding:0.3rem 0;color:var(--ink3)">Error: ${escH(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderFriendsList(friends) {
  const listEl = document.getElementById("friends-list");
  const alreadyAdded = new Set(extraUsers.map((u) => u.user.toLowerCase()));
  listEl.innerHTML = friends
    .map((f) => {
      const added = alreadyAdded.has(f.username.toLowerCase());
      const avatar = _avatarHtml(f.username, f.image || "", 22, "var(--accent)");
      return `<div class="fr-row" id="fr-row-${escH(f.username.toLowerCase().replace(/[^a-z0-9]/g, ""))}">
      ${avatar}
      <span class="fr-name">${escH(f.username)}</span>
      <button class="btn-sm fr-add" ${added ? "disabled" : ""} data-username="${escH(f.username)}">
        ${added ? "✓" : "Añadir"}
      </button>
    </div>`;
    })
    .join("");
  listEl.querySelectorAll("img.fr-avatar").forEach((img) => {
    img.addEventListener("error", () => {
      img.style.display = "none";
    });
  });
}

async function addExtraUserByName(username, btn) {
  if (!username) return;
  if (extraUsers.some((u) => u.user.toLowerCase() === username.toLowerCase()))
    return;
  const prog = document.getElementById("um-extra-progress");
  btn.disabled = true;
  btn.textContent = "…";
  prog.textContent = `Verificando ${username}…`;
  const src = umSource();
  try {
    const userInfo = await checkUserClient(username, src);
    if (!userInfo.ok) {
      prog.textContent = "Error: " + (userInfo.error || "No encontrado");
      btn.disabled = false;
      btn.textContent = "Añadir";
      return;
    }
    const realUser = userInfo.username || username;
    const method = await showFetchMethodModal(realUser, src);
    if (method === null) {
      btn.disabled = false;
      btn.textContent = "Añadir";
      return;
    }
    prog.textContent = `Cargando ${realUser}…`;
    const result = await fetchScrobblesClient(
      realUser,
      (msg) => {
        prog.textContent = msg.reconnecting
          ? `Reconectando… (${msg.page}/${msg.total_pages || '?'})`
          : `${realUser}: ${msg.page}/${msg.total_pages} — ${msg.count.toLocaleString()} álb.`;
      },
      src,
      method,
    );
    const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
    const fetched_at = Math.floor(Date.now() / 1000);
    _sessionCache.set(realUser.toLowerCase(), {
      pairs: result.heard, songs: result.heard_songs || [],
      count: result.heard.length, fetched_at, color,
      image: userInfo.image || "", source: src,
      tracks_loaded: result.tracks_loaded || false,
    });
    extraUsers.push({
      user: realUser,
      pairs: result.heard,
      songs: result.heard_songs || [],
      color,
      count: result.heard.length,
      fetched_at,
      image: userInfo.image || "",
      source: src,
      tracks_loaded: result.tracks_loaded || false,
      last_scrobble_ts: result.last_scrobble_ts || 0,
      last_scrobble_artist: result.last_scrobble_artist || "",
      last_scrobble_track: result.last_scrobble_track || "",
    });
    saveExtraUsersLS();
    await idbSaveOrModal({
      user: realUser,
      count: result.heard.length,
      fetched_at,
      heard: result.heard,
      songs: result.heard_songs || [],
      source: src,
      tracks_loaded: result.tracks_loaded || false,
      last_scrobble_ts: result.last_scrobble_ts || 0,
      last_scrobble_artist: result.last_scrobble_artist || "",
      last_scrobble_track: result.last_scrobble_track || "",
      complete: true,
      total_pages: result.total_pages || 0,
      heard_artists: result.heard_artists || [],
    });
    await renderIdbExtraList();
    buildExtraUsersList();
    btn.textContent = "✓";
    prog.textContent = `✓ ${realUser} — ${result.heard.length.toLocaleString()} álbumes${result.tracks_loaded ? ", " + (result.heard_songs?.length || 0).toLocaleString() + " canciones" : ""}`;
    const frList = document.getElementById("friends-list");
    if (frList?.children.length) {
      frList.querySelectorAll(".fr-add").forEach((b) => {
        const row = b.closest(".fr-row");
        const name = row?.querySelector(".fr-name")?.textContent?.trim() || "";
        if (
          extraUsers.some((eu) => eu.user.toLowerCase() === name.toLowerCase())
        ) {
          b.disabled = true;
          b.textContent = "✓";
        }
      });
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Añadir";
    prog.textContent = "Error: " + e.message;
  }
}

// inp-extra-json is still in DOM (appended after modal), handle it for back-compat
document
  .getElementById("inp-extra-json")
  .addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const prog = document.getElementById("um-extra-progress");
    try {
      const data = JSON.parse(await file.text());
      if (!data.heard || !data.user) throw new Error("Formato inválido");
      if (
        extraUsers.some((u) => u.user.toLowerCase() === data.user.toLowerCase())
      ) {
        prog.textContent = `${data.user} ya está en la lista.`;
        return;
      }
      const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
      const ft = data.fetched_at || 0;
      const importedSongs = data.songs || [];
      _sessionCache.set(data.user.toLowerCase(), { pairs: data.heard, songs: importedSongs, count: data.heard.length, fetched_at: ft, color, image: "", source: "lfm", tracks_loaded: false });
      extraUsers.push({
        user: data.user,
        pairs: data.heard,
        songs: importedSongs,
        color,
        count: data.heard.length,
        fetched_at: ft,
        image: "",
      });
      saveExtraUsersLS();
      await idbSaveOrModal({
        user: data.user,
        count: data.heard.length,
        fetched_at: ft,
        heard: data.heard,
        songs: importedSongs,
      });
      buildExtraUsersList();
      prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
    } catch (err) {
      prog.textContent = "Error: " + err.message;
    }
    e.target.value = "";
  });

function removeExtraUser(idx) {
  extraUsers.splice(idx, 1);
  saveExtraUsersLS();
  buildExtraUsersList();
}

// Legacy alias kept for call sites that haven't been updated yet
async function renderIdbExtraList() {
  return renderSecondaryUsers();
}

async function idbAddAsExtra(username) {
  const data = await idbLoad(username);
  if (!data) return;
  if (extraUsers.some((u) => u.user.toLowerCase() === username.toLowerCase()))
    return;
  const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
  // try to get avatar
  const userInfo = await checkUserClient(username, data.source || "lfm").catch(
    () => null,
  );
  const image = userInfo?.ok ? userInfo.image || "" : "";
  extraUsers.push({
    user: data.user,
    pairs: data.heard,
    songs: data.songs || [],
    color,
    count: data.heard.length,
    fetched_at: data.fetched_at || 0,
    image,
    source: data.source || "lfm",
    tracks_loaded: data.tracks_loaded || false,
  });
  saveExtraUsersLS();
  buildExtraUsersList();
  renderIdbExtraList();
  document.getElementById("um-extra-progress").textContent =
    `✓ ${data.user} añadido`;
}

/// ── Source helpers ────────────────────────────────────────────────────────
function umSource() {
  return document.getElementById("um-src-lb")?.checked ? "lb" : "lfm";
}
function sbSource() {
  return umSource();
} // sidebar eliminado, usar modal
function scrobblesEndpoint(user, source) {
  const base = source === "lb" ? "/api/scrobbles/lb" : "/api/scrobbles";
  return `${base}?user=${encodeURIComponent(user)}`;
}
function sinceEndpoint(user, since, source) {
  const base =
    source === "lb" ? "/api/scrobbles/lb/since" : "/api/scrobbles/since";
  return `${base}?user=${encodeURIComponent(user)}&since=${since}`;
}
function checkUserEndpoint(user, source) {
  const suffix = source === "lb" ? "&source=lb" : "";
  return `/api/check_user?user=${encodeURIComponent(user)}${suffix}`;
}

// Sync placeholder text and .checked label class when source radio changes
function _syncSourceGroup(groupName, inputId, labels) {
  // labels: [{radioId, placeholder}]
  const radios = labels.map((l) => document.getElementById(l.radioId));
  const inp = document.getElementById(inputId);
  function update() {
    radios.forEach((r, i) => {
      if (!r) return;
      r.closest("label")?.classList.toggle("checked", r.checked);
      if (inp && r.checked) inp.placeholder = labels[i].placeholder;
    });
  }
  radios.forEach((r) => r?.addEventListener("change", update));
  update(); // set initial state
}
document.addEventListener("DOMContentLoaded", () => {
  _syncSourceGroup("um-source", "inp-user", [
    { radioId: "um-src-lfm", placeholder: "Usuario Last.fm" },
    { radioId: "um-src-lb", placeholder: "Usuario ListenBrainz" },
  ]);
  // sb-source (sidebar eliminado) — no sync needed
});

// ── Client-side Last.fm / ListenBrainz API ────────────────────────────────
let LFM_CLIENT_KEY = "";

async function initClientKey() {
  try {
    const cfg = await fetch("/api/config").then((r) => r.json());
    LFM_CLIENT_KEY = cfg.lfm_key || "";
  } catch (e) {}
}

// Matches Python: re.sub(r"[^\w]", "", s.lower()) with Unicode support
function _normClient(s) {
  return (s || "").toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const _LFM_NO_IMG = "2a96cbd8b46e442fc41c2b86b821562f";

// ── Fetch retry helper ────────────────────────────────────────────────────
// Wraps any async fn with up to maxAttempts retries + exponential backoff.
// onRetry(attempt) is called before each retry so callers can update the UI.
async function _retryFetch(fn, maxAttempts = 5, onRetry = null) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxAttempts - 1) throw e;
      if (onRetry) onRetry(attempt + 1);
      await _sleep(5000 * Math.pow(1.5, attempt) + Math.random() * 2000);
    }
  }
}

async function lfmGet(method, params, _retries = 4) {
  const p = new URLSearchParams({
    method,
    api_key: LFM_CLIENT_KEY,
    format: "json",
    ...params,
  });
  let r;
  try {
    r = await fetch("https://ws.audioscrobbler.com/2.0/?" + p);
  } catch (e) {
    // Network error (offline, connection refused) — let _retryFetch handle at loop level
    throw e;
  }
  if (!r.ok) {
    // LFM returns genuine HTTP 500/503 transiently — retry with backoff
    if ((r.status === 500 || r.status === 503) && _retries > 0) {
      await _sleep(3000 + Math.random() * 2000);
      return lfmGet(method, params, _retries - 1);
    }
    throw new Error(`LFM HTTP ${r.status}`);
  }
  const data = await r.json();
  if (data.error) {
    // Transient LFM JSON errors: retry with backoff
    if (
      (data.error === 8 || data.error === 11 || data.error === 16) &&
      _retries > 0
    ) {
      await _sleep(3000 + Math.random() * 2000);
      return lfmGet(method, params, _retries - 1);
    }
    if (!data.topalbums && !data.toptracks && !data.recenttracks) {
      throw new Error(data.message || `LFM error ${data.error}`);
    }
  }
  return data;
}

function _lfmBestImg(images) {
  for (const img of images || []) {
    const url = img["#text"] || "";
    if (img.size === "extralarge" && url && !url.includes(_LFM_NO_IMG))
      return url;
  }
  return "";
}

let _lbLastCall = 0;
async function lbGet(path, _retries = 4) {
  const now = Date.now();
  const wait = 1000 - (now - _lbLastCall);
  if (wait > 0) await _sleep(wait);
  _lbLastCall = Date.now();
  const r = await fetch("https://api.listenbrainz.org" + path);
  if (!r.ok) {
    if (_retries > 0) {
      // 429 = rate limited: wait longer before retry
      const retryWait = r.status === 429 ? 10000 : 4000;
      await _sleep(retryWait + Math.random() * 2000);
      return lbGet(path, _retries - 1);
    }
    throw new Error(`LB HTTP ${r.status}`);
  }
  return r.json();
}

let _mbLastCall = 0;
async function mbGet(path) {
  const now = Date.now();
  const wait = 1100 - (now - _mbLastCall);
  if (wait > 0) await _sleep(wait);
  _mbLastCall = Date.now();
  const r = await fetch("https://musicbrainz.org" + path, {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`MB HTTP ${r.status}`);
  return r.json();
}

async function mbSearchRelGroup(artist, album) {
  const q = `artist:"${artist.replace(/"/g, "")}" AND release:"${album.replace(/"/g, "")}"`;
  const data = await mbGet(
    "/ws/2/release-group?" +
      new URLSearchParams({ query: q, fmt: "json", limit: "1" }),
  );
  const rgs = data["release-groups"] || [];
  if (!rgs.length) return {};
  const rg = rgs[0];
  const ac = rg["artist-credit"] || [];
  return {
    mbid: rg.id || "",
    title: rg.title || album,
    artist: ac[0]?.name || artist,
    date: rg["first-release-date"] || "",
  };
}

// Shared helper to turn the internal dicts into the wire format arrays
function _buildHeard(heardCounts) {
  return Object.entries(heardCounts).map(([k, v]) => {
    const sep = k.indexOf("|||");
    return [k.slice(0, sep), k.slice(sep + 3), v[0], v[1], v[2]];
  });
}
function _buildSongs(heardSongs) {
  return Object.entries(heardSongs).map(([k, v]) => {
    const sep = k.indexOf("|||");
    return [k.slice(0, sep), k.slice(sep + 3), v[0], v[1], v[2], v[3]];
  });
}

// ── getTopAlbums path (fast, ~200 pages for 400k user) ────────────────────
async function _lfmFetchTopAlbums(user, onProgress) {
  const heard_counts = {};
  const heard_artists = new Set();
  let last_scrobble_ts = 0,
    last_scrobble_artist = "",
    last_scrobble_track = "";
  let page = 1,
    totalPages = null;

  while (true) {
    const data = await _retryFetch(
      () => lfmGet("user.getTopAlbums", { user, limit: 200, page, period: "overall" }),
      5,
      () => onProgress({ page, total_pages: totalPages || 1, count: Object.keys(heard_counts).length, reconnecting: true }),
    );
    const container = data.topalbums || {};
    const attrs = container["@attr"] || {};
    if (!totalPages)
      totalPages = Math.max(1, parseInt(attrs.totalPages || "1"));
    const albums = container.album || [];
    for (const a of Array.isArray(albums) ? albums : [albums]) {
      const artist =
        typeof a.artist === "object"
          ? a.artist.name || ""
          : String(a.artist || "");
      const album = a.name || "";
      const count = parseInt(a.playcount || "1") || 1;
      if (artist) heard_artists.add(_normClient(artist));
      if (artist && album) {
        const key = `${_normClient(artist)}|||${_normClient(album)}`;
        if (!heard_counts[key]) heard_counts[key] = [artist, album, count];
        else heard_counts[key][2] = Math.max(count, heard_counts[key][2]);
      }
    }
    onProgress({
      page,
      total_pages: totalPages,
      count: Object.keys(heard_counts).length,
    });
    if (page >= totalPages) break;
    page++;
  }

  // 1 page of recentTracks for last_scrobble info
  try {
    const recent = await lfmGet("user.getRecentTracks", {
      user,
      limit: 1,
      page: 1,
    });
    const arr = [].concat(recent.recenttracks?.track || []);
    for (const t of arr) {
      if (t["@attr"]?.nowplaying) continue;
      const art =
        typeof t.artist === "object"
          ? t.artist["#text"] || ""
          : String(t.artist || "");
      last_scrobble_ts = parseInt(t.date?.uts || "0") || 0;
      last_scrobble_artist = art;
      last_scrobble_track = t.name || "";
      break;
    }
  } catch (e) {}

  return {
    heard: _buildHeard(heard_counts),
    heard_songs: [],
    heard_artists: [...heard_artists],
    last_scrobble_ts,
    last_scrobble_artist,
    last_scrobble_track,
    total_pages: totalPages || 0,
    tracks_loaded: false,
  };
}

// ── getRecentTracks path (complete, albums + songs, ~400 pages for 400k user) ─
async function _lfmFetchFull(user, onProgress) {
  const heard_counts = {};
  const heard_songs = {};
  const heard_artists = new Set();
  let last_scrobble_ts = 0,
    last_scrobble_artist = "",
    last_scrobble_track = "";
  let page = 1,
    totalPages = null;

  while (true) {
    const data = await _retryFetch(
      () => lfmGet("user.getRecentTracks", { user, limit: 1000, page }),
      5,
      () => onProgress({ page, total_pages: totalPages || 1, count: Object.keys(heard_counts).length, reconnecting: true }),
    );
    const rt = data.recenttracks || {};
    const attrs = rt["@attr"] || {};
    if (!totalPages)
      totalPages = Math.max(1, parseInt(attrs.totalPages || "1"));
    const tracks = [].concat(rt.track || []);
    for (const t of tracks) {
      if (t["@attr"]?.nowplaying) continue;
      const artist =
        typeof t.artist === "object"
          ? t.artist["#text"] || ""
          : String(t.artist || "");
      const album =
        typeof t.album === "object"
          ? t.album["#text"] || ""
          : String(t.album || "");
      const track_name = t.name || "";
      const ts = parseInt(t.date?.uts || "0") || 0;
      if (!last_scrobble_ts && ts) {
        last_scrobble_ts = ts;
        last_scrobble_artist = artist;
        last_scrobble_track = track_name;
      }
      if (artist) heard_artists.add(_normClient(artist));
      if (artist && album) {
        const key = `${_normClient(artist)}|||${_normClient(album)}`;
        if (!heard_counts[key]) heard_counts[key] = [artist, album, 1];
        else heard_counts[key][2]++;
      }
      if (artist && track_name) {
        const key = `${_normClient(artist)}|||${_normClient(track_name)}`;
        if (!heard_songs[key])
          heard_songs[key] = [artist, album, track_name, 1];
        else heard_songs[key][3]++;
      }
    }
    onProgress({
      page,
      total_pages: totalPages,
      count: Object.keys(heard_counts).length,
    });
    if (page >= totalPages) break;
    page++;
  }

  return {
    heard: _buildHeard(heard_counts),
    heard_songs: _buildSongs(heard_songs),
    heard_artists: [...heard_artists],
    last_scrobble_ts,
    last_scrobble_artist,
    last_scrobble_track,
    total_pages: totalPages || 0,
    tracks_loaded: true,
  };
}

// ── ListenBrainz full fetch ───────────────────────────────────────────────
async function _lbFetchAllClient(user, onProgress) {
  const heard_counts = {};
  const heard_songs = {};
  const heard_artists = new Set();
  let last_scrobble_ts = 0,
    last_scrobble_artist = "",
    last_scrobble_track = "";
  let maxTs = null,
    page = 0,
    totalPages = null;

  try {
    const cnt = await lbGet(`/1/user/${encodeURIComponent(user)}/listen-count`);
    const total = cnt.payload?.count || 0;
    totalPages = Math.max(1, Math.ceil(total / 100));
  } catch (e) {}

  while (true) {
    let path = `/1/user/${encodeURIComponent(user)}/listens?count=100`;
    if (maxTs !== null) path += `&max_ts=${maxTs}`;
    let payload;
    try {
      payload = (await _retryFetch(
        () => lbGet(path),
        5,
        () => onProgress({ page, total_pages: totalPages || page || 1, count: Object.keys(heard_counts).length, reconnecting: true }),
      )).payload || {};
    } catch (e) {
      if (page === 0) throw e;
      break;
    }
    const listens = payload.listens || [];
    if (!listens.length) break;
    page++;
    for (const l of listens) {
      const tm = l.track_metadata || {};
      const artist = tm.artist_name || "",
        album = tm.release_name || "",
        track = tm.track_name || "";
      const ts = l.listened_at || 0;
      if (!last_scrobble_ts && ts) {
        last_scrobble_ts = ts;
        last_scrobble_artist = artist;
        last_scrobble_track = track;
      }
      if (artist) heard_artists.add(_normClient(artist));
      if (artist && album) {
        const key = `${_normClient(artist)}|||${_normClient(album)}`;
        if (!heard_counts[key]) heard_counts[key] = [artist, album, 1];
        else heard_counts[key][2]++;
      }
      if (artist && track) {
        const key = `${_normClient(artist)}|||${_normClient(track)}`;
        if (!heard_songs[key]) heard_songs[key] = [artist, album, track, 1];
        else heard_songs[key][3]++;
      }
    }
    const tsVals = listens.map((l) => l.listened_at).filter((t) => t > 0);
    if (!tsVals.length) break;
    maxTs = Math.min(...tsVals) - 1;
    onProgress({
      page,
      total_pages: totalPages || page,
      count: Object.keys(heard_counts).length,
    });
  }

  return {
    heard: _buildHeard(heard_counts),
    heard_songs: _buildSongs(heard_songs),
    heard_artists: [...heard_artists],
    last_scrobble_ts,
    last_scrobble_artist,
    last_scrobble_track,
    total_pages: totalPages || page,
    tracks_loaded: true,
  };
}

// ── Unified fetch entry point ─────────────────────────────────────────────
async function fetchScrobblesClient(
  user,
  onProgress,
  source = "lfm",
  method = "albums",
) {
  if (source === "lb") return _lbFetchAllClient(user, onProgress);
  if (method === "full") return _lfmFetchFull(user, onProgress);
  return _lfmFetchTopAlbums(user, onProgress);
}

// ── Client-side check user ────────────────────────────────────────────────
async function checkUserClient(user, source) {
  try {
    if (source === "lb") {
      const data = await lbGet(
        `/1/user/${encodeURIComponent(user)}/listens?count=1`,
      );
      return {
        ok: true,
        username: data.payload?.user_id || user,
        realname: "",
        playcount: 0,
        image: "",
      };
    }
    const data = await lfmGet("user.getInfo", { user });
    const u = data.user || {};
    const img = (u.image || []).find((i) => i.size === "medium");
    return {
      ok: true,
      username: u.name || user,
      realname: u.realname || "",
      playcount: u.playcount || 0,
      image: img?.["#text"] || "",
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Client-side sync (getRecentTracks?from= or LB) ────────────────────────
async function syncSinceClient(user, since, source) {
  if (source === "lb") return _lbSinceClient(user, since);
  const new_counts = {},
    new_songs = {};
  let last_scrobble_ts = 0,
    last_scrobble_artist = "",
    last_scrobble_track = "";
  let page = 1,
    totalPages = 1;
  while (page <= totalPages) {
    const params = { user, limit: 200, page };
    if (since) params.from = since + 1;
    let data;
    try {
      data = await lfmGet("user.getRecentTracks", params);
    } catch (e) {
      if (page === 1) throw e;
      break;
    }
    const rt = data.recenttracks || {};
    const tp = Math.max(1, parseInt(rt["@attr"]?.totalPages || "1"));
    if (tp > totalPages) totalPages = tp;
    for (const t of [].concat(rt.track || [])) {
      if (t["@attr"]?.nowplaying) continue;
      const artist =
        typeof t.artist === "object"
          ? t.artist["#text"] || ""
          : String(t.artist || "");
      const album =
        typeof t.album === "object"
          ? t.album["#text"] || ""
          : String(t.album || "");
      const track_name = t.name || "";
      if (!last_scrobble_ts) {
        last_scrobble_ts = parseInt(t.date?.uts || "0") || 0;
        last_scrobble_artist = artist;
        last_scrobble_track = track_name;
      }
      if (artist && album) {
        const k = `${_normClient(artist)}|||${_normClient(album)}`;
        if (!new_counts[k]) new_counts[k] = [artist, album, 1];
        else new_counts[k][2]++;
      }
      if (artist && track_name) {
        const k = `${_normClient(artist)}|||${_normClient(track_name)}`;
        if (!new_songs[k]) new_songs[k] = [artist, album, track_name, 1];
        else new_songs[k][3]++;
      }
    }
    page++;
  }
  return {
    new_pairs: _buildHeard(new_counts),
    new_songs: _buildSongs(new_songs),
    fetched_at: Math.floor(Date.now() / 1000),
    last_scrobble_ts,
    last_scrobble_artist,
    last_scrobble_track,
  };
}

async function _lbSinceClient(user, since) {
  const new_counts = {},
    new_songs = {};
  let last_scrobble_ts = 0,
    last_scrobble_artist = "",
    last_scrobble_track = "";
  let maxTs = null;
  while (true) {
    let path = `/1/user/${encodeURIComponent(user)}/listens?count=100`;
    if (maxTs !== null) path += `&max_ts=${maxTs}`;
    if (since) path += `&min_ts=${since}`;
    let payload;
    try {
      payload = (await lbGet(path)).payload || {};
    } catch (e) {
      break;
    }
    const listens = payload.listens || [];
    if (!listens.length) break;
    for (const l of listens) {
      const tm = l.track_metadata || {};
      const artist = tm.artist_name || "",
        album = tm.release_name || "",
        track = tm.track_name || "";
      const ts = l.listened_at || 0;
      if (!last_scrobble_ts && ts) {
        last_scrobble_ts = ts;
        last_scrobble_artist = artist;
        last_scrobble_track = track;
      }
      if (artist && album) {
        const k = `${_normClient(artist)}|||${_normClient(album)}`;
        if (!new_counts[k]) new_counts[k] = [artist, album, 1];
        else new_counts[k][2]++;
      }
      if (artist && track) {
        const k = `${_normClient(artist)}|||${_normClient(track)}`;
        if (!new_songs[k]) new_songs[k] = [artist, album, track, 1];
        else new_songs[k][3]++;
      }
    }
    const tsVals = listens.map((l) => l.listened_at).filter((t) => t > since);
    if (!tsVals.length) break;
    maxTs = Math.min(...tsVals) - 1;
    if (maxTs <= since) break;
  }
  return {
    new_pairs: _buildHeard(new_counts),
    new_songs: _buildSongs(new_songs),
    fetched_at: Math.floor(Date.now() / 1000),
    last_scrobble_ts,
    last_scrobble_artist,
    last_scrobble_track,
  };
}

// ── Fetch-method choice modal ─────────────────────────────────────────────
function showFetchMethodModal(username, source) {
  if (source === "lb") return Promise.resolve("full");
  return new Promise((resolve) => {
    let selected = "albums";
    const ov = document.createElement("div");
    ov.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:500;display:flex;align-items:center;justify-content:center;padding:1rem";

    const optStyle = (active) =>
      `display:flex;gap:.75rem;align-items:flex-start;padding:.85rem;border:2px solid ${active ? "var(--accent)" : "var(--border2)"};border-radius:8px;cursor:pointer;background:var(--bg3);transition:border-color .15s`;
    const dotStyle = (active) =>
      `width:16px;height:16px;border-radius:50%;border:2px solid ${active ? "var(--accent)" : "var(--ink3)"};background:${active ? "var(--accent)" : "transparent"};flex-shrink:0;margin-top:2px;transition:all .15s`;

    ov.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:1.5rem;max-width:440px;width:100%;font-family:var(--sans)">
        <div style="font-family:var(--serif);font-size:1.1rem;font-weight:700;margin-bottom:1rem;color:var(--ink)">¿Cómo cargar <em>${escH(username)}</em>?</div>
        <div style="display:flex;flex-direction:column;gap:.6rem;margin-bottom:1.2rem">
          <div id="fm-opt-albums" style="${optStyle(true)}">
            <div id="fm-dot-albums" style="${dotStyle(true)}"></div>
            <div>
              <div style="font-weight:600;font-size:.875rem;color:var(--ink);font-family:var(--sans)">Rápido — Top Álbumes</div>
              <div style="font-size:.78rem;color:var(--ink2);line-height:1.5;margin-top:.3rem;font-family:var(--sans)">Usa <code style="font-family:var(--mono);color:var(--accent)">getTopAlbums</code>. Descarga los álbumes más escuchados. No incluye canciones. Quedan ausentes un 2.567% aproximadamente.</div>
            </div>
          </div>
          <div id="fm-opt-full" style="${optStyle(false)}">
            <div id="fm-dot-full" style="${dotStyle(false)}"></div>
            <div>
              <div style="font-weight:600;font-size:.875rem;color:var(--ink);font-family:var(--sans)">Completo — Todos los scrobbles</div>
              <div style="font-size:.78rem;color:var(--ink2);line-height:1.5;margin-top:.3rem;font-family:var(--sans)">Usa <code style="font-family:var(--mono);color:var(--accent)">getRecentTracks</code>. Todo el historial, álbumes más fieles e incluye canciones. Va a tardar <strong style="color:var(--ink)">una mihita más</strong>.</div>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end">
          <button id="fm-cancel" class="btn-sm">Cancelar</button>
          <button id="fm-ok" class="btn-sm primary">Cargar →</button>
        </div>
      </div>`;

    document.body.appendChild(ov);

    function pick(val) {
      selected = val;
      ov.querySelector("#fm-opt-albums").style.borderColor =
        val === "albums" ? "var(--accent)" : "var(--border2)";
      ov.querySelector("#fm-opt-full").style.borderColor =
        val === "full" ? "var(--accent)" : "var(--border2)";
      ov.querySelector("#fm-dot-albums").style.background =
        val === "albums" ? "var(--accent)" : "transparent";
      ov.querySelector("#fm-dot-albums").style.borderColor =
        val === "albums" ? "var(--accent)" : "var(--ink3)";
      ov.querySelector("#fm-dot-full").style.background =
        val === "full" ? "var(--accent)" : "transparent";
      ov.querySelector("#fm-dot-full").style.borderColor =
        val === "full" ? "var(--accent)" : "var(--ink3)";
    }

    ov.querySelector("#fm-opt-albums").onclick = () => pick("albums");
    ov.querySelector("#fm-opt-full").onclick = () => pick("full");
    ov.querySelector("#fm-cancel").onclick = () => {
      ov.remove();
      resolve(null);
    };
    ov.querySelector("#fm-ok").onclick = () => {
      ov.remove();
      resolve(selected);
    };
  });
}

// (duplicate init block removed — single init at bottom of script)

// (toggleUmExtra removed — secondary section is now always visible in modal)

// ── Discover mode ─────────────────────────────────────────────────────────
function discoverCardHTML(a, i) {
  if (a.type === "song") {
    const userBadges = (a.users || [])
      .map((u) => `<span title="${escH(u.user)}: ${u.count} plays">${_avatarHtml(u.user, u.image || "", 14, u.color, u.source || "lfm")}</span>`)
      .join("");
    const cover = a.cover_url
      ? `<img class="card-cover" src="${escH(a.cover_url)}" loading="lazy" alt="">`
      : "";
    return `<div class="card rec-card disc-song-card" data-disc="${i}" style="cursor:pointer">
      ${cover}
      <div class="disc-song-ph"${a.cover_url ? ' style="display:none"' : ""}>
        <div class="disc-song-icon">♪</div>
      </div>
      <div class="card-overlay"></div>
      <div class="card-info">
        <div class="card-title">${escH(a.orig_t)}</div>
        <div class="card-artist">${escH(a.orig_a)}</div>
        ${a.orig_album ? `<div class="card-album-hint">${escH(a.orig_album)}</div>` : ""}
        <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
      </div>
    </div>`;
  }
  if (a.type === "artist") {
    const userBadges = (a.users || [])
      .map((u) => `<span title="${escH(u.user)}: ${u.count} plays">${_avatarHtml(u.user, u.image || "", 14, u.color, u.source || "lfm")}</span>`)
      .join("");
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
        <div class="card-artist" style="opacity:0.6">${a.album_count} álbum${a.album_count !== 1 ? "es" : ""}</div>
        <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
      </div>
    </div>`;
  }
  const cover = a.cover_url
    ? `<img class="card-cover" src="${escH(a.cover_url)}" loading="lazy" alt="">`
    : "";
  const ph = `<div class="card-placeholder" ${a.cover_url ? 'style="display:none"' : ""}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
    </svg></div>`;
  const userBadges = (a.users || [])
    .map((u) => `<span title="${escH(u.user)}: ${u.count} plays">${_avatarHtml(u.user, u.image || "", 14, u.color, u.source || "lfm")}</span>`)
    .join("");
  return `<div class="card rec-card" data-disc="${i}" style="cursor:pointer">
    ${cover}${ph}
    <div class="card-overlay"></div>
    <div class="card-info">
      <div class="card-title">${escH(a.mb_title || a.orig_t)}</div>
      <div class="card-artist">${escH(a.mb_artist || a.orig_a)}</div>
      ${a.date ? `<div class="card-year">${escH(a.date.slice(0, 4))}</div>` : ""}
      <div class="rc-users">${userBadges}<span class="rc-count">${a.total} plays</span></div>
    </div>
  </div>`;
}

function renderDiscoverGrid() {
  const dg = document.getElementById("discover-grid");
  let filtered = discoverAlbums;
  if (discoverDecadeFilter.size) {
    filtered = filtered.filter((a) => {
      const yr = parseInt((a.date || "").slice(0, 4));
      if (!yr) return false;
      return discoverDecadeFilter.has(Math.floor(yr / 10) * 10);
    });
  }
  dg.innerHTML = filtered
    .map((a, i) => discoverCardHTML(a, discoverAlbums.indexOf(a)))
    .join("");
  dg.querySelectorAll("img.card-cover").forEach((img) => {
    img.addEventListener("error", () => {
      img.style.display = "none";
      if (img.nextElementSibling) img.nextElementSibling.style.display = "flex";
    });
  });
  dg.querySelectorAll(".card[data-disc]").forEach((c) => {
    c.addEventListener("click", () => {
      const idx = parseInt(c.dataset.disc);
      const entry = discoverAlbums[idx];
      if (entry?.type === "artist") {
        openDetailPanel({ type: "discover_artist", idx });
      } else if (entry?.type === "song") {
        openDetailPanel({ type: "discover_song", idx });
      } else {
        openDetailPanel({ type: "discover", idx });
      }
    });
  });
  // Update count label (element may not exist if removed from template)
  const noun =
    discoverModeType === "songs"
      ? "canciones"
      : discoverModeType === "artists"
        ? "artistas"
        : "álbumes";
  const _countEl = document.getElementById("discover-count");
  if (_countEl)
    _countEl.textContent = `${filtered.length} ${noun}${discoverCandidates.length > discoverAlbums.length ? ` de ${discoverCandidates.length} candidatos` : ""}`;
  // Decade pills
  const decades = new Set();
  discoverAlbums.forEach((a) => {
    const yr = parseInt((a.date || "").slice(0, 4));
    if (yr) decades.add(Math.floor(yr / 10) * 10);
  });
  const pillsEl = document.getElementById("discover-decade-pills");
  pillsEl.innerHTML = [...decades]
    .sort()
    .map(
      (d) =>
        `<button class="filter-pill${discoverDecadeFilter.has(d) ? " active" : ""}" data-decade="${d}">${d}s</button>`,
    )
    .join("");
  pillsEl.querySelectorAll(".filter-pill").forEach((b) => {
    b.addEventListener("click", () => {
      const d = parseInt(b.dataset.decade);
      if (discoverDecadeFilter.has(d)) discoverDecadeFilter.delete(d);
      else discoverDecadeFilter.add(d);
      renderDiscoverGrid();
    });
  });
}

function _priUser() {
  return { user: heardCache?.user || '?', count: 0, color: 'var(--ink3)', image: '', source: heardCache?.source || 'lfm' };
}

function enterDiscoverMode(userIdxs, limit = 20, mode = "albums", relMode = 'discover') {
  if (!extraUsers.length) return;
  const users = (Array.isArray(userIdxs) ? userIdxs : [userIdxs])
    .map(i => extraUsers[i]).filter(Boolean);
  if (!users.length) return;
  if ((relMode === 'share' || relMode === 'enjoy') && !heardCache) return;
  limit = Math.min(100, Math.max(1, limit));

  discoverMode      = true;
  discoverPage      = 0;
  discoverLimit     = limit;
  discoverModeType  = mode;
  discoverRelMode   = relMode;
  discoverUserIdxs  = (Array.isArray(userIdxs) ? userIdxs : [userIdxs]).filter(i => i < extraUsers.length);
  discoverAllCandidates = [];
  discoverDecadeFilter.clear();
  if (discoverEs) { discoverEs.close(); discoverEs = null; }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const primaryPairs   = heardCache ? new Set(heardCache.pairs.map(p => p[0]+"|"+p[1])) : new Set();
  const primaryArtists = heardCache ? heardCache.artist_set || new Set(heardCache.pairs.map(p => p[0])) : new Set();
  const primarySongs   = heardCache ? heardCache.song_set || new Set((heardCache.songs||[]).map(s => s[0]+"|"+s[1])) : new Set();

  // ── "ESCUCHA": secondary ∩ALL − primary ───────────────────────────────────
  if (relMode === 'discover') {
    if (mode === "artists") {
      const userAMaps = users.map(u => { const m = new Map(); for (const p of u.pairs) { if (!m.has(p[0])) m.set(p[0], { orig_a: p[2]||p[0], total: 0, album_count: 0 }); const e = m.get(p[0]); e.total += p[4]||1; e.album_count++; } return m; });
      const amap = {};
      for (const k of [...userAMaps[0].keys()].filter(k => !primaryArtists.has(k) && userAMaps.every(m => m.has(k)))) {
        amap[k] = { norm_a: k, orig_a: userAMaps[0].get(k).orig_a, orig_t: "", total: 0, album_count: 0, users: [], type: "artist" };
        users.forEach((u, i) => { const e = userAMaps[i].get(k); amap[k].total += e.total; amap[k].album_count += e.album_count; amap[k].users.push({ user: u.user, count: e.total, color: u.color, image: u.image||"", source: u.source||"lfm" }); });
      }
      discoverAllCandidates = Object.values(amap).sort((a, b) => b.total - a.total);
    } else if (mode === "songs") {
      const userSMaps = users.map(u => new Map((u.songs||[]).map(s => [s[0]+"|"+s[1], s])));
      const smap = {};
      for (const k of [...userSMaps[0].keys()].filter(k => !primarySongs.has(k) && userSMaps.every(m => m.has(k)))) {
        const s0 = userSMaps[0].get(k);
        smap[k] = { norm_a: s0[0], norm_t: s0[1], orig_a: s0[2]||s0[0], orig_album: s0[3]||"", orig_t: s0[4]||s0[1], total: 0, users: [], type: "song" };
        users.forEach((u, i) => { const s = userSMaps[i].get(k); const c = s[5]||1; smap[k].total += c; smap[k].users.push({ user: u.user, count: c, color: u.color, image: u.image||"", source: u.source||"lfm" }); });
      }
      discoverAllCandidates = Object.values(smap).sort((a, b) => b.total - a.total);
    } else {
      const userPMaps = users.map(u => new Map(u.pairs.map(p => [p[0]+"|"+p[1], p])));
      const cmap = {};
      for (const k of [...userPMaps[0].keys()].filter(k => !primaryPairs.has(k) && userPMaps.every(m => m.has(k)))) {
        const p0 = userPMaps[0].get(k);
        cmap[k] = { norm_a: p0[0], norm_t: p0[1], orig_a: p0[2]||p0[0], orig_t: p0[3]||p0[1], total: 0, users: [] };
        users.forEach((u, i) => { const p = userPMaps[i].get(k); const c = p[4]||1; cmap[k].total += c; cmap[k].users.push({ user: u.user, count: c, color: u.color, image: u.image||"", source: u.source||"lfm" }); });
      }
      discoverAllCandidates = Object.values(cmap).sort((a, b) => b.total - a.total);
    }

  // ── "COMPARTE": primary − secondary∪ANY ───────────────────────────────────
  } else if (relMode === 'share') {
    const pri = _priUser();
    if (mode === "artists") {
      const secArtistUnion = new Set(users.flatMap(u => u.pairs.map(p => p[0])));
      const amap = {};
      for (const p of heardCache.pairs) {
        if (secArtistUnion.has(p[0])) continue;
        if (!amap[p[0]]) amap[p[0]] = { norm_a: p[0], orig_a: p[2]||p[0], orig_t: "", total: 0, album_count: 0, users: [{ ...pri }], type: "artist" };
        amap[p[0]].total += p[4]||1; amap[p[0]].album_count++; amap[p[0]].users[0].count += p[4]||1;
      }
      discoverAllCandidates = Object.values(amap).sort((a, b) => b.total - a.total);
    } else if (mode === "songs") {
      const secSongUnion = new Set(users.flatMap(u => (u.songs||[]).map(s => s[0]+"|"+s[1])));
      const smap = {};
      for (const s of (heardCache.songs||[])) {
        const k = s[0]+"|"+s[1]; if (secSongUnion.has(k)) continue;
        const c = s[5]||1; smap[k] = { norm_a: s[0], norm_t: s[1], orig_a: s[2]||s[0], orig_album: s[3]||"", orig_t: s[4]||s[1], total: c, users: [{ ...pri, count: c }], type: "song" };
      }
      discoverAllCandidates = Object.values(smap).sort((a, b) => b.total - a.total);
    } else {
      const secPairUnion = new Set(users.flatMap(u => u.pairs.map(p => p[0]+"|"+p[1])));
      const cmap = {};
      for (const p of heardCache.pairs) {
        const k = p[0]+"|"+p[1]; if (secPairUnion.has(k)) continue;
        const c = p[4]||1; cmap[k] = { norm_a: p[0], norm_t: p[1], orig_a: p[2]||p[0], orig_t: p[3]||p[1], total: c, users: [{ ...pri, count: c }] };
      }
      discoverAllCandidates = Object.values(cmap).sort((a, b) => b.total - a.total);
    }

  // ── "DISFRUTA": primary ∩ secondary∩ALL ───────────────────────────────────
  } else {
    const pri = _priUser();
    if (mode === "artists") {
      const secAMaps = users.map(u => { const m = new Map(); for (const p of u.pairs) { if (!m.has(p[0])) m.set(p[0], { total: 0, album_count: 0 }); const e = m.get(p[0]); e.total += p[4]||1; e.album_count++; } return m; });
      const amap = {};
      for (const p of heardCache.pairs) {
        if (!secAMaps.every(m => m.has(p[0]))) continue;
        if (!amap[p[0]]) {
          const priEntry = { ...pri, count: 0 };
          amap[p[0]] = { norm_a: p[0], orig_a: p[2]||p[0], orig_t: "", total: 0, album_count: 0, type: "artist",
            users: [priEntry, ...users.map((u, i) => { const e = secAMaps[i].get(p[0]); return { user: u.user, count: e?.total||0, color: u.color, image: u.image||"", source: u.source||"lfm" }; })] };
        }
        amap[p[0]].total += p[4]||1; amap[p[0]].album_count++; amap[p[0]].users[0].count += p[4]||1;
      }
      discoverAllCandidates = Object.values(amap).sort((a, b) => b.total - a.total);
    } else if (mode === "songs") {
      const secSMaps = users.map(u => new Map((u.songs||[]).map(s => [s[0]+"|"+s[1], s])));
      const smap = {};
      for (const s of (heardCache.songs||[])) {
        const k = s[0]+"|"+s[1]; if (!secSMaps.every(m => m.has(k))) continue;
        const c = s[5]||1;
        smap[k] = { norm_a: s[0], norm_t: s[1], orig_a: s[2]||s[0], orig_album: s[3]||"", orig_t: s[4]||s[1], type: "song", total: c,
          users: [{ ...pri, count: c }, ...users.map((u, i) => { const ss = secSMaps[i].get(k); return { user: u.user, count: ss?.[5]||1, color: u.color, image: u.image||"", source: u.source||"lfm" }; })] };
      }
      discoverAllCandidates = Object.values(smap).sort((a, b) => b.total - a.total);
    } else {
      const secPMaps = users.map(u => new Map(u.pairs.map(p => [p[0]+"|"+p[1], p])));
      const cmap = {};
      for (const p of heardCache.pairs) {
        const k = p[0]+"|"+p[1]; if (!secPMaps.every(m => m.has(k))) continue;
        const c = p[4]||1;
        cmap[k] = { norm_a: p[0], norm_t: p[1], orig_a: p[2]||p[0], orig_t: p[3]||p[1], total: c,
          users: [{ ...pri, count: c }, ...users.map((u, i) => { const sp = secPMaps[i].get(k); return { user: u.user, count: sp?.[4]||1, color: u.color, image: u.image||"", source: u.source||"lfm" }; })] };
      }
      discoverAllCandidates = Object.values(cmap).sort((a, b) => b.total - a.total);
    }
  }

  document.getElementById("discover-view").classList.add("visible");
  const _es = document.getElementById("empty-state");
  if (_es) _es.style.display = "none";
  closeSidebar();
  _loadDiscoverPage();
}

function _applyEnrichCover(cover_url, mbid, artist, album, needed) {
  enrichCacheSet(artist, album, { cover_url, mbid: mbid || "" });
  const entry = needed[artist + "|||" + album];
  if (!entry) return;
  entry.idxs.forEach((idx) => {
    if (!discoverAlbums[idx]) return;
    discoverAlbums[idx].cover_url = cover_url;
    const card = document.querySelector(
      `#discover-grid .card[data-disc="${idx}"]`,
    );
    if (!card) return;
    let img = card.querySelector(".card-cover");
    const ph = card.querySelector(".disc-song-ph");
    if (!img) {
      img = document.createElement("img");
      img.className = "card-cover";
      img.alt = "";
      img.loading = "lazy";
      img.onerror = function () {
        this.style.display = "none";
        if (ph) ph.style.display = "flex";
      };
      card.insertBefore(img, card.firstChild);
    }
    if (ph) ph.style.display = "none";
    img.style.display = "";
    img.src = cover_url;
  });
}

async function _enrichSongCovers() {
  const myGen = discoverGeneration;
  const needed = {};
  discoverAlbums.forEach((a, i) => {
    if (a.type !== "song" || a.cover_url || !a.orig_album) return;
    const k = (a.orig_a || "") + "|||" + (a.orig_album || "");
    if (!needed[k])
      needed[k] = { orig_a: a.orig_a, orig_album: a.orig_album, idxs: [] };
    needed[k].idxs.push(i);
  });
  const pairs = Object.values(needed);
  if (!pairs.length) return;

  for (const { orig_a: artist, orig_album: album } of pairs) {
    if (discoverGeneration !== myGen) return;
    let cover_url = "",
      mbid = "";
    try {
      const lfm = await lfmGet("album.getInfo", {
        artist,
        album,
        autocorrect: 1,
      });
      const al = lfm.album || {};
      const lfmImg = _lfmBestImg(al.image);
      const lfmMbid = (al.mbid || "").trim();
      if (lfmImg) cover_url = lfmImg;
      else if (lfmMbid)
        cover_url = `https://coverartarchive.org/release/${lfmMbid}/front-500`;
    } catch (e) {}

    if (discoverGeneration !== myGen) return;

    if (!cover_url) {
      try {
        const mb = await mbSearchRelGroup(artist, album);
        if (mb.mbid) {
          mbid = mb.mbid;
          cover_url = `https://coverartarchive.org/release-group/${mbid}/front-500`;
        }
      } catch (e) {}
    }

    if (cover_url && discoverGeneration === myGen)
      _applyEnrichCover(cover_url, mbid, artist, album, needed);
  }
}

function _loadDiscoverPage() {
  discoverAlbums = [];
  discoverOffset = 0;
  discoverSearching = false;
  discoverDecadeFilter.clear();
  ++discoverGeneration;
  if (discoverEs) {
    discoverEs.close();
    discoverEs = null;
  }

  discoverCandidates = discoverAllCandidates.slice(
    discoverPage * discoverLimit,
    (discoverPage + 1) * discoverLimit,
  );

  _updateDiscoverPagination();

  // Display name: first selected user, or "N usuarios" for intersection
  const u0 = extraUsers[discoverUserIdxs[0]];
  const uName = discoverUserIdxs.length > 1
    ? escH(discoverUserIdxs.map(i => extraUsers[i]?.user || '').join(' + '))
    : (u0 ? escH(u0.user) : '?');

  if (!discoverCandidates.length) {
    document.getElementById("discover-progress").textContent =
      discoverUserIdxs.length > 1
        ? { discover: "Sin álbumes en común entre los seleccionados", share: "Todo está en común", enjoy: "Sin álbumes compartidos" }[discoverRelMode] || "Sin candidatos"
        : "Sin candidatos para este usuario";
    document.getElementById("discover-footer").style.display = "";
    renderDiscoverGrid();
    return;
  }

  if (discoverModeType === "artists") {
    discoverAlbums = discoverCandidates.map(c => ({
      ...c, mb_artist: c.orig_a, mb_title: "", cover_url: "", date: "", mbid: "",
    }));
    renderDiscoverGrid();
    document.getElementById("discover-footer").style.display = "";
    document.getElementById("discover-progress").textContent =
      `${discoverAlbums.length} artistas · ${uName} (pág. ${discoverPage + 1})`;

    // Artist images: sequential client-side LFM calls with cancellation
    const myGen = discoverGeneration;
    (async () => {
      const u2 = extraUsers[discoverUserIdxs[0]];
      for (let i = 0; i < discoverAlbums.length; i++) {
        if (discoverGeneration !== myGen) break;
        const a = discoverAlbums[i];
        // 1. Enrich cache
        const hit = enrichCacheGet(a.orig_a, "");
        if (hit?.cover_url) { _applyArtistCover(i, hit.cover_url); continue; }
        // 2. Album cover from this artist in enrich cache
        let found = false;
        if (u2) {
          for (const p of u2.pairs) {
            if (p[0] !== a.norm_a) continue;
            const albumHit = enrichCacheGet(p[2] || p[0], p[3] || p[1]);
            if (albumHit?.cover_url) {
              enrichCacheSet(a.orig_a, "", { cover_url: albumHit.cover_url });
              _applyArtistCover(i, albumHit.cover_url);
              found = true; break;
            }
          }
        }
        if (found) continue;
        // 3. LFM artist.getInfo (client-side, no shared rate limit)
        try {
          const data = await lfmGet('artist.getInfo', { artist: a.orig_a, autocorrect: 1 });
          const imgUrl = _lfmBestImg(data.artist?.image);
          if (imgUrl && discoverGeneration === myGen) {
            discoverAlbums[i].cover_url = imgUrl;
            enrichCacheSet(a.orig_a, "", { cover_url: imgUrl });
            _applyArtistCover(i, imgUrl);
          }
        } catch(e) {}
      }
    })();

  } else if (discoverModeType === "songs") {
    discoverAlbums = discoverCandidates.map(c => {
      const entry = { ...c };
      if (!entry.cover_url && entry.orig_album) {
        const hit = enrichCacheGet(entry.orig_a, entry.orig_album);
        if (hit?.cover_url) entry.cover_url = hit.cover_url;
      }
      return entry;
    });
    renderDiscoverGrid();
    document.getElementById("discover-footer").style.display = "";
    document.getElementById("discover-progress").textContent =
      `${discoverAlbums.length} canciones · ${uName} (pág. ${discoverPage + 1})`;
    _enrichSongCovers();
  } else {
    document.getElementById("discover-footer").style.display = "";
    document.getElementById("discover-progress").textContent =
      `Buscando ${discoverCandidates.length} álbumes · ${uName}…`;
    loadMoreDiscover();
  }
}

function _updateDiscoverPagination() {
  const total = discoverAllCandidates.length;
  const maxPage = Math.ceil(total / discoverLimit) - 1;
  const pag = document.getElementById("discover-pagination");
  pag.style.display = total > discoverLimit ? "" : "none";
  document.getElementById("disc-prev").disabled = discoverPage <= 0;
  document.getElementById("disc-next").disabled = discoverPage >= maxPage;
  const from = discoverPage * discoverLimit + 1;
  const to = Math.min((discoverPage + 1) * discoverLimit, total);
  document.getElementById("disc-page-info").textContent =
    `${from}–${to} de ${total}`;
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
  if (discoverEs) {
    discoverEs.close();
    discoverEs = null;
  }
  document.getElementById("discover-view").classList.remove("visible");
  const _es2 = document.getElementById("empty-state");
  if (_es2) _es2.style.display = "";
}

async function loadMoreDiscover() {
  if (discoverSearching) return;
  const batch = discoverCandidates.slice(discoverOffset);
  if (!batch.length) {
    document.getElementById("discover-progress").textContent =
      "✓ No hay más candidatos";
    return;
  }

  discoverSearching = true;
  const prog = document.getElementById("discover-progress");
  document.getElementById("discover-footer").style.display = "";

  const startIdx = discoverAlbums.length;
  const uncachedJs = [];

  batch.forEach((c, j) => {
    const hit = enrichCacheGet(c.orig_a, c.orig_t);
    discoverAlbums.push({
      ...c,
      mbid: hit?.mbid || "",
      cover_url: hit?.cover_url || "",
      mb_title: hit?.mb_title || c.orig_t,
      mb_artist: hit?.mb_artist || c.orig_a,
      date: hit?.date || "",
    });
    if (!hit) uncachedJs.push(j);
  });
  renderDiscoverGrid();

  if (!uncachedJs.length) {
    discoverOffset += batch.length;
    discoverSearching = false;
    prog.textContent = `✓ ${discoverAlbums.length} álbumes`;
    return;
  }

  prog.textContent = `Consultando… (0 / ${uncachedJs.length})`;

  const myGen = discoverGeneration;

  for (let i = 0; i < uncachedJs.length; i++) {
    if (discoverGeneration !== myGen) return;
    const j = uncachedJs[i];
    const c = batch[j];
    const aIdx = startIdx + j;
    const artist = c.orig_a,
      album = c.orig_t;

    let cover_url = "",
      mbid = "",
      mb_title = album,
      mb_artist = artist,
      date = "";

    try {
      const lfm = await lfmGet("album.getInfo", {
        artist,
        album,
        autocorrect: 1,
      });
      const al = lfm.album || {};
      const lfmImg = _lfmBestImg(al.image);
      const lfmMbid = (al.mbid || "").trim();
      mb_title = al.name || album;
      mb_artist =
        (typeof al.artist === "object" ? al.artist.name : al.artist) || artist;
      if (lfmImg) cover_url = lfmImg;
      else if (lfmMbid)
        cover_url = `https://coverartarchive.org/release/${lfmMbid}/front-500`;
    } catch (e) {}

    if (discoverGeneration !== myGen) return;

    if (!cover_url) {
      try {
        const mb = await mbSearchRelGroup(artist, album);
        if (mb.mbid) {
          mbid = mb.mbid;
          mb_title = mb.title || mb_title;
          mb_artist = mb.artist || mb_artist;
          date = mb.date || "";
          cover_url = `https://coverartarchive.org/release-group/${mbid}/front-500`;
        }
      } catch (e) {}
    }

    if (discoverGeneration !== myGen) return;

    if (discoverAlbums[aIdx]) {
      const enriched = { mbid, cover_url, mb_title, mb_artist, date };
      Object.assign(discoverAlbums[aIdx], enriched);
      enrichCacheSet(artist, album, enriched);
      _patchDiscoverCard(aIdx, discoverAlbums[aIdx]);
    }
    prog.textContent = `Buscando… (${i + 1} / ${uncachedJs.length})`;
  }

  if (discoverGeneration === myGen) {
    discoverOffset += batch.length;
    prog.textContent = `✓ ${discoverAlbums.length} álbumes encontrados`;
  }
  discoverSearching = false;
}

document.querySelectorAll(".filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".filter-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeFilter = btn.dataset.filter;
  });
});

// ── Enrich cache ─────────────────────────────────────────────────────────
// Key: "artist|||title" (title='' for artist-mode entries)
// Value: {cover_url, mbid?, mb_title?, mb_artist?, date?}
const ENRICH_CACHE_KEY = "enrich_cache_v1";
function enrichCacheGet(artist, title) {
  try {
    const c = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || "{}");
    return c[artist + "|||" + title] || null;
  } catch (e) {
    return null;
  }
}
function enrichCacheSet(artist, title, data) {
  if (!data?.cover_url) return;
  try {
    const c = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || "{}");
    c[artist + "|||" + title] = data;
    localStorage.setItem(ENRICH_CACHE_KEY, JSON.stringify(c));
  } catch (e) {}
}

// ── YouTube cache & embed ─────────────────────────────────────────────────
const YT_CACHE_KEY = "yt_ids_v1";
function ytCacheGet(artist, album) {
  try {
    const c = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || "{}");
    const v = c[artist + "|||" + album];
    return v !== undefined ? v : null;
  } catch (e) {
    return null;
  }
}
function ytCacheSet(artist, album, videoId) {
  try {
    const c = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || "{}");
    c[artist + "|||" + album] = videoId;
    localStorage.setItem(YT_CACHE_KEY, JSON.stringify(c));
  } catch (e) {}
}
function embedYT(videoId) {
  const ytDiv = document.getElementById("dp-yt");
  if (!videoId) {
    ytDiv.style.display = "none";
    ytDiv.innerHTML = "";
    return;
  }
  ytDiv.style.display = "";
  ytDiv.innerHTML = `<iframe src="https://www.youtube.com/embed/${escH(videoId)}?rel=0"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowfullscreen></iframe>`;
  // Swap "Buscar YouTube" search link → direct watch link
  const linksEl = document.getElementById("dp-links");
  const searchA = linksEl.querySelector('a[href*="results?search_query"]');
  if (searchA) {
    searchA.href = `https://www.youtube.com/watch?v=${escH(videoId)}`;
    searchA.textContent = "YouTube ↗";
  } else if (!linksEl.querySelector('a[href*="watch?v="]')) {
    linksEl.insertAdjacentHTML(
      "beforeend",
      `<a class="dp-link" href="https://www.youtube.com/watch?v=${escH(videoId)}" target="_blank">YouTube ↗</a>`,
    );
  }
}
async function fetchAndEmbedYT(artist, album) {
  if (!artist || !album) return;
  const cached = ytCacheGet(artist, album);
  if (cached !== null) {
    embedYT(cached);
    return;
  }
  try {
    const r = await fetch(
      `/api/yt_search?${new URLSearchParams({ artist, album })}`,
    );
    if (!r.ok) return;
    const data = await r.json();
    if (typeof data.videoId === "string") {
      ytCacheSet(artist, album, data.videoId);
      embedYT(data.videoId);
    }
  } catch (e) {}
}

// ── Modal ──────────────────────────────────────────────────────────────────
// ── Detail side panel ──────────────────────────────────────────────────────
function openDetailPanel(ref) {
  // ref: {type:'discover'|'discover_artist'|'discover_song', idx}
  let title, artist, year, cover, mbid, yt_id, heard, extraHeard, descCached;
  if (ref.type === "discover_artist") {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.orig_a;
    artist = a.orig_a;
    year = "";
    cover = a.cover_url || "";
    mbid = "";
    yt_id = "";
    heard = false;
    extraHeard = null;
    descCached = "";
    // title kept as artist name for display; album passed as '' to fetchAlbumInfo
  } else if (ref.type === "discover_song") {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.orig_t;
    artist = a.orig_a;
    year = "";
    const _songHit = a.orig_album
      ? enrichCacheGet(a.orig_a, a.orig_album)
      : null;
    cover = a.cover_url || _songHit?.cover_url || "";
    mbid = "";
    yt_id = "";
    heard = false;
    extraHeard = null;
    descCached = "";
  } else {
    const a = discoverAlbums[ref.idx];
    if (!a) return;
    title = a.mb_title || a.orig_t;
    artist = a.mb_artist || a.orig_a;
    year = a.date ? a.date.slice(0, 4) : "";
    cover = a.cover_url;
    mbid = a.mbid;
    yt_id = "";
    heard = false;
    extraHeard = null;
    descCached = "";
  }

  // Reset panel
  const panel = document.getElementById("detail-panel");
  document.getElementById("dp-loading").style.display = "none";
  document.getElementById("dp-stats").style.display = "none";
  document.getElementById("dp-tags").innerHTML = "";
  document.getElementById("dp-yt").style.display = "none";
  document.getElementById("dp-yt").innerHTML = "";
  document.getElementById("dp-album-wiki").style.display = "none";
  document.getElementById("dp-artist-bio").style.display = "none";
  document.getElementById("dp-links").innerHTML = "";

  // Cover
  const dpCover = document.getElementById("dp-cover");
  if (cover) {
    dpCover.src = cover;
    dpCover.style.display = "";
  } else {
    dpCover.src = "";
    dpCover.style.display = "none";
  }

  document.getElementById("dp-title").textContent = title || "";
  document.getElementById("dp-artist").textContent = artist || "";
  document.getElementById("dp-year").textContent = year || "";

  // Status not shown for discover entries
  document.getElementById("dp-status").style.display = "none";

  // Extra users status
  const extraSt = document.getElementById("dp-extra-status");
  if (false) {
    // collection extra-status not used in app_discover
    extraSt.innerHTML = extraUsers
      .map((u, i) => {
        const h = extraHeard[i];
        const icon = _avatarHtml(u.user, u.image || "", 14, u.color, u.source || "lfm");
        return `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${h ? u.color : "var(--ink3)"}">
        ${icon} ${escH(u.user)}: ${h ? "✓" : "—"}</span>`;
      })
      .join("");
    extraSt.style.display = "flex";
  } else if (
    ["discover", "discover_artist", "discover_song"].includes(ref.type)
  ) {
    const a = discoverAlbums[ref.idx];
    if (a?.users?.length) {
      const extraLabel =
        ref.type === "discover_artist"
          ? a.users.map((u) => `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${u.color}">
            ${_avatarHtml(u.user, u.image || "", 14, u.color, u.source || "lfm")}
            ${escH(u.user)}: ${a.total} plays · ${a.album_count} álbum${a.album_count !== 1 ? "es" : ""}</span>`)
          : a.users.map((u) => `<span style="display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:0.62rem;color:${u.color}">
            ${_avatarHtml(u.user, u.image || "", 14, u.color, u.source || "lfm")}
            ${escH(u.user)}: ${u.count} plays</span>`);
      extraSt.innerHTML = extraLabel.join("");
      extraSt.style.display = "flex";
    } else {
      extraSt.innerHTML = "";
      extraSt.style.display = "none";
    }
  } else {
    extraSt.innerHTML = "";
    extraSt.style.display = "none";
  }

  // YouTube
  if (yt_id) {
    const ytDiv = document.getElementById("dp-yt");
    ytDiv.style.display = "";
    ytDiv.innerHTML = `<iframe src="https://www.youtube.com/embed/${escH(yt_id)}?rel=0"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowfullscreen></iframe>`;
  }

  // Cached description
  if (descCached) {
    document.getElementById("dp-wiki-text").textContent = descCached;
    document.getElementById("dp-album-wiki").style.display = "";
  }

  // Links
  const links = [];
  if (mbid)
    links.push(
      `<a class="dp-link" href="https://musicbrainz.org/release-group/${mbid}" target="_blank">MusicBrainz</a>`,
    );
  if (artist && title) {
    const ytQ = encodeURIComponent(`${artist} ${title}`);
    links.push(
      `<a class="dp-link" href="https://www.youtube.com/results?search_query=${ytQ}" target="_blank">Buscar YouTube ↗</a>`,
    );
  }
  document.getElementById("dp-links").innerHTML = links.join("");

  // Open
  document.getElementById("detail-overlay").classList.add("open");
  panel.classList.add("open");
  document.body.style.overflow = "hidden";

  // Fetch LFM + MB info asynchronously
  // discover_artist: album=''; discover_song: use orig_album if available; discover: full album name
  let fetchAlbum;
  if (ref.type === "discover_artist") {
    fetchAlbum = "";
  } else if (ref.type === "discover_song") {
    fetchAlbum = discoverAlbums[ref.idx]?.orig_album || "";
  } else {
    fetchAlbum = title || "";
  }
  fetchAlbumInfo(artist || "", fetchAlbum, mbid || "");

  // Fetch YouTube embed for album and song entries
  if ((ref.type === "discover" || ref.type === "discover_song") && title) {
    fetchAndEmbedYT(artist, title);
  }
}

function closeDetailPanel() {
  document.getElementById("dp-yt").innerHTML = "";
  document.getElementById("dp-yt").style.display = "none";
  document.getElementById("detail-overlay").classList.remove("open");
  document.getElementById("detail-panel").classList.remove("open");
  document.body.style.overflow = "";
}

document
  .getElementById("detail-overlay")
  .addEventListener("click", closeDetailPanel);
document.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    document.getElementById("detail-panel").classList.contains("open")
  )
    closeDetailPanel();
});

function _applyAlbumInfoToPanel(data, artist) {
  const dpCover = document.getElementById("dp-cover");
  const coverMissing =
    !dpCover.src ||
    dpCover.src.endsWith("undefined") ||
    dpCover.style.display === "none";

  // Cover priority: MBID → Last.fm artist image (never both — avoids NS_BINDING_ABORTED)
  if (data.cover_url && coverMissing) {
    dpCover.src = data.cover_url;
    dpCover.style.display = "";
  } else if (data.artist?.image && coverMissing) {
    dpCover.src = data.artist.image;
    dpCover.style.display = "";
  }

  // Stats — album listeners first, fall back to artist listeners
  const listeners = data.lfm?.listeners || data.artist?.listeners || "";
  const playcount = data.lfm?.playcount || "";
  if (listeners || playcount) {
    const s = document.getElementById("dp-stats");
    s.innerHTML =
      (listeners
        ? `<span><b>${parseInt(listeners || 0).toLocaleString()}</b> oyentes</span>`
        : "") +
      (playcount
        ? `<span><b>${parseInt(playcount || 0).toLocaleString()}</b> plays globales</span>`
        : "");
    s.style.display = "flex";
  }

  // Tags
  if (data.lfm?.tags?.length) {
    document.getElementById("dp-tags").innerHTML = data.lfm.tags
      .map((t) => `<span class="dp-tag">${escH(t)}</span>`)
      .join("");
  }

  // Album wiki
  if (data.lfm?.wiki) {
    document.getElementById("dp-wiki-text").textContent = data.lfm.wiki;
    document.getElementById("dp-album-wiki").style.display = "";
  }

  // Artist bio
  if (data.artist?.bio) {
    document.getElementById("dp-artist-bio-title").textContent = artist;
    document.getElementById("dp-bio-text").textContent = data.artist.bio;
    document.getElementById("dp-artist-bio").style.display = "";
  }

  // Update links if we got a new MBID
  const linksEl = document.getElementById("dp-links");
  if (data.mbid && !linksEl.innerHTML.includes("musicbrainz")) {
    linksEl.innerHTML =
      `<a class="dp-link" href="https://musicbrainz.org/release-group/${data.mbid}" target="_blank">MusicBrainz</a>` +
      linksEl.innerHTML;
  }
  // Last.fm album link
  if (data.lfm?.url && !linksEl.innerHTML.includes("last.fm")) {
    linksEl.insertAdjacentHTML(
      "beforeend",
      `<a class="dp-link" href="${escH(data.lfm.url)}" target="_blank">Last.fm álbum</a>`,
    );
  }
  // Last.fm artist link
  if (data.artist?.url && !linksEl.innerHTML.includes("Last.fm artista")) {
    linksEl.insertAdjacentHTML(
      "beforeend",
      `<a class="dp-link" href="${escH(data.artist.url)}" target="_blank">Last.fm artista</a>`,
    );
  }
}

async function fetchAlbumInfo(artist, album, mbid) {
  const loading = document.getElementById("dp-loading");
  loading.style.display = "";
  const cacheKey = `${artist}|||${album}`;
  try {
    if (albumInfoCache.has(cacheKey)) {
      _applyAlbumInfoToPanel(albumInfoCache.get(cacheKey), artist);
      loading.style.display = "none";
      return;
    }
    const result = {};

    // LFM album.getInfo
    try {
      const alData = await lfmGet("album.getInfo", {
        artist,
        album,
        autocorrect: 1,
      });
      if (alData.album) {
        const al = alData.album;
        const tags = [].concat(al.tags?.tag || []);
        result.lfm = {
          listeners: al.listeners || "",
          playcount: al.playcount || "",
          tags: tags.slice(0, 6).map((t) => t.name || t),
          wiki: (al.wiki?.summary || "").split("<a ")[0].trim(),
          image: _lfmBestImg(al.image),
          url: al.url || "",
        };
        if (!mbid && al.mbid) mbid = al.mbid;
      }
    } catch (e) {}

    // LFM artist.getInfo
    try {
      const arData = await lfmGet("artist.getInfo", { artist, autocorrect: 1 });
      if (arData.artist) {
        const ar = arData.artist;
        result.artist = {
          bio: (ar.bio?.summary || "").split("<a ")[0].trim(),
          listeners: ar.stats?.listeners || "",
          image: _lfmBestImg(ar.image),
          url: ar.url || "",
        };
      }
    } catch (e) {}

    // MusicBrainz: only if no mbid and there's an album name
    if (!mbid && album) {
      try {
        const mb = await mbSearchRelGroup(artist, album);
        if (mb.mbid) {
          mbid = mb.mbid;
          Object.assign(result, {
            mbid,
            mb_title: mb.title,
            mb_artist: mb.artist,
            date: mb.date,
            cover_url: `https://coverartarchive.org/release-group/${mbid}/front-500`,
          });
        }
      } catch (e) {}
    } else if (mbid) {
      result.mbid = mbid;
      result.cover_url = `https://coverartarchive.org/release-group/${mbid}/front-500`;
    }

    albumInfoCache.set(cacheKey, result);
    _applyAlbumInfoToPanel(result, artist);
  } catch (e) {}
  loading.style.display = "none";
}

// ── Artist cover: apply to card via background-image (most reliable approach) ──
function _applyArtistCover(idx, url) {
  if (!url) return;
  discoverAlbums[idx] = discoverAlbums[idx] || {};
  discoverAlbums[idx].cover_url = url;
  const card = document.querySelector(
    `#discover-grid .card[data-disc="${idx}"]`,
  );
  if (!card) return;
  // Use background-image directly on the card — avoids all img display/src timing issues
  card.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
  card.style.backgroundSize = "cover";
  card.style.backgroundPosition = "center";
  // Hide the person icon placeholder
  const icon = card.querySelector(".disc-artist-icon");
  if (icon) icon.style.display = "none";
  // Hide the dummy img if present
  const img = card.querySelector(".disc-artist-img");
  if (img) img.style.display = "none";
}

// ── _patchDiscoverCard: update single card without re-render ───────────────
function _patchDiscoverCard(idx, a) {
  const card = document.querySelector(
    `#discover-grid .card[data-disc="${idx}"]`,
  );
  if (!card) return;
  if (a.cover_url) {
    let img = card.querySelector(".card-cover");
    const ph = card.querySelector(".card-placeholder");
    const artistIcon = card.querySelector(".disc-artist-icon");
    if (!img) {
      img = document.createElement("img");
      img.className = "card-cover";
      img.alt = "";
      card.insertBefore(img, card.firstChild);
    }
    if (img.src !== a.cover_url) {
      img.onerror = function () {
        this.style.display = "none";
        if (ph) ph.style.display = "flex";
        if (artistIcon) artistIcon.style.display = "flex";
      };
      if (ph) ph.style.display = "none";
      if (artistIcon) artistIcon.style.display = "none";
      img.style.display = ""; // visible BEFORE src to avoid hidden-element load suppression
      img.src = a.cover_url;
    }
  }
  const titleEl = card.querySelector(".card-title");
  const artistEl = card.querySelector(".card-artist");
  if (titleEl && a.mb_title) titleEl.textContent = a.mb_title;
  if (artistEl && a.mb_artist) artistEl.textContent = a.mb_artist;
  if (a.date) {
    let yearEl = card.querySelector(".card-year");
    if (!yearEl) {
      yearEl = document.createElement("div");
      yearEl.className = "card-year";
      const rcUsers = card.querySelector(".rc-users");
      const info = card.querySelector(".card-info");
      if (info && rcUsers) info.insertBefore(yearEl, rcUsers);
      else if (info) info.appendChild(yearEl);
    }
    yearEl.textContent = a.date.slice(0, 4);
  }
}

// ── Sidebar USUARIOS panel ────────────────────────────────────────────────
// renderSbUsersList was the old sidebar renderer — now just an alias so old call sites work
async function renderSbUsersList() {
  return renderSecondaryUsers();
}

async function sbSyncPrimary() {
  if (!heardCache) return;
  const prog = document.getElementById("um-extra-progress");
  if (prog) prog.textContent = "Sincronizando...";
  try {
    {
      const data = await syncSinceClient(
        heardCache.user,
        heardCache.fetched_at || 0,
        heardCache.source || "lfm",
      );
      if (data.error) throw new Error(data.error);
      const existing = new Set(heardCache.pairs.map((p) => p[0] + "|" + p[1]));
      const added = (data.new_pairs || []).filter(
        (p) => !existing.has(p[0] + "|" + p[1]),
      );
      heardCache.pairs = [...heardCache.pairs, ...added];
      heardCache.count = heardCache.pairs.length;
      heardCache.fetched_at = data.fetched_at;
      if (
        data.last_scrobble_ts &&
        data.last_scrobble_ts > (heardCache.last_scrobble_ts || 0)
      ) {
        heardCache.last_scrobble_ts = data.last_scrobble_ts;
        heardCache.last_scrobble_artist = data.last_scrobble_artist || "";
        heardCache.last_scrobble_track = data.last_scrobble_track || "";
      }
      showUserBadge(
        heardCache.user,
        document.getElementById("badge-avatar")?.src || "",
        heardCache.count,
        heardCache.last_scrobble_ts,
        heardCache.last_scrobble_artist,
        heardCache.last_scrobble_track,
      );
      if (prog)
        prog.textContent = added.length
          ? `✓ +${added.length} nuevos`
          : "✓ Al día";
      await renderSecondaryUsers();
    }
  } catch (e) {
    if (prog) prog.textContent = "Error: " + e.message;
  }
}

function sbSavePrimaryJson() {
  if (!heardCache) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || "{}");
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || "{}");
  const blob = new Blob(
    [
      JSON.stringify(
        {
          version: 1,
          user: heardCache.user,
          count: heardCache.count,
          fetched_at: heardCache.fetched_at,
          heard: heardCache.pairs,
          songs: heardCache.songs || [],
          yt_ids,
          covers,
        },
        null,
        0,
      ),
    ],
    { type: "application/json" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${heardCache.user}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function idbExportAll() {
  const sessions = await idbList();
  if (!sessions.length) return;
  const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || "{}");
  const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || "{}");
  const blob = new Blob(
    [
      JSON.stringify(
        { version: 1, exported_at: Date.now(), sessions, yt_ids, covers },
        null,
        0,
      ),
    ],
    { type: "application/json" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function showCacheNotice() {
  const notice = document.getElementById("sb-cache-notice");
  if (!notice || notice.dataset.shown) return;
  const sessions = await idbList();
  const secondarySessions = sessions.filter(
    (s) => s.user.toLowerCase() !== (heardCache?.user || "").toLowerCase(),
  );
  if (!secondarySessions.length) return;
  const oldest = secondarySessions.sort(
    (a, b) => a.fetched_at - b.fetched_at,
  )[0];
  const oldestDate = oldest
    ? new Date(oldest.fetched_at * 1000).toLocaleDateString()
    : "";
  let storageInfo = "";
  if (navigator.storage?.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const pct = Math.round((usage / quota) * 100);
      const usedMB = (usage / 1048576).toFixed(0);
      storageInfo = ` (almacenamiento: ${pct}%, ${usedMB} MB usados)`;
    } catch {}
  }
  notice.dataset.shown = "1";
  notice.style.display = "";
  notice.innerHTML = `
    <b>⚠ Aviso de caché</b>${storageInfo}<br>
    Tienes <b>${secondarySessions.length}</b> usuario${secondarySessions.length > 1 ? "s" : ""} secundario${secondarySessions.length > 1 ? "s" : ""} guardado${secondarySessions.length > 1 ? "s" : ""}.
    Si se agota el espacio del navegador al añadir uno nuevo, el más antiguo
    (<b>${escH(oldest?.user || "")}</b>, descargado el ${oldestDate}) podría eliminarse automáticamente.
    <b>Se recomienda hacer una copia de seguridad antes de continuar.</b>
    <div class="notice-btns">
      <button class="btn-sm" data-action="export">↓ Exportar todo (backup)</button>
      <button class="btn-sm" data-action="close-notice">✕ Cerrar</button>
    </div>`;
}

// ── UI helpers ─────────────────────────────────────────────────────────────
function showLoading(msg) {
  loadTxt.textContent = msg || "Cargando...";
  loading.classList.add("visible");
}
function hideLoading() {
  loading.classList.remove("visible");
}
function showError(msg) {
  errMsg.textContent = msg;
  errMsg.classList.add("visible");
}
function hideError() {
  errMsg.classList.remove("visible");
}
function hideResults() {
  heardCache = null;
  loadedUser = null;
}
function escH(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── IndexedDB ─────────────────────────────────────────────────────────────
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) =>
      e.target.result.createObjectStore(IDB_STORE, { keyPath: "user" });
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
async function idbSave(data) {
  const db = await openIDB();
  const _put = (payload) =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put({
        ...payload,
        user: payload.user.toLowerCase(),
      });
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  try {
    await _put(data);
    return null;
  } catch (e) {
    if (e.name === "QuotaExceededError") return { quota: true };
    throw e;
  }
}
async function idbLoad(username) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(IDB_STORE, "readonly")
      .objectStore(IDB_STORE)
      .get(username.toLowerCase());
    req.onsuccess = (e) => resolve(e.target.result || null);
    req.onerror = (e) => reject(e.target.error);
  });
}
async function idbList() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db
      .transaction(IDB_STORE, "readonly")
      .objectStore(IDB_STORE)
      .getAll();
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
async function idbDelete(username) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(username.toLowerCase());
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ── Quota exceeded modal ─────────────────────────────────────────────────
let _quotaExportPending = null;

async function showQuotaModal(username, inMemoryData) {
  _quotaExportPending = inMemoryData;

  let sessions = [];
  try { sessions = await idbList(); } catch (_) {}

  const approxSize = (s) => {
    const bytes = ((s.heard?.length || s.count || 0) + (s.songs?.length || 0)) * 22;
    return bytes > 1048576
      ? `~${(bytes / 1048576).toFixed(1)} MB`
      : `~${Math.max(1, Math.round(bytes / 1024))} KB`;
  };

  const others = sessions
    .filter((s) => s.user.toLowerCase() !== username.toLowerCase())
    .sort((a, b) => (b.count || 0) - (a.count || 0));

  let usageHtml = "";
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      const usedMB = (est.usage / 1048576).toFixed(1);
      const quotaMB = (est.quota / 1048576).toFixed(0);
      usageHtml = `<div class="quota-usage">Uso actual: <b>${usedMB} MB</b> de <b>${quotaMB} MB</b></div>`;
    } catch (_) {}
  }

  const sessionRows = others
    .map((s) => {
      const sid = "qsr-" + s.user.toLowerCase().replace(/[^a-z0-9]/g, "");
      return `<div class="quota-session-row" id="${sid}">
        <span class="quota-sname">${escH(s.user)}</span>
        <span class="quota-ssize">${approxSize(s)}</span>
        <button class="btn-sm quota-del" data-user="${escH(s.user)}">Eliminar</button>
      </div>`;
    })
    .join("");

  let modal = document.getElementById("quota-modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "quota-modal";
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="quota-box">
    <h3>Sin espacio en el navegador</h3>
    <p>Los datos de <b>${escH(username)}</b> están cargados en memoria y puedes usarlos esta sesión, pero el navegador no tiene espacio para guardarlos de forma permanente.</p>
    ${usageHtml}
    <div class="quota-actions">
      <button class="btn" id="quota-export-btn">↓ Exportar JSON</button>
      <button class="btn" id="quota-persist-btn">Pedir almacenamiento persistente</button>
    </div>
    ${others.length
      ? `<div class="quota-sessions-label">Elimina una sesión para liberar espacio:</div>
         <div class="quota-sessions">${sessionRows}</div>`
      : ""}
    <div class="quota-tip">Para aumentar la cuota en Chrome: <em>Configuración → Privacidad → Configuración de sitios → Almacenamiento</em>. En Firefox, el botón de arriba suele ser suficiente.</div>
    <button class="btn-sm" id="quota-close-btn" style="margin-top:.3rem">Cerrar</button>
  </div>`;
  modal.classList.add("open");
  document.body.style.overflow = "hidden";

  modal.querySelector("#quota-close-btn").onclick = () => {
    modal.classList.remove("open");
    document.body.style.overflow = "";
  };
  modal.onclick = (e) => {
    if (e.target === modal) { modal.classList.remove("open"); document.body.style.overflow = ""; }
  };
  modal.querySelector("#quota-export-btn").onclick = () => {
    const d = _quotaExportPending;
    if (!d) return;
    const blob = new Blob(
      [JSON.stringify({ version: 1, user: d.user, count: d.heard?.length || 0, fetched_at: d.fetched_at || 0, heard: d.heard || [], songs: d.songs || [] }, null, 0)],
      { type: "application/json" }
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tumtumpa_${d.user}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  modal.querySelector("#quota-persist-btn").onclick = async () => {
    const btn = modal.querySelector("#quota-persist-btn");
    if (!navigator.storage?.persist) { btn.textContent = "No soportado en este navegador"; return; }
    const ok = await navigator.storage.persist();
    btn.textContent = ok ? "✓ Activado — intenta guardar de nuevo" : "El navegador no concedió permiso";
  };
  modal.querySelectorAll(".quota-del").forEach((btn) => {
    btn.onclick = async () => {
      const user = btn.dataset.user;
      await idbDelete(user);
      const sid = "qsr-" + user.toLowerCase().replace(/[^a-z0-9]/g, "");
      document.getElementById(sid)?.remove();
    };
  });
}

async function idbSaveOrModal(data) {
  const r = await idbSave(data);
  if (r?.quota) showQuotaModal(data.user, data);
}

function _exportMemoryUser(username) {
  const lc = username.toLowerCase();
  const eu = extraUsers.find((u) => u.user.toLowerCase() === lc);
  const src = eu || _sessionCache.get(lc);
  if (!src?.pairs?.length) return;
  const blob = new Blob(
    [JSON.stringify({ version: 1, user: src.user || username, count: src.pairs.length, fetched_at: src.fetched_at || 0, heard: src.pairs, songs: src.songs || [] }, null, 0)],
    { type: "application/json" },
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tumtumpa_${username}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Unified secondary users list ─────────────────────────────────────────
async function renderSecondaryUsers() {
  const sessions = await idbList();
  const el = document.getElementById("secondary-users-list");
  if (!el) return;
  const primaryUser = heardCache?.user?.toLowerCase();

  // Sort: primary first, then rest by date
  const sorted = sessions.slice().sort((a, b) => {
    const aIsPrim = a.user.toLowerCase() === primaryUser;
    const bIsPrim = b.user.toLowerCase() === primaryUser;
    if (aIsPrim && !bIsPrim) return -1;
    if (!aIsPrim && bIsPrim) return 1;
    return b.fetched_at - a.fetched_at;
  });

  // Memory-only users: active but not in IDB
  const idbSet = new Set(sorted.map((s) => s.user.toLowerCase()));
  const memOnly = extraUsers.filter(
    (u) => u.user.toLowerCase() !== primaryUser && !idbSet.has(u.user.toLowerCase()),
  );

  // Image lookup from localStorage for inactive users
  let _savedImageMap = {};
  try {
    const _saved = JSON.parse(localStorage.getItem("ml_extra_users") || "[]");
    for (const _u of _saved) { if (_u.user && _u.image) _savedImageMap[_u.user.toLowerCase()] = _u.image; }
  } catch (_) {}

  const _renderIdbRow = (s) => {
    const lc = s.user.toLowerCase();
    const isPrimary = lc === primaryUser;
    const eu = extraUsers.find((u) => u.user.toLowerCase() === lc);
    const isActive = isPrimary || !!eu;
    const _ts = s.last_scrobble_ts || s.fetched_at;
    const dateStr = new Date(_ts * 1000).toLocaleDateString();
    const lastLbl = s.last_scrobble_artist ? ` · ${s.last_scrobble_artist}` : "";
    const incompleteTag = s.complete === false
      ? ' <span style="color:var(--red);font-size:0.7rem" title="Descarga incompleta — usa ↻ Sync">⚠</span>' : "";
    const _rowImg = (isPrimary ? heardCache?.image : null)
      || eu?.image || s.image || _savedImageMap[lc] || _sessionCache.get(lc)?.image || "";
    const _rowColor = eu?.color || (isPrimary ? "var(--accent)" : "var(--ink3)");
    const _rowSrc = (isPrimary ? heardCache?.source : null) || eu?.source || s.source || "lfm";
    const avatar = _avatarHtml(s.user, _rowImg, 22, _rowColor, _rowSrc);

    const btns = isPrimary
      ? `<button class="btn-sm" data-action="sync-primary" data-user="${escH(s.user)}" title="Sincronizar">↻ Sync</button>
         <button class="btn-sm principal" data-action="noop" data-user="${escH(s.user)}">PRINCIPAL</button>
         <button class="btn-sm" data-action="download" data-user="${escH(s.user)}" title="Guardar JSON">↓ JSON</button>
         <button class="eu-del" data-action="unload-primary" data-user="${escH(s.user)}" title="Descargar usuario">✕</button>`
      : `<button class="btn-sm" data-action="sync" data-user="${escH(s.user)}" title="Sincronizar">↻ Sync</button>
         <button class="btn-sm${isActive ? " act" : ""}" data-action="toggle" data-user="${escH(s.user)}">${isActive ? "ACTIVO" : "CARGAR"}</button>
         <button class="btn-sm" data-action="download" data-user="${escH(s.user)}" title="Guardar JSON">↓ JSON</button>
         <button class="btn-sm" data-action="set-primary" data-user="${escH(s.user)}" title="Cargar como principal">→ Prin.</button>
         <button class="eu-del" data-action="delete" data-user="${escH(s.user)}" title="Eliminar">✕</button>`;

    return `<div class="sec-user-row${isActive ? " active" : ""}${isPrimary ? " primary" : ""}">
      <div class="sec-user-left">
        ${avatar}
        <div class="sec-user-info">
          <div class="sec-user-name">${escH(s.user)}</div>
          <div class="sec-user-meta">${s.count.toLocaleString()} álb. · ${dateStr}${escH(lastLbl)}${incompleteTag}</div>
        </div>
      </div>
      <div class="sec-user-btns">${btns}</div>
    </div>`;
  };

  const _renderMemRow = (u) => {
    const avatar = _avatarHtml(u.user, u.image || "", 22, u.color || "var(--ink3)", u.source || "lfm");
    return `<div class="sec-user-row active">
      <div class="sec-user-left">
        ${avatar}
        <div class="sec-user-info">
          <div class="sec-user-name">${escH(u.user)} <span style="font-size:.68rem;color:var(--ink3)" title="Solo esta sesión — exporta JSON para guardar">⚡ sesión</span></div>
          <div class="sec-user-meta">${u.count.toLocaleString()} álb. · sin guardar</div>
        </div>
      </div>
      <div class="sec-user-btns">
        <button class="btn-sm act" data-action="toggle" data-user="${escH(u.user)}">ACTIVO</button>
        <button class="btn-sm" data-action="mem-export" data-user="${escH(u.user)}" title="Guardar JSON">↓ JSON</button>
      </div>
    </div>`;
  };

  if (!sorted.length && !memOnly.length) {
    el.innerHTML = '<div class="idb-empty">Sin sesiones guardadas</div>';
    return;
  }
  el.innerHTML = sorted.map(_renderIdbRow).join("") +
    (memOnly.length ? memOnly.map(_renderMemRow).join("") : "");
}

async function idbLoadSession(username) {
  const data = await idbLoad(username);
  if (!data) return;
  loadHeardCache(data);
  document.getElementById("um-progress").textContent =
    `✓ ${data.user} cargado desde BD`;
  closeUserModal();
}

async function idbDeleteSession(username) {
  await idbDelete(username);
  const lc = username.toLowerCase();
  // Evict from active heardCache
  if (heardCache?.user?.toLowerCase() === lc) {
    heardCache = null;
    loadedUser = null;
    inpUser.value = "";
    hideUserBadge();
    hideResults();
  }
  // Evict from extraUsers + localStorage
  const idx = extraUsers.findIndex((u) => u.user.toLowerCase() === lc);
  if (idx !== -1) {
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
    buildExtraUsersList();
  }
  renderSecondaryUsers();
}

function idbDownloadSession(username) {
  idbLoad(username).then((data) => {
    if (!data) return;
    const yt_ids = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || "{}");
    const covers = JSON.parse(localStorage.getItem(ENRICH_CACHE_KEY) || "{}");
    const blob = new Blob(
      [JSON.stringify({ version: 1, user: data.user, count: data.count,
          fetched_at: data.fetched_at, heard: data.heard,
          songs: data.songs || [], yt_ids, covers }, null, 0)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tumtumpa_${data.user}_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

// ── User badge (header) ────────────────────────────────────────────────────
function showUserBadge(username, img, albumCount, lastTs, lastArtist, lastTrack, source) {
  _updateTopbarAvatar(img || "", username, source);
  const av = document.getElementById("badge-avatar");
  if (av) { av.src = img || ""; av.style.display = img ? "" : "none"; }
  document.getElementById("badge-name").textContent = username;
  document.getElementById("badge-inline").style.display = "flex";
  renderSecondaryUsers();
}
function hideUserBadge() {
  _updateTopbarAvatar("");
  document.getElementById("badge-inline").style.display = "none";
  localStorage.removeItem("tt_primary_user");
  renderSecondaryUsers();
}

// ── Unload primary user ────────────────────────────────────────────────────
function unloadPrimaryUser() {
  if (heardCache) {
    const lc = heardCache.user.toLowerCase();
    _sessionCache.set(lc, { ...(_sessionCache.get(lc) || {}), image: heardCache.image || "" });
  }
  heardCache = null;
  loadedUser = null;
  inpUser.value = "";
  hideUserBadge();
  hideResults();
  renderSecondaryUsers();
}

// ── Toggle secondary user active state (adds/removes from extraUsers) ──────
async function toggleSecondaryUser(username) {
  const lc = username.toLowerCase();
  const idx = extraUsers.findIndex((u) => u.user.toLowerCase() === lc);
  if (idx !== -1) {
    // Already active → deactivate: save to session cache before removing
    _sessionCache.set(lc, {
      pairs: extraUsers[idx].pairs,
      songs: extraUsers[idx].songs || [],
      count: extraUsers[idx].count,
      fetched_at: extraUsers[idx].fetched_at || 0,
      color: extraUsers[idx].color,
      image: extraUsers[idx].image || "",
      source: extraUsers[idx].source || "lfm",
      tracks_loaded: extraUsers[idx].tracks_loaded || false,
    });
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
    buildExtraUsersList();
    renderSecondaryUsers();
    return;
  }
  const prog = document.getElementById("um-extra-progress");
  // Try session cache first (instant, no IDB needed)
  const cached = _sessionCache.get(lc);
  if (cached?.pairs?.length) {
    const color = cached.color || USER_COLORS[extraUsers.length % USER_COLORS.length];
    extraUsers.push({
      user: username,
      pairs: cached.pairs,
      songs: cached.songs || [],
      color,
      count: cached.count || cached.pairs.length,
      fetched_at: cached.fetched_at || 0,
      image: cached.image || "",
      source: cached.source || "lfm",
      tracks_loaded: cached.tracks_loaded || false,
    });
    saveExtraUsersLS();
    buildExtraUsersList();
    renderSecondaryUsers();
    if (prog) prog.textContent = `✓ ${username} cargado`;
    return;
  }
  // Load from IDB
  const data = await idbLoad(username);
  if (!data) return;
  const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
  const userInfo = await checkUserClient(data.user, data.source || "lfm").catch(() => null);
  const image = userInfo?.ok ? userInfo.image || "" : "";
  extraUsers.push({
    user: data.user,
    pairs: data.heard,
    songs: data.songs || [],
    color,
    count: data.heard.length,
    fetched_at: data.fetched_at || 0,
    image,
    source: data.source || "lfm",
    tracks_loaded: data.tracks_loaded || false,
  });
  _sessionCache.set(lc, { pairs: data.heard, songs: data.songs || [], count: data.heard.length, fetched_at: data.fetched_at || 0, color, image, source: data.source || "lfm", tracks_loaded: data.tracks_loaded || false });
  saveExtraUsersLS();
  buildExtraUsersList();
  renderSecondaryUsers();
  if (prog) prog.textContent = `✓ ${data.user} cargado`;
}

// ── Sync a secondary user from Last.fm (by username in IDB) ───────────────
async function syncSecondaryIdb(username) {
  const prog = document.getElementById("um-extra-progress");
  if (prog) prog.textContent = `Sincronizando ${username}...`;
  try {
    const existing = await idbLoad(username);
    const euSrc =
      extraUsers.find((u) => u.user.toLowerCase() === username.toLowerCase())
        ?.source ||
      existing?.source ||
      "lfm";
    // Si la sesión no está marcada como completa, descargar todo desde cero
    if (existing && existing.complete === false) {
      if (prog)
        prog.textContent = `Sesión incompleta — descargando completo...`;
      const method = await showFetchMethodModal(username, euSrc);
      if (method === null) {
        if (prog) prog.textContent = "";
        return;
      }
      const lfmResult = await fetchScrobblesClient(
        username,
        (msg) => {
          if (prog)
            prog.textContent = msg.reconnecting
              ? `Reconectando… (${msg.page}/${msg.total_pages || '?'})`
              : `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álb.`;
        },
        euSrc,
        method,
      );
      const newFetched = Math.floor(Date.now() / 1000);
      await idbSaveOrModal({
        user: username,
        count: lfmResult.heard.length,
        fetched_at: newFetched,
        heard: lfmResult.heard,
        songs: lfmResult.heard_songs || [],
        last_scrobble_ts: lfmResult.last_scrobble_ts || 0,
        last_scrobble_artist: lfmResult.last_scrobble_artist || "",
        last_scrobble_track: lfmResult.last_scrobble_track || "",
        complete: true,
        total_pages: lfmResult.total_pages || 0,
        source: euSrc,
        tracks_loaded: lfmResult.tracks_loaded || false,
        heard_artists: lfmResult.heard_artists || [],
      });
      const eu = extraUsers.find(
        (u) => u.user.toLowerCase() === username.toLowerCase(),
      );
      if (eu) {
        eu.pairs = lfmResult.heard;
        eu.songs = lfmResult.heard_songs || [];
        eu.count = lfmResult.heard.length;
        eu.fetched_at = newFetched;
        eu.tracks_loaded = lfmResult.tracks_loaded || false;
        saveExtraUsersLS();
      }
      renderSecondaryUsers();
      if (prog)
        prog.textContent = `✓ ${username}: ${lfmResult.heard.length.toLocaleString()} álbumes`;
      return;
    }
    const since = existing?.fetched_at || 0;
    const data = await syncSinceClient(username, since, euSrc);
    if (data.error) throw new Error(data.error);
    // merge new pairs into existing
    const existSet = new Set(
      (existing?.heard || []).map((p) => p[0] + "|" + p[1]),
    );
    const added = (data.new_pairs || []).filter(
      (p) => !existSet.has(p[0] + "|" + p[1]),
    );
    const merged = [...(existing?.heard || []), ...added];
    // merge songs
    const existSongSet = new Set(
      (existing?.songs || []).map((s) => s[0] + "|" + s[1]),
    );
    const addedSongs = (data.new_songs || []).filter(
      (s) => !existSongSet.has(s[0] + "|" + s[1]),
    );
    const mergedSongs = [...(existing?.songs || []), ...addedSongs];
    const newFetched = data.fetched_at || Math.floor(Date.now() / 1000);
    await idbSaveOrModal({
      user: username,
      count: merged.length,
      fetched_at: newFetched,
      heard: merged,
      songs: mergedSongs,
      last_scrobble_ts:
        data.last_scrobble_ts || existing?.last_scrobble_ts || 0,
      last_scrobble_artist:
        data.last_scrobble_artist || existing?.last_scrobble_artist || "",
      last_scrobble_track:
        data.last_scrobble_track || existing?.last_scrobble_track || "",
      complete: true,
      total_pages: existing?.total_pages || 0,
    });
    // update in-memory if in extraUsers
    const eu = extraUsers.find(
      (u) => u.user.toLowerCase() === username.toLowerCase(),
    );
    if (eu) {
      eu.pairs = merged;
      eu.songs = mergedSongs;
      eu.count = merged.length;
      eu.fetched_at = newFetched;
      saveExtraUsersLS();
    }
    renderSecondaryUsers();
    if (prog)
      prog.textContent = `✓ ${username}: +${added.length} nuevos (total ${merged.length.toLocaleString()})`;
  } catch (e) {
    if (prog) prog.textContent = "Error: " + e.message;
  }
}

// ── Load secondary user as primary ────────────────────────────────────────
async function setPrimaryFromSecondary(username) {
  const data = await idbLoad(username);
  if (!data) return;
  // Remove from extraUsers if present, pulling their image into data if IDB lacks it
  const lc = username.toLowerCase();
  const idx = extraUsers.findIndex((u) => u.user.toLowerCase() === lc);
  if (idx !== -1) {
    if (!data.image) data.image = extraUsers[idx].image || "";
    extraUsers.splice(idx, 1);
    saveExtraUsersLS();
  }
  if (!data.image) data.image = _sessionCache.get(lc)?.image || "";
  loadHeardCache(data);
  document.getElementById("um-progress").textContent =
    `✓ ${data.user} cargado como principal`;
  buildExtraUsersList();
}

function loadHeardCache(data) {
  heardCache = {
    user: data.user,
    image: data.image || "",
    pairs: data.heard,
    songs: data.songs || data.heard_songs || [],
    count: data.heard.length,
    fetched_at: data.fetched_at || 0,
    last_scrobble_ts: data.last_scrobble_ts || 0,
    last_scrobble_artist: data.last_scrobble_artist || "",
    last_scrobble_track: data.last_scrobble_track || "",
    complete: data.complete !== undefined ? data.complete : true,
    total_pages: data.total_pages || 0,
    source: data.source || "lfm",
    tracks_loaded: data.tracks_loaded || false,
    // Set de artistas normalizados para filtro en modo Descubrir artistas
    artist_set: data.heard_artists
      ? new Set(data.heard_artists)
      : new Set((data.heard || []).map((p) => p[0])),
  };
  // song_set: fast lookup for songs mode — key is norm_a + '|' + norm_track
  heardCache.song_set = new Set(heardCache.songs.map((s) => s[0] + "|" + s[1]));
  loadedUser = data.user.toLowerCase();
  localStorage.setItem("tt_primary_user", data.user.toLowerCase());
  inpUser.value = data.user;
  showUserBadge(
    data.user,
    data.image || "",
    data.heard.length,
    heardCache.last_scrobble_ts,
    heardCache.last_scrobble_artist,
    heardCache.last_scrobble_track,
    heardCache.source,
  );
  const _idbPayload = {
    user: heardCache.user,
    image: heardCache.image || "",
    count: heardCache.count,
    fetched_at: heardCache.fetched_at,
    heard: heardCache.pairs,
    songs: heardCache.songs,
    last_scrobble_ts: heardCache.last_scrobble_ts,
    last_scrobble_artist: heardCache.last_scrobble_artist,
    last_scrobble_track: heardCache.last_scrobble_track,
    complete: heardCache.complete,
    total_pages: heardCache.total_pages,
    heard_artists: [...heardCache.artist_set],
    source: heardCache.source,
    tracks_loaded: heardCache.tracks_loaded,
  };
  idbSave(_idbPayload)
    .then((r) => {
      if (r?.quota) showQuotaModal(_idbPayload.user, _idbPayload);
      renderIdbList();
      renderIdbExtraList();
    })
    .catch(() => {});
  dismissWelcome();
}

// btn-save-session removed — primary user download now goes through idbDownloadSession

// ── Session: importar JSON (routes to primary or secondary) ───────────────
document
  .getElementById("btn-import")
  .addEventListener("click", () => inpSession.click());
inpSession.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const prog = document.getElementById("um-progress");
  try {
    const data = JSON.parse(await file.text());
    if (!data.heard || !data.user) throw new Error("Formato inválido");
    // Restore enrich and YT caches (merge; existing takes priority as it's more recent)
    if (data.covers && typeof data.covers === "object") {
      try {
        const existing = JSON.parse(
          localStorage.getItem(ENRICH_CACHE_KEY) || "{}",
        );
        localStorage.setItem(
          ENRICH_CACHE_KEY,
          JSON.stringify({ ...data.covers, ...existing }),
        );
      } catch (_) {}
    }
    if (data.yt_ids && typeof data.yt_ids === "object") {
      try {
        const existing = JSON.parse(localStorage.getItem(YT_CACHE_KEY) || "{}");
        localStorage.setItem(
          YT_CACHE_KEY,
          JSON.stringify({ ...data.yt_ids, ...existing }),
        );
      } catch (_) {}
    }
    const addAsSecondary =
      !!heardCache && heardCache.user.toLowerCase() !== data.user.toLowerCase();
    if (addAsSecondary) {
      if (
        extraUsers.some((u) => u.user.toLowerCase() === data.user.toLowerCase())
      ) {
        prog.textContent = `${data.user} ya está activo`;
        e.target.value = "";
        return;
      }
      const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
      const ft = data.fetched_at || 0;
      extraUsers.push({
        user: data.user,
        pairs: data.heard,
        songs: data.songs || [],
        color,
        count: data.heard.length,
        fetched_at: ft,
        image: "",
      });
      saveExtraUsersLS();
      await idbSaveOrModal({
        user: data.user,
        count: data.heard.length,
        fetched_at: ft,
        heard: data.heard,
        songs: data.songs || [],
      });
      buildExtraUsersList();
      prog.textContent = `✓ ${data.user} importado como secundario — ${data.heard.length.toLocaleString()} álbumes`;
      // Fetch avatar in background
      checkUserClient(data.user, data.source || "lfm")
        .then((info) => {
          if (!info?.ok || !info.image) return;
          const eu = extraUsers.find(
            (u) => u.user.toLowerCase() === data.user.toLowerCase(),
          );
          if (eu) {
            eu.image = info.image;
            saveExtraUsersLS();
            renderSecondaryUsers();
          }
          idbLoad(data.user)
            .then((d) => {
              if (d) idbSave({ ...d, image: info.image });
            })
            .catch(() => {});
        })
        .catch(() => {});
    } else {
      loadHeardCache(data);
      prog.textContent = `✓ ${data.user} importado — ${data.heard.length.toLocaleString()} álbumes`;
      closeUserModal();
      // Fetch avatar in background if JSON didn't include it
      if (!heardCache?.image) {
        const _impUser = data.user;
        const _impSrc = data.source || "lfm";
        checkUserClient(_impUser, _impSrc).then((info) => {
          if (!info?.ok || !info.image || heardCache?.user?.toLowerCase() !== _impUser.toLowerCase()) return;
          heardCache.image = info.image;
          showUserBadge(heardCache.user, heardCache.image, heardCache.count,
            heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
          idbLoad(_impUser).then((d) => { if (d) idbSave({ ...d, image: info.image }); }).catch(() => {});
        }).catch(() => {});
      }
    }
  } catch (err) {
    prog.textContent = "Error: " + err.message;
  }
  e.target.value = "";
});

// ── Sync primary user ─────────────────────────────────────────────────────
async function syncPrimaryUser(triggerBtn) {
  if (!heardCache) return;
  const prog = document.getElementById("um-extra-progress");
  if (triggerBtn) { triggerBtn.disabled = true; triggerBtn.textContent = "↻ ..."; }
  if (prog) prog.textContent = "Sincronizando…";
  try {
    const data = await syncSinceClient(heardCache.user, heardCache.fetched_at || 0, heardCache.source || "lfm");
    if (data.error) throw new Error(data.error);
    const existing = new Set(heardCache.pairs.map((p) => p[0] + "|" + p[1]));
    const added = (data.new_pairs || []).filter((p) => !existing.has(p[0] + "|" + p[1]));
    heardCache.pairs = [...heardCache.pairs, ...added];
    heardCache.count = heardCache.pairs.length;
    heardCache.fetched_at = data.fetched_at;
    if (data.last_scrobble_ts && data.last_scrobble_ts > (heardCache.last_scrobble_ts || 0)) {
      heardCache.last_scrobble_ts = data.last_scrobble_ts;
      heardCache.last_scrobble_artist = data.last_scrobble_artist || "";
      heardCache.last_scrobble_track = data.last_scrobble_track || "";
    }
    showUserBadge(heardCache.user, heardCache.image || "", heardCache.count,
      heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
    // Fetch avatar if missing
    if (!heardCache.image) {
      const _pUser = heardCache.user;
      const _pSrc = heardCache.source || "lfm";
      checkUserClient(_pUser, _pSrc).then((info) => {
        if (!info?.ok || !info.image || heardCache?.user?.toLowerCase() !== _pUser.toLowerCase()) return;
        heardCache.image = info.image;
        showUserBadge(heardCache.user, heardCache.image, heardCache.count,
          heardCache.last_scrobble_ts, heardCache.last_scrobble_artist, heardCache.last_scrobble_track);
        idbLoad(_pUser).then((d) => { if (d) idbSave({ ...d, image: info.image }); }).catch(() => {});
      }).catch(() => {});
    }
    if (prog) prog.textContent = added.length
      ? `✓ +${added.length} nuevos (total ${heardCache.count.toLocaleString()})` : "✓ Al día";
  } catch (e) {
    if (prog) prog.textContent = "Error: " + e.message;
  } finally {
    if (triggerBtn) { triggerBtn.disabled = false; triggerBtn.textContent = "↻ Sync"; }
  }
}

// ── Main: Cargar scrobbles ─────────────────────────────────────────────────
btnGo.addEventListener("click", doLoadUser);
inpUser.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLoadUser();
});

async function doLoadUser() {
  const user = inpUser.value.trim();
  if (!user) return;
  hideError();
  const prog = document.getElementById("um-progress");
  btnGo.disabled = true;
  const src = umSource();

  try {
    // Verify user exists first
    prog.textContent =
      src === "lb" ? "Verificando ListenBrainz…" : "Verificando Last.fm…";
    const userInfo = await checkUserClient(user, src);
    if (!userInfo.ok) {
      prog.textContent =
        "Error: " + (userInfo.error || "Usuario no encontrado");
      return;
    }
    const realUser = userInfo.username || user;

    // Show method choice modal (always, before starting download)
    const method = await showFetchMethodModal(realUser, src);
    if (method === null) {
      prog.textContent = "";
      return;
    }

    prog.textContent = "Conectando…";
    const result = await fetchScrobblesClient(
      realUser,
      (msg) => {
        prog.textContent = msg.reconnecting
          ? `Reconectando… (${msg.page}/${msg.total_pages || '?'})`
          : `Página ${msg.page} / ${msg.total_pages} — ${msg.count.toLocaleString()} álbumes`;
      },
      src,
      method,
    );

    const fetched_at = Math.floor(Date.now() / 1000);
    const addAsSecondary =
      !!heardCache && heardCache.user.toLowerCase() !== realUser.toLowerCase();

    if (addAsSecondary) {
      const color = USER_COLORS[extraUsers.length % USER_COLORS.length];
      const euIdx = extraUsers.findIndex(
        (u) => u.user.toLowerCase() === realUser.toLowerCase(),
      );
      const eu = {
        user: realUser,
        pairs: result.heard,
        songs: result.heard_songs || [],
        color: euIdx !== -1 ? extraUsers[euIdx].color : color,
        count: result.heard.length,
        fetched_at,
        image: userInfo.image || "",
        source: src,
        tracks_loaded: result.tracks_loaded || false,
        last_scrobble_ts: result.last_scrobble_ts || 0,
        last_scrobble_artist: result.last_scrobble_artist || "",
        last_scrobble_track: result.last_scrobble_track || "",
      };
      _sessionCache.set(realUser.toLowerCase(), {
        pairs: result.heard, songs: result.heard_songs || [],
        count: result.heard.length, fetched_at, color: eu.color,
        image: userInfo.image || "", source: src,
        tracks_loaded: result.tracks_loaded || false,
      });
      if (euIdx !== -1) extraUsers[euIdx] = eu;
      else extraUsers.push(eu);
      saveExtraUsersLS();
      await idbSaveOrModal({
        user: realUser,
        count: result.heard.length,
        fetched_at,
        heard: result.heard,
        songs: result.heard_songs || [],
        source: src,
        tracks_loaded: result.tracks_loaded || false,
        last_scrobble_ts: result.last_scrobble_ts || 0,
        last_scrobble_artist: result.last_scrobble_artist || "",
        last_scrobble_track: result.last_scrobble_track || "",
        complete: true,
        total_pages: result.total_pages || 0,
        heard_artists: result.heard_artists || [],
      });
      buildExtraUsersList();
      prog.textContent = `✓ ${realUser} añadido — ${result.heard.length.toLocaleString()} álbumes${result.tracks_loaded ? ", " + (result.heard_songs?.length || 0).toLocaleString() + " canciones" : ""}`;
      inpUser.value = "";
    } else {
      loadHeardCache({
        user: realUser,
        image: userInfo.image || "",
        heard: result.heard,
        heard_songs: result.heard_songs || [],
        fetched_at,
        last_scrobble_ts: result.last_scrobble_ts || 0,
        last_scrobble_artist: result.last_scrobble_artist || "",
        last_scrobble_track: result.last_scrobble_track || "",
        complete: true,
        total_pages: result.total_pages || 0,
        heard_artists: result.heard_artists || [],
        source: src,
        tracks_loaded: result.tracks_loaded || false,
      });
      prog.textContent = `✓ ${result.heard.length.toLocaleString()} álbumes cargados${result.tracks_loaded ? " + canciones" : ""}`;
      closeUserModal();
    }
  } catch (e) {
    prog.textContent = "Error: " + e.message;
  } finally {
    btnGo.disabled = false;
  }
}

// ── Welcome screen ─────────────────────────────────────────────────────────
function dismissWelcome() {
  localStorage.setItem("tt_welcomed", "1");
  document.getElementById("welcome-screen").style.display = "none";
}

function startFromWelcome() {
  dismissWelcome();
  openUserModal();
}

// ── PWA Service Worker registration ───────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}

// ── Init ─────────────────────────────────────────────────────────────────
(async () => {
  await initClientKey();
  loadExtraUsersLS();
  // Hydrate pairs from IDB; purge users no longer in IDB
  if (extraUsers.length) {
    try {
      const sessions = await idbList();
      const inIdb = new Set(sessions.map((s) => s.user.toLowerCase()));
      const valid = extraUsers.filter((u) => inIdb.has(u.user.toLowerCase()));
      if (valid.length !== extraUsers.length) {
        extraUsers.length = 0;
        valid.forEach((u) => extraUsers.push(u));
        saveExtraUsersLS();
      }
    } catch (e) {}
    await hydrateExtraUsersFromIdb();
  }

  // Restore principal user from last session
  const savedPrimary = localStorage.getItem("tt_primary_user");
  if (savedPrimary) {
    const primaryData = await idbLoad(savedPrimary).catch(() => null);
    if (primaryData) {
      loadHeardCache(primaryData);
    } else {
      localStorage.removeItem("tt_primary_user");
    }
  }

  await renderSecondaryUsers();
  buildExtraUsersList();

  // Show welcome screen if no data at all and never seen before
  const welcomed = localStorage.getItem("tt_welcomed");
  if (!welcomed) {
    const sessions = await idbList().catch(() => []);
    if (!sessions.length && !extraUsers.length) {
      document.getElementById("welcome-screen").style.display = "block";
    }
  }
})();

// ── Event listeners (replaces all removed inline handlers) ─────────────────

// Static elements (from HTML template)
document
  .getElementById("btn-start-welcome")
  .addEventListener("click", startFromWelcome);
document
  .getElementById("btn-open-users")
  .addEventListener("click", openUserModal);
document
  .querySelector("#user-modal .modal-close")
  .addEventListener("click", closeUserModal);
document.getElementById("about-overlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeAboutModal();
});
document
  .querySelector(".about-close")
  .addEventListener("click", closeAboutModal);
document
  .getElementById("disc-play-btn")
  .addEventListener("click", triggerDiscover);
document
  .getElementById("disc-prev")
  .addEventListener("click", discoverPrevPage);
document
  .getElementById("disc-next")
  .addEventListener("click", discoverNextPage);
document.querySelector(".dp-close").addEventListener("click", closeDetailPanel);

// Delegation: disc-user-indicator (user selector pills)
document
  .getElementById("disc-user-indicator")
  .addEventListener("click", (e) => {
    const line = e.target.closest(".disc-user-line[data-idx]");
    if (line) toggleDiscoverUser(parseInt(line.dataset.idx));
  });

// Delegation: friends-list (fr-add)
document.getElementById("friends-list").addEventListener("click", (e) => {
  const btn = e.target.closest(".fr-add[data-username]");
  if (btn && !btn.disabled) addExtraUserByName(btn.dataset.username, btn);
});

// Delegation: sb-cache-notice (export / close)
document.getElementById("sb-cache-notice").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "export") {
    idbExportAll();
  } else if (btn.dataset.action === "close-notice") {
    const notice = document.getElementById("sb-cache-notice");
    notice.style.display = "none";
    delete notice.dataset.shown;
  }
});

// Delegation: secondary-users-list
document
  .getElementById("secondary-users-list")
  .addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action][data-user]");
    if (!btn) return;
    const user = btn.dataset.user;
    switch (btn.dataset.action) {
      case "sync":
        syncSecondaryIdb(user);
        break;
      case "sync-primary":
        syncPrimaryUser(btn);
        break;
      case "toggle":
        toggleSecondaryUser(user);
        break;
      case "download":
        idbDownloadSession(user);
        break;
      case "set-primary":
        setPrimaryFromSecondary(user);
        break;
      case "delete":
        idbDeleteSession(user);
        break;
      case "mem-export":
        _exportMemoryUser(user);
        break;
      case "unload-primary":
        unloadPrimaryUser();
        break;
      case "noop":
        break;
    }
  });

// Delegation: disc-rel-tabs
document.getElementById("disc-rel-tabs").addEventListener("click", e => {
  const btn = e.target.closest(".disc-tab[data-rel]");
  if (!btn) return;
  const rel = btn.dataset.rel;
  if (rel === discoverRelMode) return;
  discoverRelMode = rel;
  document.querySelectorAll(".disc-tab").forEach(b => b.classList.toggle("active", b.dataset.rel === rel));
  if (discoverMode) triggerDiscover();
});
