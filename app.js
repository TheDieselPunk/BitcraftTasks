'use strict';

const APP_VERSION = '1.2.0';
const HEX = '⬡';

const COLS = [
  { label: 'Traveler',         sort: 'traveler' },
  { label: 'Items',            sort: null        },
  { label: 'My Inventory',     sort: null        },
  { label: 'Nearby Stalls',    sort: null        },
  { label: 'Claim Market',     sort: null        },
  { label: 'Craftable',        sort: null        },
  { label: `Reward ${HEX}`,   sort: 'reward'    },
  { label: `Cost ${HEX}`,     sort: 'cost'      },
  { label: `Profit ${HEX}`,   sort: 'profit'    },
];

const S = {
  player:        null,
  tasks:         [],
  stalls:        [],
  barterSources: [],
  marketMap:     {},
  marketClaim:   null,
  sortCol:       'profit',
  sortAsc:       false,
  filterOn:      false,
  expiry:        null,
  tasksLoaded:   false,
  stallsLoaded:  false,
  expiryTimer:   null,
  notifyArmed:   false,
  watchedStalls:   JSON.parse(localStorage.getItem('bcTasks_watched') || '[]'),
  housedPlayers:   JSON.parse(localStorage.getItem('bcTasks_housing') || '[]'),
  selectedClaimId: localStorage.getItem('bcTasks_selectedClaim') || null,
  allClaims:       [],
  marketRangeH:    parseInt(localStorage.getItem('bcTasks_marketRange') || '0', 10),
  housingSources:  [],
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $            = id => document.getElementById(id);
const usernameInput = $('username-input');
const btnSearch     = $('btn-search');
const playerStrip   = $('player-strip');
const psName        = $('ps-name');
const psDetail      = $('ps-detail');
const psMarket      = $('ps-market');
const claimInput    = $('claim-input');
const claimList     = $('claim-list');
let   claimNameMap  = {};   // name → id
const expiryCd      = $('expiry-cd');
const expSection    = $('exp-section');
const watchRow      = $('watch-row');
const watchInput    = $('watch-input');
const btnWatchAdd   = $('btn-watch-add');
const watchChips    = $('watch-chips');
const housingRow    = $('housing-row');
const housingInput  = $('housing-input');
const btnHousingAdd = $('btn-housing-add');
const housingChips  = $('housing-chips');
const marketRange   = $('market-range');
const rangeVal      = $('range-val');
const ownersList    = $('stall-owners-list');
const toolbar       = $('toolbar');
const btnRefresh    = $('btn-refresh');
const btnFilter     = $('btn-filter');
const btnCsv        = $('btn-csv');
const statusEl      = $('status');
const tblHead       = $('tbl-head');
const tblBody       = $('tbl-body');
const mainTbl       = $('main-tbl');
const emptyMsg      = $('empty-msg');
const tipBox        = $('tip-box');

// ── Init ──────────────────────────────────────────────────────────────────────
buildHeader();
renderWatchChips();
renderHousingChips();

// Restore saved player name
const _savedName = localStorage.getItem('bcTasks_username');
if (_savedName) usernameInput.value = _savedName;

// Restore saved market range slider
marketRange.value    = S.marketRangeH;
rangeVal.textContent = S.marketRangeH === 0 ? '0h' : `${S.marketRangeH}h`;

// Set version label
$('app-version').textContent = `v${APP_VERSION}`;

usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
btnSearch.addEventListener('click', doSearch);
btnRefresh.addEventListener('click', () => { S.notifyArmed = true; load(); });
btnFilter.addEventListener('click', () => {
  S.filterOn = !S.filterOn;
  btnFilter.classList.toggle('active', S.filterOn);
  render();
});
btnCsv.addEventListener('click', downloadCsv);

// ── Watched stalls ─────────────────────────────────────────────────────────────
function saveWatched() {
  localStorage.setItem('bcTasks_watched', JSON.stringify(S.watchedStalls));
}

function addWatch(name) {
  const n = name.trim();
  if (!n || S.watchedStalls.includes(n)) return;
  S.watchedStalls.push(n);
  saveWatched();
  renderWatchChips();
  if (S.player?.locationX != null) loadStalls();
}

function removeWatch(name) {
  S.watchedStalls = S.watchedStalls.filter(n => n !== name);
  saveWatched();
  renderWatchChips();
  if (S.player?.locationX != null) loadStalls();
}

function renderWatchChips() {
  watchChips.innerHTML = S.watchedStalls.map(n =>
    `<span class="watch-chip">${esc(n)}<button onclick='removeWatch(${JSON.stringify(n)})' title="Remove">×</button></span>`
  ).join('');
}

btnWatchAdd.addEventListener('click', () => { addWatch(watchInput.value); watchInput.value = ''; });
watchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { addWatch(watchInput.value); watchInput.value = ''; } });

// ── Housed players ─────────────────────────────────────────────────────────────
function saveHoused() {
  localStorage.setItem('bcTasks_housing', JSON.stringify(S.housedPlayers));
}

function addHousing(name) {
  const n = name.trim();
  if (!n || S.housedPlayers.includes(n)) return;
  S.housedPlayers.push(n);
  saveHoused();
  renderHousingChips();
  if (S.player?.locationX != null) loadStalls();
}

function removeHousing(name) {
  S.housedPlayers = S.housedPlayers.filter(n => n !== name);
  saveHoused();
  renderHousingChips();
  if (S.player?.locationX != null) loadStalls();
}

function renderHousingChips() {
  housingChips.innerHTML = S.housedPlayers.map(n =>
    `<span class="housing-chip">${esc(n)}<button onclick='removeHousing(${JSON.stringify(n)})' title="Remove">×</button></span>`
  ).join('');
}

btnHousingAdd.addEventListener('click', () => { addHousing(housingInput.value); housingInput.value = ''; });
housingInput.addEventListener('keydown', e => { if (e.key === 'Enter') { addHousing(housingInput.value); housingInput.value = ''; } });

claimInput.addEventListener('change', () => {
  const val = claimInput.value.trim();
  const id  = claimNameMap[val];
  if (!id) return;
  S.selectedClaimId = id;
  localStorage.setItem('bcTasks_selectedClaim', id);
  localStorage.setItem('bcTasks_selectedClaimName', val);
  if (S.player) load();
});

// ── Market range slider ────────────────────────────────────────────────────────
let _rangeDebounce = null;
marketRange.addEventListener('input', () => {
  S.marketRangeH = parseInt(marketRange.value, 10);
  rangeVal.textContent = S.marketRangeH === 0 ? '0h' : `${S.marketRangeH}h`;
  localStorage.setItem('bcTasks_marketRange', S.marketRangeH);
  clearTimeout(_rangeDebounce);
  _rangeDebounce = setTimeout(() => { if (S.player) loadTasks(); }, 600);
});

// ── Tooltip ────────────────────────────────────────────────────────────────────
function showTip(e, html) {
  tipBox.innerHTML = html;
  tipBox.style.display = 'block';
  moveTip(e);
}
function moveTip(e) {
  tipBox.style.left = (e.clientX + 14) + 'px';
  tipBox.style.top  = (e.clientY + 14) + 'px';
}
function hideTip() { tipBox.style.display = 'none'; }

document.addEventListener('mousemove', e => {
  if (tipBox.style.display !== 'none') moveTip(e);
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
    localStorage.setItem('bcTasks_username', username);

    psName.textContent = data.username;
    const parts = [];
    if (data.locationX != null) parts.push(`N ${Math.round(data.locationZ / 3)}, E ${Math.round(data.locationX / 3)}`);
    if (data.regionId)          parts.push(`Region ${data.regionId}`);
    psDetail.textContent = parts.join(' · ');

    if (data.allClaims?.length) {
      S.allClaims  = data.allClaims;
      claimNameMap = {};
      data.allClaims.forEach(c => { claimNameMap[`${c.name} (${c.dist}h)`] = c.id; });
      claimList.innerHTML = data.allClaims
        .map(c => `<option value="${esc(c.name)} (${c.dist}h)">`)
        .join('');
      const savedName = S.selectedClaimId && data.allClaims.find(c => c.id === S.selectedClaimId);
      const defaultC  = savedName || data.allClaims[0];
      S.selectedClaimId = defaultC.id;
      const claimLabel  = `${defaultC.name} (${defaultC.dist}h)`;
      claimInput.value  = claimLabel;
      localStorage.setItem('bcTasks_selectedClaim',     S.selectedClaimId);
      localStorage.setItem('bcTasks_selectedClaimName', claimLabel);
    }
    playerStrip.classList.add('visible');
    watchRow.classList.add('visible');
    housingRow.classList.add('visible');
    toolbar.classList.add('visible');
    if (Notification.permission === 'default') Notification.requestPermission();
    S.notifyArmed = true;   // user is actively checking in — arm the reset notification
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
  S.tasks          = [];
  S.stalls         = [];
  S.barterSources  = [];
  S.housingSources = [];
  S.marketMap      = {};
  S.marketClaim    = null;
  clearTimers();
  setStatus('Loading…');
  emptyMsg.textContent = '';
  mainTbl.style.display = 'none';

  await Promise.all([
    loadTasks(),
    S.player.locationX != null ? loadStalls() : Promise.resolve(),
  ]);

  setStatus('');
}

function getClaimsInRange(rangeH) {
  if (!S.selectedClaimId || !S.allClaims.length) return null;
  const sel = S.allClaims.find(c => c.id === S.selectedClaimId);
  if (!sel || sel.x == null || sel.z == null) return null;
  return S.allClaims.filter(c => {
    if (c.x == null || c.z == null) return false;
    const dx = c.x - sel.x, dz = c.z - sel.z;
    return Math.sqrt(dx * dx + dz * dz) / 3 <= rangeH;
  });
}

async function loadTasks() {
  try {
    let url = `/api/tasks?player_id=${encodeURIComponent(S.player.id)}`;
    if (S.marketRangeH > 0) {
      const inRange = getClaimsInRange(S.marketRangeH);
      if (inRange && inRange.length) {
        const pairs = inRange.map(c => encodeURIComponent(c.id + ':' + c.name));
        url += `&market_claims=${pairs.join(',')}`;
      } else if (S.selectedClaimId) {
        url += `&claim_id=${encodeURIComponent(S.selectedClaimId)}`;
      }
    } else if (S.selectedClaimId) {
      url += `&claim_id=${encodeURIComponent(S.selectedClaimId)}`;
    }
    const data = await apiFetch(url);
    S.expiry      = data.expiry;
    S.tasks       = data.tasks || [];
    S.tasksLoaded = true;
    startExpiryCountdown();
    if (data.expiry && data.expiry * 1000 < Date.now()) {
      emptyMsg.textContent = 'Tasks appear stale — the server may not have refreshed yet. Try again in a moment.';
      S.tasks = [];
    } else if (!S.tasks.length) {
      emptyMsg.textContent = 'No incomplete tasks found.';
    }
    render();
  } catch (err) {
    setStatus(`⚠ Tasks: ${err.message}`);
    S.tasksLoaded = true;
    render();
  }
}

async function loadStalls() {
  const { locationX: x, locationZ: z, regionId } = S.player;
  try {
    const params = [`x=${x}`, `z=${z}`];
    if (regionId) params.push(`regionId=${regionId}`);
    if (S.selectedClaimId) {
      params.push(`claimId=${S.selectedClaimId}`);
      const selClaim = (S.allClaims || []).find(c => c.id === S.selectedClaimId);
      if (selClaim) params.push(`claimName=${encodeURIComponent(selClaim.name)}`);
    }
    if (S.watchedStalls.length)  params.push(`watch=${encodeURIComponent(S.watchedStalls.join(','))}`);
    if (S.housedPlayers.length)  params.push(`housing=${encodeURIComponent(S.housedPlayers.join(','))}`);
    const data = await apiFetch(`/api/stalls?${params.join('&')}`);
    S.stalls         = data.stalls || [];
    S.barterSources  = data.barterSources || [];
    S.housingSources = data.housingSources || [];
    S.marketMap     = data.nearestMarket?.items  || {};
    S.marketClaim   = data.nearestMarket || null;
    S.stallsLoaded  = true;

    // Populate autocomplete datalist with region stall owners
    if (data.ownerNames?.length) {
      ownersList.innerHTML = data.ownerNames.map(n => `<option value="${esc(n)}">`).join('');
    }


    render();
  } catch (err) {
    S.stallsLoaded = true;
    render();
  }
}

// ── Stall map (nearby) ────────────────────────────────────────────────────────
function buildStallMap() {
  const map = {};
  for (const stall of S.stalls.filter(s => s.items?.length)) {
    for (const it of stall.items) {
      if (!map[it.id]) map[it.id] = [];
      map[it.id].push({
        name:        stall.name,
        owner:       stall.owner,
        claimName:   stall.claimName,
        distance:    stall.distance,
        watched:     stall.watched || false,
        isBarter:    false,
        qty:         it.qty,
        stock:       it.stock,
        price_parts: it.price_parts || [],
      });
    }
  }
  // Add barter stall sources (claim inventory)
  for (const bs of S.barterSources) {
    for (const [itemId, itemData] of Object.entries(bs.items)) {
      if (!map[itemId]) map[itemId] = [];
      map[itemId].push({
        name:        bs.nickname,
        owner:       '',
        claimName:   bs.claimName,
        distance:    bs.distance,
        watched:     false,
        isBarter:    true,
        qty:         itemData.qty,
        stock:       itemData.qty,
        price_parts: [],
      });
    }
  }
  // Add housing sources
  for (const hs of S.housingSources) {
    for (const storage of hs.storages) {
      for (const [itemId, qty] of Object.entries(storage.items)) {
        if (!map[itemId]) map[itemId] = [];
        map[itemId].push({
          name:         `${hs.playerName}'s House`,
          storageLabel: storage.label,
          owner:        hs.playerName,
          claimName:    '',
          distance:     null,
          watched:      false,
          isBarter:     false,
          isHousing:    true,
          qty:          qty,
          stock:        qty,
          price_parts:  [],
        });
      }
    }
  }

  for (const k of Object.keys(map)) map[k].sort((a, b) => {
    if (a.watched !== b.watched) return a.watched ? -1 : 1;
    if (a.isHousing !== b.isHousing) return a.isHousing ? 1 : -1;
    if (a.isBarter  !== b.isBarter)  return a.isBarter  ? 1 : -1;
    if (a.distance == null && b.distance == null) return 0;
    if (a.distance == null) return 1;
    if (b.distance == null) return -1;
    return a.distance - b.distance;
  });
  return map;
}

// Returns the per-unit Hex Coin price from price_parts, or null if barter-only
function hexPrice(price_parts) {
  const coin = (price_parts || []).find(p => p.name === 'Hex Coin');
  return coin ? coin.qty : null;
}

// Renders price_parts as "⬡12/u" or "3 Parchment/u" (all per-unit, integers)
function priceHtml(price_parts) {
  if (!price_parts?.length) return '';
  return price_parts.map(p => {
    const q = Math.round(p.qty).toLocaleString();
    if (p.name === 'Hex Coin') return `<span class="sub">${HEX}${q}/u</span>`;
    return `<span class="sub">${q} ${esc(p.name)}/u</span>`;
  }).join(' <span class="sub">+</span> ');
}

// ── EXP summary ───────────────────────────────────────────────────────────────
function renderExpTable(tasks) {
  const totals = {};
  for (const t of tasks) {
    if (!t.exp_qty) continue;
    const key = t.skill_name || t.exp_skill_id || t.traveler;
    if (!key) continue;
    totals[key] = (totals[key] || 0) + t.exp_qty;
  }
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { expSection.innerHTML = ''; return; }
  const label = S.filterOn ? 'Completable EXP' : 'Potential EXP';
  expSection.innerHTML =
    `<span class="exp-label">${label}:</span>` +
    entries.map(([skill, total]) =>
      `<span class="exp-chip"><span class="exp-skill">${esc(skill)}</span><span class="exp-amt">${total.toLocaleString()}</span></span>`
    ).join('');
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  if (!S.tasksLoaded) return;

  const stallMap = buildStallMap();
  let tasks = [...S.tasks].map(t => decorateTask(t, stallMap));

  tasks.sort((a, b) => {
    const va = sortVal(a), vb = sortVal(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return S.sortAsc ? cmp : -cmp;
  });

  renderExpTable(S.filterOn ? tasks.filter(isCompletable) : tasks);

  if (S.filterOn) tasks = tasks.filter(isCompletable);

  if (!tasks.length) {
    emptyMsg.textContent = S.filterOn ? 'No completable tasks found.' : (S.tasks.length ? '' : 'No incomplete tasks found.');
    mainTbl.style.display = 'none';
    return;
  }

  emptyMsg.textContent = '';
  mainTbl.style.display = '';
  tblBody.innerHTML = tasks.map(renderRow).join('');
  bindTips();
}

function decorateTask(task, stallMap) {
  const items = task.items.map(item => {
    const nearby = (stallMap[item.id] || []).filter(e => e.stock == null || e.stock >= item.qty);
    return { ...item, stall_matches: nearby };
  });

  // Cost: cheapest coin price (barter sources have no coin cost — excluded)
  let totalCost = 0, costKnown = true;
  for (const item of items) {
    const candidates = [];
    if (item.market_price != null) candidates.push(item.market_price);
    for (const m of (item.stall_matches || [])) {
      if (m.isBarter) continue;
      const sp = hexPrice(m.price_parts);
      if (sp != null) candidates.push(sp);
    }
    const buyQty = Math.max(0, item.qty - (item.inv_have || 0));
    if (candidates.length) totalCost += Math.min(...candidates) * buyQty;
    else if (buyQty > 0) costKnown = false;
  }
  const hasSource = items.some(i => i.stall_matches.length > 0 || i.market_price != null);
  const cost   = costKnown && hasSource ? totalCost : null;
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
  return task.items.every(item =>
    item.inv_have >= item.qty ||
    (item.stall_matches || []).length > 0 ||
    item.market_price != null ||
    item.craft_info?.status === 'yes'
  );
}

// ── Row renderer ──────────────────────────────────────────────────────────────
function renderRow(task) {
  // Items column
  const itemsHtml = task.items.map(i => {
    const tag = i.type === 'cargo' ? ` <span class="type-tag">cargo</span>` : '';
    return `<span class="qty">${i.qty.toLocaleString()}×</span> ${esc(i.name)}${tag}`;
  }).join('<br>');

  // Inventory column
  const invHtml = task.items.map(item => {
    if (!item.inv_have) return `<span class="dim">—</span>`;
    const cls = item.inv_have >= item.qty ? 'inv-ok' : 'inv-part';
    const locs = (item.inv_locations || [])
      .map(l => `${l.qty.toLocaleString()} in ${l.label}`)
      .join('\n');
    const tipText = `${item.inv_have.toLocaleString()} / ${item.qty.toLocaleString()} needed${locs ? '\n' + locs : ''}`;
    return `<span class="${cls}" data-tip="${esc(tipText)}">${item.inv_have.toLocaleString()}</span>`;
  }).join('<br>');

  // Nearby stalls column
  const stallHtml = task.items.map(item => {
    if (!S.stallsLoaded) return '<span class="dim">⏳</span>';
    const matches = item.stall_matches || [];
    if (!matches.length) return `<span class="na">—</span>`;
    const lines = matches.map(m => {
      if (m.isHousing) {
        return `<span class="housing-name">${esc(m.name)}</span> <span class="sub">(${esc(m.storageLabel)})</span>`;
      }
      const distStr   = m.distance != null
        ? `<span class="sub">${Math.round(m.distance / 3).toLocaleString()}h</span>`
        : `<span class="sub dim">?h</span>`;
      if (m.isBarter) {
        const claimStr = m.claimName ? ` <span class="sub">(${esc(m.claimName)} · Barter Stall)</span>` : ` <span class="sub">(Barter Stall)</span>`;
        return `<span class="stall-name">${esc(m.name)}</span>${claimStr} <span class="sub profit-neutral">(⬡?)</span> ${distStr}`;
      }
      const ph        = priceHtml(m.price_parts);
      const coinPrice = hexPrice(m.price_parts);
      const buyQty    = Math.max(0, item.qty - (item.inv_have || 0));
      const profit    = coinPrice != null ? task.reward - coinPrice * buyQty : null;
      const profitStr = profit != null
        ? ` <span class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">(${HEX}${profit.toLocaleString()})</span>`
        : '';
      const watchedMark = m.watched ? `<span style="color:#f0a500" title="Watched">★ </span>` : '';
      const displayName = m.name !== m.owner && m.name ? m.name : m.owner;
      return `${watchedMark}<span class="stall-name">${esc(displayName)}</span>${ph ? ' · ' + ph : ''}${profitStr} ${distStr}`;
    });
    return lines.join('<br>');
  }).join('<br>');

  // Market price column
  const marketHtml = task.items.map(item => {
    if (!S.tasksLoaded) return '<span class="dim">⏳</span>';
    const prices = item.market_prices;
    if (prices && prices.length > 0) {
      if (S.marketRangeH > 0) {
        // Multi-claim: show each price with claim name, sorted ascending
        return prices.map(mp => {
          const unit  = mp.price.toLocaleString();
          const total = (mp.price * item.qty).toLocaleString();
          const claim = mp.claimName ? ` <span class="sub">(${esc(mp.claimName)})</span>` : '';
          return `<span class="market-price">${HEX}${unit}</span>${claim} <span class="sub">(${HEX}${total})</span>`;
        }).join('<br>');
      } else {
        const mp    = prices[0];
        const unit  = mp.price.toLocaleString();
        const total = (mp.price * item.qty).toLocaleString();
        return `<span class="market-price">${HEX}${unit}</span> <span class="sub">(${HEX}${total})</span>`;
      }
    }
    if (item.market_price == null) return `<span class="dim">not listed</span>`;
    const unit  = item.market_price.toLocaleString();
    const total = (item.market_price * item.qty).toLocaleString();
    return `<span class="market-price">${HEX}${unit}</span> <span class="sub">(${HEX}${total})</span>`;
  }).join('<br>');

  // Craftable column
  const craftHtml = task.items.map(item => {
    const ci = item.craft_info;
    if (!ci || ci.status === 'none') return `<span class="craft-no">—</span>`;
    const tip = (ci.details || []).map(d =>
      `${esc(d.name)}: ${d.have.toLocaleString()} / ${d.need.toLocaleString()}`
    ).join('\n');
    const bld = ci.building ? ` <span class="sub">(${esc(ci.building)})</span>` : '';
    if (ci.status === 'yes')     return `<span class="craft-ok" data-tip="${tip}">✓${bld}</span>`;
    if (ci.status === 'partial') return `<span class="inv-part" data-tip="${tip}">~${bld}</span>`;
    return `<span class="craft-no" data-tip="${tip}">✗${bld}</span>`;
  }).join('<br>');

  const costStr    = task.cost   != null ? `${HEX} ${task.cost.toLocaleString()}`   : `<span class="dim">—</span>`;
  const profitStr  = task.profit != null ? `${HEX} ${task.profit.toLocaleString()}` : `<span class="dim">—</span>`;
  const profitCls  = task.profit == null ? '' : task.profit >= 0 ? ' profit-pos' : ' profit-neg';

  return `<tr class="task-row">
    <td class="c-traveler">${esc(task.traveler)}</td>
    <td class="c-items">${itemsHtml}</td>
    <td class="c-inv">${invHtml}</td>
    <td class="c-stalls">${stallHtml}</td>
    <td class="c-market">${marketHtml}</td>
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
      S.sortAsc = S.sortCol === col ? !S.sortAsc : false;
      S.sortCol = col;
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
  S.expiryTimer = null;
}

function startExpiryCountdown() {
  if (!S.expiry) return;
  const tick = () => {
    const ms = S.expiry * 1000 - Date.now();
    if (ms <= 0) {
      expiryCd.textContent = '⏰ Tasks expired';
      expiryCd.className   = 'cd-urgent';
      if (S.notifyArmed && Notification.permission === 'granted') {
        S.notifyArmed = false;   // fire once, then wait for next user refresh
        new Notification('BitCraft Tasks Reset', {
          body: `${S.player?.username ?? 'Your'} traveler tasks have reset — check back in!`,
          icon: '/favicon.ico',
        });
      }
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

// ── Data-tip hover ────────────────────────────────────────────────────────────
function bindTips() {
  tblBody.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', e => showTip(e, esc(el.dataset.tip).replace(/\n/g, '<br>')));
    el.addEventListener('mouseleave', hideTip);
  });
}

// ── CSV export ────────────────────────────────────────────────────────────────
function downloadCsv() {
  const q       = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const stallMap = buildStallMap();
  const rows    = [['Traveler','Item','Qty','Type','Inv Have','Nearby Stall','Stall Price','Stall Dist','Market Price','Craftable','Reward','Cost','Profit'].join(',')];
  for (const task of S.tasks) {
    const dt = decorateTask(task, stallMap);
    for (const item of dt.items) {
      const best = item.stall_matches?.[0];
      const bestPrice = best ? (hexPrice(best.price_parts) ?? (best.price_parts||[]).map(p=>`${p.qty} ${p.name}`).join('+')) : '';
      rows.push([
        q(task.traveler), q(item.name), item.qty, item.type, item.inv_have,
        q(best?.owner || ''), q(bestPrice), best?.distance ?? '',
        item.market_price ?? '',
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
