'use strict';

const HEX = '⬡';
const REFRESH_MS = 5 * 60 * 1000;

const S = {
  player:       null,   // {id, username, locationX, locationZ, regionId, claimName, claimId}
  tasks:        [],
  stalls:       [],
  filterOn:     false,
  stallRange:   1000,
  expiry:       null,
  tasksLoaded:  false,
  stallsLoaded: false,
  expiryTimer:    null,
  refreshTimer:   null,
  refreshCdTimer: null,
  refreshAt:      null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const usernameInput  = $('username-input');
const btnSearch      = $('btn-search');
const playerStrip    = $('player-strip');
const playerName     = $('player-strip-name');
const playerDetail   = $('player-strip-detail');
const expiryCd       = $('expiry-cd');
const rangeSlider    = $('range-slider');
const rangeVal       = $('range-val');
const toolbar        = $('toolbar');
const btnRefresh     = $('btn-refresh');
const btnFilter      = $('btn-filter');
const btnCsv         = $('btn-csv');
const taskCount      = $('task-count');
const statusEl       = $('status');
const refreshCdEl    = $('refresh-cd');
const cardsWrap      = $('cards-wrap');
const emptyMsg       = $('empty-msg');

// ── Event listeners ───────────────────────────────────────────────────────────
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
  if (S.player?.locationX != null) loadStalls();
});

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const username = usernameInput.value.trim();
  if (!username) return;
  btnSearch.disabled = true;
  setStatus('Looking up player…');
  clearTimers();
  cardsWrap.innerHTML = '';
  emptyMsg.textContent = '';

  try {
    const data = await apiFetch(`/api/search?username=${encodeURIComponent(username)}`);
    S.player = data;

    playerName.textContent = data.username;
    const parts = [];
    if (data.locationX != null) parts.push(`X ${Math.round(data.locationX)}, Z ${Math.round(data.locationZ)}`);
    if (data.claimName)         parts.push(data.claimName);
    if (data.regionId)          parts.push(`Region ${data.regionId}`);
    playerDetail.textContent = parts.join(' · ');

    playerStrip.classList.add('visible');
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
  S.tasks  = [];
  S.stalls = [];
  clearTimers();
  setStatus('Loading…');
  cardsWrap.innerHTML = '';
  emptyMsg.textContent = '';

  await Promise.all([
    loadTasks(),
    S.player.locationX != null ? loadStalls() : Promise.resolve(),
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
    render();
  } catch (err) {
    setStatus(`⚠ Tasks: ${err.message}`);
    S.tasksLoaded = true;
    render();
  }
}

async function loadStalls() {
  const { locationX: x, locationZ: z } = S.player;
  try {
    const data = await apiFetch(`/api/stalls?x=${x}&z=${z}&range=${S.stallRange}`);
    S.stalls       = data.stalls || [];
    S.stallsLoaded = true;
    render();
  } catch (err) {
    S.stallsLoaded = true;
    render();
  }
}

// ── Stall map ─────────────────────────────────────────────────────────────────
function buildStallMap() {
  // item_id → [{name, owner, claimName, distance, qty, stock, price, price_item}]
  const map = {};
  for (const stall of S.stalls) {
    for (const it of (stall.items || [])) {
      if (!map[it.id]) map[it.id] = [];
      map[it.id].push({
        name:       stall.name,
        owner:      stall.owner,
        claimName:  stall.claimName,
        distance:   stall.distance,
        qty:        it.qty,
        stock:      it.stock,
        price:      it.price,
        price_item: it.price_item,
      });
    }
  }
  for (const k of Object.keys(map)) map[k].sort((a, b) => a.distance - b.distance);
  return map;
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (!S.tasksLoaded) return;

  const stallMap = buildStallMap();
  let tasks = S.tasks.map(t => decorateTask(t, stallMap));

  // Sort by profit desc, then reward desc
  tasks.sort((a, b) => {
    const pa = a.profit ?? -Infinity, pb = b.profit ?? -Infinity;
    if (pa !== pb) return pb - pa;
    return (b.reward || 0) - (a.reward || 0);
  });

  if (S.filterOn) tasks = tasks.filter(isCompletable);

  if (!tasks.length) {
    emptyMsg.textContent = S.tasks.length
      ? (S.filterOn ? 'No completable tasks found.' : 'No incomplete tasks found.')
      : 'No tasks returned.';
    cardsWrap.innerHTML = '';
    taskCount.textContent = '';
    return;
  }

  emptyMsg.textContent = '';
  taskCount.textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;
  cardsWrap.innerHTML = tasks.map(renderCard).join('');
}

function decorateTask(task, stallMap) {
  const items = task.items.map(item => {
    const matches = (stallMap[item.id] || []).filter(e => e.qty >= item.qty || e.stock == null || e.stock >= item.qty);
    return { ...item, stall_matches: matches };
  });

  let totalCost = 0, costKnown = true;
  for (const item of items) {
    const best = item.stall_matches.find(m => m.price != null);
    if (best) totalCost += best.price * item.qty;
    else       costKnown = false;
  }

  const hasAnyStall = items.some(i => i.stall_matches.length > 0);
  const cost   = costKnown && hasAnyStall ? totalCost : null;
  const profit = cost != null ? task.reward - cost : null;

  return { ...task, items, cost, profit };
}

function isCompletable(task) {
  return task.items.every(item =>
    item.inv_have >= item.qty ||
    item.stall_matches.length > 0 ||
    item.craft_info?.status === 'yes'
  );
}

// ── Card renderer ─────────────────────────────────────────────────────────────
function renderCard(task) {
  const initial = (task.traveler || '?')[0].toUpperCase();

  const itemsHtml = task.items.map(item => {
    // Inventory row
    const invClass = !item.inv_have ? 'val-no'
                   : item.inv_have >= item.qty ? 'val-ok' : 'val-part';
    const invText  = item.inv_have
      ? `${item.inv_have.toLocaleString()} / ${item.qty.toLocaleString()} in inventory`
      : 'Not in inventory';

    // Stall row
    let stallHtml = '';
    if (!S.stallsLoaded) {
      stallHtml = `<div class="meta-row"><span class="meta-icon">⊙</span><span class="loading">Loading stalls…</span></div>`;
    } else if (item.stall_matches.length) {
      const m     = item.stall_matches[0];
      const label = m.claimName || m.name || m.owner;
      const dist  = `${m.distance.toLocaleString()} u`;
      const price = m.price != null
        ? `<span class="val-gold">${HEX}${m.price.toLocaleString()}</span> ea · `
        : '';
      const extra = item.stall_matches.length > 1
        ? ` <span class="val-no">+${item.stall_matches.length - 1} more</span>` : '';
      stallHtml = `<div class="meta-row"><span class="meta-icon">⊙</span><span class="meta-text"><span class="val-stall">${esc(label)}</span> · ${price}<span class="val-no">${dist}</span>${extra}</span></div>`;
    } else {
      stallHtml = `<div class="meta-row"><span class="meta-icon">⊙</span><span class="val-no">No nearby stalls</span></div>`;
    }

    // Craft row
    let craftHtml = '';
    const ci = item.craft_info;
    if (ci && ci.status !== 'none') {
      const tip = (ci.details || []).map(d => `${d.name}: ${d.have}/${d.need}`).join(', ');
      const bld = ci.building ? ` · ${esc(ci.building)}` : '';
      const cls = ci.status === 'yes' ? 'val-ok' : ci.status === 'partial' ? 'val-part' : 'val-no';
      const sym = ci.status === 'yes' ? '✓' : ci.status === 'partial' ? '~' : '✗';
      craftHtml = `<div class="meta-row"><span class="meta-icon">⚒</span><span class="${cls}" title="${esc(tip)}">${sym} Craftable${bld}</span></div>`;
    }

    const typeTag = item.type === 'cargo'
      ? `<span class="item-type">cargo</span>` : '';

    return `<div class="item-block">
      <div class="item-row">
        <span class="item-qty">${item.qty.toLocaleString()}×</span>
        <span class="item-name">${esc(item.name)}</span>${typeTag}
      </div>
      <div class="item-meta">
        <div class="meta-row"><span class="meta-icon">⊞</span><span class="${invClass}">${invText}</span></div>
        ${stallHtml}${craftHtml}
      </div>
    </div>`;
  }).join('');

  const costStr   = task.cost   != null ? `Cost: ${HEX}${task.cost.toLocaleString()}` : '';
  const profitCls = task.profit == null ? '' : task.profit >= 0 ? 'profit-pos' : 'profit-neg';
  const profitStr = task.profit != null
    ? `<span class="footer-profit ${profitCls}">${task.profit >= 0 ? '+' : ''}${HEX}${task.profit.toLocaleString()}</span>`
    : '';

  const completable = isCompletable(task);
  const completeDot = completable
    ? `<span title="Completable" style="color:var(--green);font-size:.8rem;">●</span>`
    : `<span title="Not completable" style="color:var(--text-dim);font-size:.8rem;">○</span>`;

  return `<div class="task-card">
    <div class="card-header">
      <span class="card-label">Traveler Task ${completeDot}</span>
      <span class="card-reward">${HEX} ${task.reward.toLocaleString()}</span>
    </div>
    <div class="card-traveler">
      <div class="traveler-icon">${esc(initial)}</div>
      <div>
        <div class="traveler-name">${esc(task.traveler)}</div>
      </div>
    </div>
    <div class="card-divider"></div>
    <div class="card-items">${itemsHtml}</div>
    <div class="card-footer">
      <span class="footer-cost">${costStr}</span>
      ${profitStr}
    </div>
  </div>`;
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
      expiryCd.textContent = '⏰ Tasks expired';
      expiryCd.className   = 'cd-urgent';
      return;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    expiryCd.textContent = `⏱ ${h}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`;
    expiryCd.className   = h < 1 ? 'cd-urgent' : h < 2 ? 'cd-warn' : 'cd-ok';
  };
  clearInterval(S.expiryTimer);
  tick();
  S.expiryTimer = setInterval(tick, 1000);
}

function scheduleRefresh() {
  S.refreshAt    = Date.now() + REFRESH_MS;
  S.refreshTimer = setTimeout(() => load(), REFRESH_MS);
  const tick = () => {
    if (!S.refreshAt) return;
    const ms = S.refreshAt - Date.now();
    if (ms <= 0) { refreshCdEl.textContent = ''; return; }
    const m  = Math.floor(ms / 60000);
    const sc = Math.floor((ms % 60000) / 1000);
    refreshCdEl.textContent = `↺ ${m}:${String(sc).padStart(2,'0')}`;
  };
  tick();
  S.refreshCdTimer = setInterval(tick, 1000);
}

// ── CSV export ────────────────────────────────────────────────────────────────
function downloadCsv() {
  const q  = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const stallMap = buildStallMap();
  const rows = [['Traveler','Item','Qty','Type','Inv Have','Best Stall','Stall Price','Stall Dist','Craftable','Reward','Cost','Profit'].join(',')];
  for (const task of S.tasks) {
    const dt = decorateTask(task, stallMap);
    for (const item of dt.items) {
      const best = item.stall_matches[0];
      rows.push([
        q(task.traveler), q(item.name), item.qty, item.type, item.inv_have,
        q(best?.claimName || best?.name || ''), best?.price ?? '', best?.distance ?? '',
        item.craft_info?.status || '', task.reward, dt.cost ?? '', dt.profit ?? '',
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
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function apiFetch(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}
