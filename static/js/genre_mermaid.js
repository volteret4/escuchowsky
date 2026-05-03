// ── Data (injected via <script type="application/json" id="app-data">) ──────
const __d       = JSON.parse(document.getElementById('app-data').textContent);
const TREE_IDX  = {};  // slug → compact {s,n,c[]}
const CHARTS    = __d.charts;
const PANEL_DATA = __d.panelData;
const ALL_PAIRS  = __d.allPairs;
let   HEARD      = {};              // chart_slug → heard count (computed from IDB)

(function idx(nodes) {
  for (const n of nodes) { TREE_IDX[n.s] = n; idx(n.c || []); }
})(__d.tree);

function cslug(s) { return 'genre_' + s.replace(/-/g,'_'); }
function isScraped(s) { return !!CHARTS[cslug(s)]; }

// ── Genre and Artist indexes for search ───────────────────────────────────
const GENRE_META = {};
(function buildMeta(nodes, parent) {
  for (const n of nodes) {
    GENRE_META[n.s] = {name: n.n, parent: parent || null};
    buildMeta(n.c || [], n.s);
  }
})(__d.tree, null);

const ARTIST_INDEX = {};
for (const [slug, pd] of Object.entries(PANEL_DATA)) {
  for (const alb of (pd.albums || [])) {
    if (!alb.yt_id) continue;
    const key = alb.artist.toLowerCase().trim();
    if (!ARTIST_INDEX[key]) ARTIST_INDEX[key] = {display: alb.artist, genres: []};
    if (!ARTIST_INDEX[key].genres.includes(slug)) ARTIST_INDEX[key].genres.push(slug);
  }
}

// ── Tree state ────────────────────────────────────────────────────────────
// Each node in our working tree: {slug, name, children:null|[], _raw, expanded}
let treeRoot = null;
let activeSlug = null;
let highlightedSlug = null;

function makeNode(compactNode, expanded=false) {
  return {
    slug:     compactNode.s,
    name:     compactNode.n,
    _raw:     compactNode,
    children: null,   // null = collapsed, [] or [...] = expanded
    expanded: false,
  };
}

function expandNode(node) {
  if (node.children !== null) return;  // already expanded
  const rawKids = node._raw.c || [];
  node.children = rawKids.map(c => makeNode(TREE_IDX[c.s] || c));
  node.expanded = true;
}

function collapseNode(node) {
  node.children = null;
  node.expanded = false;
}

function toggleExpand(node) {
  if (node.children !== null) collapseNode(node);
  else expandNode(node);
  render();
}

// ── D3 layout ─────────────────────────────────────────────────────────────
const NODE_W  = 188;
const NODE_H  = 46;
const BTN_R   = 14;
const H_GAP   = 60;   // horizontal gap between levels
const V_GAP   = 8;    // vertical gap between siblings

const svg    = d3.select('#tree-svg');
const gRoot  = svg.append('g');  // all content (transformed by zoom)

const zoomBehavior = d3.zoom()
  .scaleExtent([0.15, 3])
  .on('zoom', e => gRoot.attr('transform', e.transform));
svg.call(zoomBehavior);

const treeLayout = d3.tree()
  .nodeSize([NODE_H + V_GAP, NODE_W + H_GAP])
  .separation((a, b) => a.parent === b.parent ? 1 : 1.4);

function buildHierarchy(node) {
  const obj = { id: node.slug, node };
  if (node.children !== null) {
    obj.children = node.children.map(c => buildHierarchy(c));
  }
  return obj;
}

let _idCounter = 0;
function render() {
  if (!treeRoot) return;

  const hierRoot = d3.hierarchy(buildHierarchy(treeRoot));
  treeLayout(hierRoot);

  // d3.tree uses x=vertical, y=horizontal — swap for LR layout
  const nodes = hierRoot.descendants();
  const links = hierRoot.links();

  // ── links ──────────────────────────────────────────────────────────────
  const linkSel = gRoot.selectAll('.tree-link').data(links, d => d.target.data.id);

  // Bezier from right-edge of source to left-edge of target
  function linkPath(d) {
    const sx = d.source.y + NODE_W, sy = d.source.x + NODE_H / 2;
    const tx = d.target.y,          ty = d.target.x + NODE_H / 2;
    const mx = (sx + tx) / 2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
  }

  linkSel.enter().append('path')
    .attr('class', 'tree-link')
    .attr('d', linkPath)
    .merge(linkSel)
    .transition().duration(250)
    .attr('d', linkPath);

  linkSel.exit().transition().duration(200).style('opacity',0).remove();

  // ── nodes ──────────────────────────────────────────────────────────────
  // Colours as constants (inline attrs — more reliable than CSS vars in SVG)
  const C_ACCENT = '#c9a227';
  const C_MUTED  = '#555555';
  const NODE_BG   = (depth, scraped) => depth === 0 ? '#2a1e00' : scraped ? '#1a1300' : '#161616';
  const NODE_STR  = (depth, scraped) => depth === 0 ? C_ACCENT  : scraped ? '#4a3800' : '#2a2a2a';
  const NODE_STW  = (depth) => depth === 0 ? 2 : 1;
  const TEXT_CLR  = (depth, scraped) => depth === 0 ? C_ACCENT  : scraped ? '#e0e0e0' : '#666';
  const BX = NODE_W + BTN_R + 6;
  const BY = NODE_H / 2;

  const nodeSel = gRoot.selectAll('.node-group').data(nodes, d => d.data.id);

  const enter = nodeSel.enter().append('g')
    .attr('class', 'node-group')
    .attr('transform', d => `translate(${d.y},${d.x})`)
    .style('opacity', 0);

  // Background rect — click = expand/collapse
  enter.append('rect')
    .attr('rx', 6)
    .attr('width', NODE_W)
    .attr('height', NODE_H)
    .attr('fill',         d => NODE_BG(d.depth, isScraped(d.data.node.slug)))
    .attr('stroke',       d => NODE_STR(d.depth, isScraped(d.data.node.slug)))
    .attr('stroke-width', d => NODE_STW(d.depth))
    .style('cursor', d => (d.data.node._raw.c || []).length > 0 ? 'pointer' : 'default')
    .on('mouseover', function(e, d) {
      d3.select(this).attr('stroke', C_ACCENT);
    })
    .on('mouseout', function(e, d) {
      d3.select(this).attr('stroke', NODE_STR(d.depth, isScraped(d.data.node.slug)));
    })
    .on('click', (e, d) => {
      e.stopPropagation();
      const n = d.data.node;
      if ((n._raw.c || []).length > 0) toggleExpand(n);
    });

  // Genre name
  enter.append('text')
    .attr('x', 10)
    .attr('y', 18)
    .attr('fill',        d => TEXT_CLR(d.depth, isScraped(d.data.node.slug)))
    .attr('font-family', "'DM Sans', sans-serif")
    .attr('font-size',   d => d.depth === 0 ? '13px' : '12px')
    .attr('font-weight', d => d.depth === 0 ? '600' : '400')
    .style('pointer-events', 'none')
    .text(d => {
      const name = d.data.node.name;
      return name.length > 20 ? name.slice(0, 19) + '…' : name;
    });

  // Subtext: chart total or subgenre count
  enter.append('text')
    .attr('x', 10)
    .attr('y', 34)
    .attr('fill', C_MUTED)
    .attr('font-family', "'DM Mono', monospace")
    .attr('font-size', '9px')
    .style('pointer-events', 'none')
    .text(d => {
      const n = d.data.node;
      const cs = cslug(n.slug);
      if (CHARTS[cs]) {
        const total = CHARTS[cs];
        const heard = HEARD[cs] ?? null;
        return heard !== null ? heard + '/' + total + ' escuch.' : total + ' álb';
      }
      const kids = (n._raw.c || []).length;
      return kids > 0 ? kids + ' sub' : '';
    });

  // ── "ℹ" info button inside rect (always) → opens panel ───────────────────
  const infoG = enter.append('g')
    .attr('class', '_info_g')
    .style('cursor', 'pointer')
    .on('click', (e, d) => { e.stopPropagation(); showPanel(d.data.node.slug); })
    .on('mouseover', function() {
      d3.select(this).select('circle').attr('fill', C_ACCENT).attr('stroke', C_ACCENT);
      d3.select(this).select('text').attr('fill', '#000');
    })
    .on('mouseout', function() {
      d3.select(this).select('circle').attr('fill', '#1e1e1e').attr('stroke', '#3a3a3a');
      d3.select(this).select('text').attr('fill', C_ACCENT);
    });

  infoG.append('circle')
    .attr('cx', NODE_W - 14).attr('cy', NODE_H / 2).attr('r', 9)
    .attr('fill', '#1e1e1e').attr('stroke', '#3a3a3a');

  infoG.append('text')
    .attr('x', NODE_W - 14).attr('y', NODE_H / 2)
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('fill', C_ACCENT)
    .attr('font-family', "'DM Mono', monospace")
    .attr('font-size', '11px').attr('font-weight', '700')
    .style('pointer-events', 'none')
    .text('i');

  // ── "+" expand button outside rect (only for nodes with children) ─────────
  const expandG = enter.append('g')
    .attr('class', '_expand_g')
    .style('display', d => (d.data.node._raw.c || []).length > 0 ? null : 'none')
    .style('cursor', 'pointer')
    .on('click', (e, d) => {
      e.stopPropagation();
      const n = d.data.node;
      if ((n._raw.c || []).length > 0) toggleExpand(n);
    })
    .on('mouseover', function() {
      d3.select(this).select('circle').attr('fill', C_ACCENT).attr('stroke', C_ACCENT);
      d3.select(this).select('._expand_txt').attr('fill', '#000');
    })
    .on('mouseout', function() {
      d3.select(this).select('circle').attr('fill', '#1e1e1e').attr('stroke', '#3a3a3a');
      d3.select(this).select('._expand_txt').attr('fill', C_ACCENT);
    });

  expandG.append('circle')
    .attr('cx', BX).attr('cy', BY).attr('r', BTN_R)
    .attr('fill', '#1e1e1e').attr('stroke', '#3a3a3a');

  expandG.append('text')
    .attr('class', '_expand_txt')
    .attr('x', BX).attr('y', BY)
    .attr('text-anchor', 'middle').attr('dominant-baseline', 'central')
    .attr('fill', C_ACCENT)
    .attr('font-family', "'DM Mono', monospace")
    .attr('font-size', '16px').attr('font-weight', '700')
    .style('pointer-events', 'none')
    .text(d => d.data.node.children !== null ? '−' : '+');

  // ── update + enter: position, opacity, expand button state ───────────────
  const update = nodeSel.merge(enter);
  update.transition().duration(250)
    .style('opacity', 1)
    .attr('transform', d => `translate(${d.y},${d.x})`);

  update.each(function(d) {
    const isOpen  = d.data.node.children !== null;
    const hasKids = (d.data.node._raw.c || []).length > 0;
    d3.select(this).select('._expand_txt').text(!hasKids ? '' : isOpen ? '−' : '+');
    const isHl = highlightedSlug && d.data.node.slug === highlightedSlug;
    d3.select(this).select('rect')
      .attr('stroke', isHl ? '#ff9' : NODE_STR(d.depth, isScraped(d.data.node.slug)))
      .attr('stroke-width', isHl ? 3 : NODE_STW(d.depth));
  });

  // ── exit ───────────────────────────────────────────────────────────────
  nodeSel.exit().transition().duration(200).style('opacity',0).remove();
}

// ── Genre selection ────────────────────────────────────────────────────────
function togglePicker() {
  const btn = document.getElementById('gpBtn');
  const dd  = document.getElementById('gpDd');
  btn.classList.toggle('open');
  dd.classList.toggle('open');
}

function selectGenre(slug) {
  // Update picker label and close dropdown
  const link = document.querySelector(`.mg-link[data-slug="${slug}"]`);
  if (link) {
    document.getElementById('gpLabel').textContent = link.textContent.trim();
  }
  document.querySelectorAll('.mg-link').forEach(el => el.classList.remove('active'));
  if (link) link.classList.add('active');
  document.getElementById('gpBtn').classList.remove('open');
  document.getElementById('gpDd').classList.remove('open');

  document.getElementById('tree-placeholder').style.display = 'none';

  const raw = TREE_IDX[slug];
  if (!raw) return;

  // Build root with children pre-expanded one level
  treeRoot = makeNode(raw);
  expandNode(treeRoot);
  activeSlug = slug;

  render();

  // Center view
  const wrap = document.getElementById('tree-wrap');
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  svg.transition().duration(300).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(60, H / 2).scale(1)
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────
function showPanel(slug) {
  _currentPanelSlug = slug;
  const data = PANEL_DATA[slug] || {};
  const cs   = cslug(slug);
  const hasChart = !!CHARTS[cs];

  let html = `<div class="panel-slug">${slug}</div>`;
  if (hasChart) {
    html += `<a class="panel-title" href="rym_charts/${cs}/index.html" target="_blank">${data.name || slug}</a>`;
  } else {
    html += `<div class="panel-title">${data.name || slug}</div>`;
  }

  if (hasChart) {
    const heardCount = HEARD[cs] ?? null;
    if (heardCount !== null) {
      const tot = CHARTS[cs];
      const pct = tot > 0 ? Math.round(heardCount / tot * 100) : 0;
      const fill = Math.min(100, pct);
      html += `<div class="panel-heard">
        <div class="panel-heard-bar"><div class="panel-heard-fill" style="width:${fill}%"></div></div>
        <span class="panel-heard-label">${heardCount}/${tot} escuchados (${pct}%)</span>
      </div>`;
    }
  }

  if (data.desc) {
    html += `<div class="panel-desc">${data.desc}</div>`;
  }

  const ytAlbums = (data.albums || []).filter(a => a.yt_id);
  if (ytAlbums.length) {
    html += `<div class="panel-section">Top álbumes</div>`;
  } else {
    html += `<div class="no-data">${hasChart ? 'Sin álbumes con video' : 'Sin chart scrapeado'}</div>`;
  }

  document.getElementById('panel-body').innerHTML = html;
  const va = document.getElementById('panel-video-area');
  va.style.display = ytAlbums.length ? 'block' : 'none';
  document.getElementById('panel').classList.add('open');
  document.getElementById('tree-wrap').classList.add('panel-open');

  // init pagination
  _panelAlbs = ytAlbums;
  _panelPage = 0;
  _renderPanelPage();
}

const PANEL_PER_PAGE = 3;
let _panelAlbs = [];
let _panelPage = 0;

function _renderPanelPage() {
  const container = document.getElementById('panel-alb-pages');
  if (!container) return;
  const total = _panelAlbs.length;
  const maxPage = Math.max(0, Math.ceil(Math.min(total, 15) / PANEL_PER_PAGE) - 1);
  _panelPage = Math.max(0, Math.min(_panelPage, maxPage));
  const start = _panelPage * PANEL_PER_PAGE;
  const slice = _panelAlbs.slice(start, start + PANEL_PER_PAGE);
  container.innerHTML = slice.map(a => albumHtml(a)).join('');
  const info = document.getElementById('panelPgInfo');
  if (info) info.textContent = `Pág.${_panelPage + 1}/${maxPage + 1} · ${Math.min(total,15)} vídeos`;
  const prev = document.getElementById('panelPrev');
  const next = document.getElementById('panelNext');
  if (prev) prev.disabled = _panelPage === 0;
  if (next) next.disabled = _panelPage >= maxPage;
}

function panelAlbPage(dir) {
  _panelPage += dir;
  _renderPanelPage();
}

function albumHtml(a) {
  const rank = a.rank ? `${a.rank}. ` : '';
  const esc  = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
  return `<div class="panel-album">
    <div class="album-meta">
      <span class="album-title">${rank}${esc(a.title)}</span>
      <span class="album-year">${a.year || ''}</span>
    </div>
    <div class="album-artist">${esc(a.artist)}</div>
    <div class="yt-wrap"><iframe
      src="https://www.youtube.com/embed/${a.yt_id}"
      allow="autoplay;encrypted-media" allowfullscreen loading="lazy"></iframe></div>
  </div>`;
}

function closePanel() {
  document.getElementById('panel').classList.remove('open');
  document.getElementById('tree-wrap').classList.remove('panel-open');
}

// ── Genre/Artist search navigation ────────────────────────────────────────
function ancestorPath(slug) {
  const path = [];
  let cur = slug;
  while (cur) { path.unshift(cur); cur = GENRE_META[cur]?.parent; }
  return path;
}

function expandPathInTree(node, path, depth) {
  if (node.slug !== path[depth]) return false;
  if (depth === path.length - 1) return true;
  if (node.children === null) expandNode(node);
  for (const child of (node.children || [])) {
    if (expandPathInTree(child, path, depth + 1)) return true;
  }
  return false;
}

function navigateToGenre(slug) {
  if (!GENRE_META[slug]) return;
  const path = ancestorPath(slug);
  const topSlug = path[0];
  highlightedSlug = slug;
  selectGenre(topSlug);
  if (path.length > 1 && treeRoot) {
    expandPathInTree(treeRoot, path, 0);
    render();
  }
  const wrap = document.getElementById('tree-wrap');
  svg.transition().duration(400).call(
    zoomBehavior.transform,
    d3.zoomIdentity.translate(80, wrap.clientHeight / 2).scale(1)
  );
}

function navigateToArtist(key) {
  const entry = ARTIST_INDEX[key];
  if (!entry || !entry.genres.length) return;
  const slug = entry.genres[0];
  navigateToGenre(slug);
  showPanel(slug);
}

// ── Generic autocomplete ──────────────────────────────────────────────────
function _esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function setupSb(inpId, ddId, getResults, onPick) {
  const inp = document.getElementById(inpId);
  const dd  = document.getElementById(ddId);
  let selIdx = -1;

  function showDd(items) {
    dd.innerHTML = '';
    if (!items.length) { dd.classList.remove('open'); return; }
    items.slice(0, 30).forEach(item => {
      const el = document.createElement('div');
      el.className = 'sb-item';
      el.innerHTML = item.html;
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        onPick(item.key);
        inp.value = '';
        dd.classList.remove('open');
      });
      dd.appendChild(el);
    });
    selIdx = -1;
    dd.classList.add('open');
  }

  inp.addEventListener('input', () => {
    const q = inp.value.trim();
    if (!q) { dd.classList.remove('open'); return; }
    showDd(getResults(q));
  });

  inp.addEventListener('keydown', e => {
    const items = dd.querySelectorAll('.sb-item');
    if (e.key === 'ArrowDown') { selIdx = Math.min(selIdx + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { selIdx = Math.max(selIdx - 1, 0); }
    else if (e.key === 'Enter' && selIdx >= 0) {
      items[selIdx].dispatchEvent(new MouseEvent('mousedown'));
      inp.value = ''; dd.classList.remove('open'); e.preventDefault(); return;
    } else if (e.key === 'Escape') { dd.classList.remove('open'); inp.blur(); return; }
    items.forEach((el, i) => el.classList.toggle('sb-sel', i === selIdx));
  });

  inp.addEventListener('blur', () => setTimeout(() => dd.classList.remove('open'), 150));
  document.addEventListener('click', e => {
    if (!inp.contains(e.target) && !dd.contains(e.target)) dd.classList.remove('open');
  });
}

setupSb('sb-genre-inp', 'sb-genre-dd',
  q => {
    const tokens = q.toLowerCase().trim().split(/[ \t]+/);
    return Object.entries(GENRE_META)
      .filter(([, m]) => tokens.every(t => m.name.toLowerCase().includes(t)))
      .slice(0, 30)
      .map(([slug, m]) => ({
        key: slug,
        html: `<span>${_esc(m.name)}</span><span class="sb-item-sub">${slug}</span>`,
      }));
  },
  slug => navigateToGenre(slug)
);

setupSb('sb-artist-inp', 'sb-artist-dd',
  q => {
    const tokens = q.toLowerCase().trim().split(/[ \t]+/);
    const results = [];
    for (const [key, entry] of Object.entries(ARTIST_INDEX)) {
      if (!tokens.every(t => key.includes(t))) continue;
      for (const slug of entry.genres) {
        results.push({
          key: key + '\x00' + slug,
          html: `<span>${_esc(entry.display)}</span><span class="sb-item-sub">${_esc(GENRE_META[slug]?.name || slug)}</span>`,
        });
      }
    }
    return results.slice(0, 30);
  },
  combined => {
    const sep = combined.indexOf('\x00');
    const slug = combined.slice(sep + 1);
    navigateToGenre(slug);
    showPanel(slug);
  }
);

// Close genre picker on outside click
document.addEventListener('click', e => {
  const picker = document.getElementById('genrePicker');
  if (picker && !picker.contains(e.target)) {
    document.getElementById('gpBtn').classList.remove('open');
    document.getElementById('gpDd').classList.remove('open');
  }
});

// ── Heard counting from IndexedDB ─────────────────────────────────────────
function _openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('mustlisten', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('sessions', {keyPath:'user'});
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function loadHeardFromIdb() {
  try {
    const username = localStorage.getItem('mh_user');
    if (!username) return;
    const db   = await _openIDB();
    const data = await new Promise((res, rej) => {
      const req = db.transaction('sessions','readonly').objectStore('sessions').get(username.toLowerCase());
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
    if (!data?.pairs?.length) return;
    const status = document.getElementById('user-status');
    if (status) status.textContent = `✓ ${data.pairs.length.toLocaleString()} álbumes (caché)`;
    _computeHeardFromPairs(data.pairs);
  } catch(e) { console.warn('loadHeardFromIdb:', e); }
}

// ── User scrobble loading ─────────────────────────────────────────────────
let _scrobbleEs = null;
let _currentPanelSlug = null;

function _computeHeardFromPairs(pairs) {
  // pairs: [[norm_a, norm_t, orig_a, orig_t, count], ...]
  const heardSet = new Set(pairs.map(p => (p[0]||'') + '\x00' + (p[1]||'')));
  HEARD = {};
  for (const [cs, albumPairs] of Object.entries(ALL_PAIRS)) {
    let n = 0;
    for (const [a, t] of albumPairs) {
      if (heardSet.has(a + '\x00' + t)) n++;
    }
    if (n > 0) HEARD[cs] = n;
  }
  if (treeRoot) render();
  if (_currentPanelSlug) showPanel(_currentPanelSlug);
}

async function loadUser() {
  const inp    = document.getElementById('user-input');
  const status = document.getElementById('user-status');
  const btn    = document.getElementById('user-load-btn');
  const username = (inp.value || '').trim().toLowerCase();
  if (!username) return;

  status.textContent = 'Buscando en caché…';
  try {
    const db   = await _openIDB();
    const data = await new Promise((res, rej) => {
      const req = db.transaction('sessions','readonly').objectStore('sessions').get(username);
      req.onsuccess = e => res(e.target.result || null);
      req.onerror   = e => rej(e.target.error);
    });
    if (data?.pairs?.length) {
      localStorage.setItem('mh_user', username);
      status.textContent = `✓ ${data.pairs.length.toLocaleString()} álbumes (caché)`;
      _computeHeardFromPairs(data.pairs);
      return;
    }
  } catch(e) {}

  // Fetch from Flask backend
  if (_scrobbleEs) { _scrobbleEs.close(); _scrobbleEs = null; }
  status.textContent = 'Conectando…';
  btn.disabled = true;

  _scrobbleEs = new EventSource(`/api/scrobbles?user=${encodeURIComponent(username)}`);
  _scrobbleEs.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.error) {
      status.textContent = `✗ ${msg.error}`;
      _scrobbleEs.close(); _scrobbleEs = null;
      btn.disabled = false;
      return;
    }
    if (msg.done) {
      _scrobbleEs.close(); _scrobbleEs = null;
      btn.disabled = false;
      localStorage.setItem('mh_user', username);
      status.textContent = `✓ ${msg.count.toLocaleString()} álbumes`;
      const sessionData = {
        user: username, pairs: msg.heard,
        fetched_at: msg.fetched_at,
        last_scrobble_ts: msg.last_scrobble_ts,
        last_scrobble_artist: msg.last_scrobble_artist,
        last_scrobble_track: msg.last_scrobble_track,
      };
      try {
        const db = await _openIDB();
        await new Promise((res, rej) => {
          const tx = db.transaction('sessions','readwrite');
          tx.objectStore('sessions').put(sessionData);
          tx.oncomplete = res; tx.onerror = err => rej(err.target.error);
        });
      } catch(err) { console.warn('IDB save:', err); }
      _computeHeardFromPairs(msg.heard);
    } else {
      status.textContent = `Pág.${msg.page}/${msg.total_pages} · ${(msg.count||0).toLocaleString()}…`;
    }
  };
  _scrobbleEs.onerror = () => {
    status.textContent = '✗ Error de conexión';
    _scrobbleEs.close(); _scrobbleEs = null;
    btn.disabled = false;
  };
}

// Init: restore session from localStorage / IDB
(function() {
  try {
    const u = localStorage.getItem('mh_user');
    if (u) {
      const inp = document.getElementById('user-input');
      if (inp) inp.value = u;
      loadHeardFromIdb();
    }
  } catch(e) {}
})();

// ── Event listeners (replaces all inline handlers) ────────────────────────
document.getElementById('user-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadUser();
});
document.getElementById('user-load-btn').addEventListener('click', loadUser);
document.getElementById('gpBtn').addEventListener('click', togglePicker);
document.getElementById('gpDd').addEventListener('click', e => {
  const link = e.target.closest('.mg-link');
  if (link) selectGenre(link.dataset.slug);
});
document.querySelector('.panel-close').addEventListener('click', closePanel);
document.getElementById('panelPrev').addEventListener('click', () => panelAlbPage(-1));
document.getElementById('panelNext').addEventListener('click', () => panelAlbPage(1));
