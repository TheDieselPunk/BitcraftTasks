'use strict';

const HEX = '⬡';
const REFRESH_MS = 5 * 60 * 1000;
const COLS = [
  { label: 'Traveler',      sort: 'traveler'  },
  { label: 'Items',         sort: null        },
  { label: 'My Inventory',  sort: null        },
  { label: 'Nearby Stalls', sort: null        },
  { label: 'Craftable',     sort: null        },
  { label: `Reward ${HEX}`, sort: 'reward'    },
  { label: `Cost ${HEX}`,   sort: 'cost'      },
  { label: `Profit ${HEX}`, sort: 'profit'    },
];

const S = {
  player:      null,   // {id, username, position: {n, e}}
  tasks:       [],     // enriched task objects
  stalls:      [],     // nearby stalls from /api/stalls
  sortCol:     'profit',
  sortAsc:     false,
  filterOn:    false,
  expiry:      null,
  stallRange:  500,
  refreshAt:   null,
  expiryTimer: null,
  refreshTimer: null,
  refreshCdTimer: null,
  tasksLoaded: false,
  stallsLoaded: false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const usernameInput = $('username-input');
const btnSearch     = $('btn-search');
const playerCard    = $('player-card');
const playerName    = $('player-name');
const playerPos     = $('player-pos');
const rangeSlider   = $('range-slider');
const rangeVal      = $('range-val');
const expiryCd      = $('expiry-cd');
const toolbar       = $('toolbar');
const btnRefresh    = $('btn-refresh');
const btnFilter     = $('btn-filter');
const btnCsv        = $('btn-csv');
const statusEl      = $('status');
const refreshCdEl   = $('refresh-cd');
const tblHead       = $('tbl-head');
const tblBody       = $('tbl-body');
const mainTbl       = $('main-tbl');
const emptyMsg      = $('empty-msg');

// ── Init ──────────────────────────────────────────────────────────────────────
buildHeader();

usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
btnSearch.addEventListener('click', doSearch);
btnRefresh.addEventListener('click', () => load());
btnFilter.addEventListener('click', () => {
  S.filterOn = !S.filterOn;
  btnFilter.classList.toggle('active', S.filterOn);
  render();
});
btnCsv.addEventListener('click', downloadCsv);
rangeSlider.addEventListener('input', () => {
  S.stallRange = +rangeSlider.value;
  rangeVal.textContent = S.stallRange;
  if (S.player?.position?.n != null) loadStalls();
});

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const username = usernameInput.value.trim();
  if (!username) return;
  btnSearch.disabled = true;
  setStatus('Looking up player…');
  clearTimers();

  try {
    const data = await apiFetch(`/api/search?username=${encodeURIComponent(username)}`);
    S.player = data;
    playerName.textContent = data.username;
    const pos = data.position;
    playerPos.textContent = pos?.n != null
      ? `N ${Math.round(pos.n)}, E ${Math.round(pos.e)}`
      : 'Position unknown';
    playerCard.classList.add('visible');
    toolbar.classList.add('visible');
    await load();
  } catch (err) {
    setStatus(`⚠ ${err.message}`);
  } finally {
    btnSearch.disabled = false;
  }
}

// ── Main load ─────────────────────────────────────────────────────────────────
async function load() {
  if (!S.player) return;
  S.tasksLoaded  = false;
  S.stallsLoaded = false;
  S.tasks        = [];
  S.stalls       = [];
  clearTimers();
  setStatus('Loading tasks…');
  emptyMsg.textContent = '';
  mainTbl.style.display = 'none';

  // Tasks and stalls load in parallel
  const posKnown = S.player.position?.n != null;
  await Promise.all([
    loadTasks(),
    posKnown ? loadStalls() : Promise.resolve(),
  ]);

  scheduleRefresh();
  setStatus('');
}

async function loadTasks() {
  try {
    const data = await apiFetch(`/api/tasks?player_id=${encodeURIComponent(S.player.id)}`);
    S.expiry = data.expiry;
    S.tasks  = data.tasks || [];
    S.tasksLoaded = true;
    startExpiryCountdown();
    if (!S.tasks.length) {
      emptyMsg.textContent = 'No incomplete tasks found.';
    }
    render();
  } catch (err) {
    setStatus(`⚠ Tasks: ${err.message}`);
  }
}

async function loadStalls() {
  const pos = S.player.position;
  try {
    setStatus('Loading nearby stalls…');
    const data = await apiFetch(
      `/api/stalls?n=${encodeURIComponent(pos.n)}&e=${encodeURIComponent(pos.e)}&range=${S.stallRange}`
    );
    S.stalls       = data.stalls || [];
    S.stallsLoaded = true;
    render();
  } catch (err) {
    setStatus(`⚠ Stalls: ${err.message}`);
    S.stallsLoaded = true;
    render();
  }
}

// ── Cross-reference stalls → task items ──────────────────────────────────────
function enrichStalls(task) {
  // Build item→stall lookup once per render
  const stallMap = {};  // item_id → [{name, owner, distance, qty, price}]
  for (const stall of S.stalls) {
    for (const it of (stall.items || [])) {
      if (!stallMap[it.id]) stallMap[it.id] = [];
      stallMap[it.id].push({
        name:     stall.name,
        owner:    stall.owner,
        distance: stall.distance,
        qty:      it.qty,
        price:    it.price,
      });
    }
  }
  return stallMap;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (!S.tasksLoaded) return;

  const stallMap = buildStallMap();

  let tasks = [...S.tasks].map(t => decorateTask(t, stallMap));

  // Sort
  tasks.sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return S.sortAsc ? cmp : -cmp;
  });

  // Filter
  if (S.filterOn) tasks = tasks.filter(isCompletable);

  if (!tasks.length && S.tasks.length) {
    emptyMsg.textContent = S.filterOn ? 'No completable tasks found.' : '';
  } else {
    emptyMsg.textContent = '';
  }

  mainTbl.style.display = tasks.length ? '' : 'none';
  tblBody.innerHTML = tasks.map(t => renderRow(t)).join('');
}

// Build a global stallMap (item_id → sorted-by-distance stall entries) once per render
function buildStallMap() {
  const map = {};
  for (const stall of S.stalls) {
    for (const it of (stall.items || [])) {
      if (!map[it.id]) map[it.id] = [];
      map[it.id].push({ name: stall.name, owner: stall.owner, distance: stall.distance, qty: it.qty, price: it.price });
    }
  }
  // Sort each entry list by distance
  for (const k of Object.keys(map)) map[k].sort((a, b) => a.distance - b.distance);
  return map;
}

function decorateTask(task, stallMap) {
  // Attach stall matches per item and compute cost/profit
  let totalCost = 0;
  let costKnown = true;
  const items = task.items.map(item => {
    const matches = (stallMap[item.id] || []).filter(e => e.qty >= item.qty);
    const cheapest = matches[0];  // already sorted by distance (closest first)
    if (cheapest?.price != null) {
      totalCost += cheapest.price * item.qty;
    } else {
      costKnown = false;
    }
    return { ...item, stall_matches: matches };
  });

  const cost   = costKnown && items.some(i => i.stall_matches.length) ? totalCost : null;
  const profit = cost != null ? task.reward - cost : null;

  return { ...task, items, cost, profit };
}

function sortVal(task) {
  switch (S.sortCol) {
    case 'traveler': return task.traveler;
    case 'reward':   return task.reward;
    case 'cost':     return task.cost;
    case 'profit':   return task.profit;
    default:         return null;
  }
}

function isCompletable(task) {
  return task.items.every(item => {
    if (item.inv_have >= item.qty)                 return true;
    if ((item.stall_matches || []).length > 0)     return true;
    if (item.craft_info?.status === 'yes')         return true;
    return false;
  });
}

function renderRow(task) {
  const itemsHtml = task.items.map(i =>
    `<span class="qty">${i.qty.toLocaleString()}×</span> ${esc(i.name)}`
  ).join('<br>');

  const invHtml = task.items.map(item => {
    if (!item.inv_have) return `<span class="dim">—</span>`;
    const cls = item.inv_have >= item.qty ? 'inv-ok' : 'inv-part';
    const tip = `${item.inv_have.toLocaleString()} / ${item.qty.toLocaleString()} needed`;
    return `<span class="${cls}" title="${esc(tip)}">${item.inv_have.toLocaleString()}</span>`;
  }).join('<br>');

  const stallHtml = task.items.map(item => {
    if (!S.stallsLoaded) return '⏳';
    const matches = item.stall_matches || [];
    if (!matches.length) return `<span class="dim">—</span>`;
    const shown = matches.slice(0, 3);
    const extra = matches.length - 3;
    const entries = shown.map(m => {
      const priceStr = m.price != null ? ` <span class="sub">${HEX}${m.price.toLocaleString()}</span>` : '';
      const dist     = `<span class="sub">${m.distance}u</span>`;
      return `<span class="stall-name">${esc(m.name || m.owner)}</span>${priceStr} ${dist}`;
    }).join(', ');
    const more = extra > 0 ? ` <span class="sub">+${extra}</span>` : '';
    return entries + more;
  }).join('<br>');

  const craftHtml = task.items.map(item => {
    const ci = item.craft_info;
    if (!ci || ci.status === 'none') return `<span class="na">—</span>`;
    const tip = (ci.details || []).map(d =>
      `${d.name}: ${d.have.toLocaleString()} / ${d.need.toLocaleString()}`
    ).join('\n');
    const bld = ci.building ? ` <span class="sub">(${esc(ci.building)})</span>` : '';
    if (ci.status === 'yes')     return `<span class="craft-ok" title="${esc(tip)}">✓${bld}</span>`;
    if (ci.status === 'partial') return `<span class="inv-part" title="${esc(tip)}">~${bld}</span>`;
    return `<span class="craft-no" title="${esc(tip)}">✗${bld}</span>`;
  }).join('<br>');

  const costStr   = task.cost   != null ? `${HEX} ${task.cost.toLocaleString()}`   : `<span class="dim">—</span>`;
  const profitStr = task.profit != null ? `${HEX} ${task.profit.toLocaleString()}` : `<span class="dim">—</span>`;
  const profitCls = task.profit == null ? '' : task.profit >= 0 ? ' profit-pos' : ' profit-neg';

  return `<tr class="task-row">
    <td class="c-traveler">${esc(task.traveler)}</td>
    <td class="c-items">${itemsHtml}</td>
    <td class="c-inv">${invHtml}</td>
    <td class="c-stalls">${stallHtml}</td>
    <td class="c-craft">${craftHtml}</td>
    <td class="c-num">${HEX} ${task.reward.toLocaleString()}</td>
    <td class="c-num">${costStr}</td>
    <td class="c-num${profitCls}">${profitStr}</td>
  </tr>`;
}

// ── Table header ──────────────────────────────────────────────────────────────
function buildHeader() {
  const tr = document.createElement('tr');
  tr.innerHTML = COLS.map(c => {
    const active = c.sort === S.sortCol;
    const ind    = active ? (S.sortAsc ? ' ↑' : ' ↓') : '';
    return `<th${c.sort ? ` class="sortable" data-sort="${c.sort}"` : ''}>${esc(c.label + ind)}</th>`;
  }).join('');
  tblHead.appendChild(tr);

  tblHead.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      S.sortAsc  = S.sortCol === col ? !S.sortAsc : false;
      S.sortCol  = col;
      // Update header indicators
      tblHead.querySelectorAll('th.sortable').forEach(h => {
        const c   = COLS.find(x => x.sort === h.dataset.sort);
        const act = h.dataset.sort === S.sortCol;
        h.textContent = (c?.label || '') + (act ? (S.sortAsc ? ' ↑' : ' ↓') : '');
      });
      render();
    });
  });
}

// ── Timers ────────────────────────────────────────────────────────────────────
function clearTimers() {
  clearInterval(S.expiryTimer);
  clearTimeout(S.refreshTimer);
  clearInterval(S.refreshCdTimer);
  S.expiryTimer = S.refreshTimer = S.refreshCdTimer = null;
}

function startExpiryCountdown() {
  if (!S.expiry) return;
  const tick = () => {
    const ms = S.expiry * 1000 - Date.now();
    if (ms <= 0) {
      expiryCd.textContent  = '⏰ Reset overdue';
      expiryCd.className    = 'cd-urgent';
      return;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    expiryCd.textContent = `⏱ ${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    expiryCd.className   = h < 1 ? 'cd-urgent' : 'cd-ok';
  };
  clearInterval(S.expiryTimer);
  tick();
  S.expiryTimer = setInterval(tick, 1000);
}

function scheduleRefresh() {
  S.refreshAt   = Date.now() + REFRESH_MS;
  S.refreshTimer = setTimeout(() => load(), REFRESH_MS);
  const tick = () => {
    if (!S.refreshAt) return;
    const ms = S.refreshAt - Date.now();
    if (ms <= 0) { refreshCdEl.textContent = ''; return; }
    const m = Math.floor(ms / 60000);
    const sc = Math.floor((ms % 60000) / 1000);
    refreshCdEl.textContent = `↺ ${m}:${String(sc).padStart(2,'0')}`;
  };
  tick();
  S.refreshCdTimer = setInterval(tick, 1000);
}

// ── Export ────────────────────────────────────────────────────────────────────
function downloadCsv() {
  const q  = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const stallMap = buildStallMap();
  const rows = [['Traveler','Item','Qty','Type','Inv Have','Stalls','Craftable','Reward','Cost','Profit'].join(',')];
  for (const task of S.tasks) {
    const decorated = decorateTask(task, stallMap);
    for (const item of decorated.items) {
      const stallStr = (item.stall_matches || []).map(m => `${m.name}(${m.qty}@${m.price ?? '?'}u${m.distance})`).join('; ');
      const ci       = item.craft_info;
      rows.push([
        q(task.traveler), q(item.name), item.qty, item.type, item.inv_have,
        q(stallStr), ci?.status || '', task.reward,
        decorated.cost ?? '', decorated.profit ?? '',
      ].join(','));
    }
  }
  const a    = document.createElement('a');
  a.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(rows.join('\n'));
  a.download = 'traveler-tasks.csv';
  a.click();
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function setStatus(msg) { statusEl.textContent = msg; }
function esc(s)         { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function apiFetch(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}
