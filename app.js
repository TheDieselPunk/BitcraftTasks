'use strict';

const APP_VERSION = '1.14.0';
const HEX = '⬡';
// Trader Stands can be moved or packed away, and BitJita only gives the claim they're listed under
const STAND_NOTE = 'may not be there';
const STAND_MARK = ' <span class="stand-mark">?</span>';

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
  credits:       [],
  rerollCost:    null,
  creditsReset:  null,
  quests:        [],
  questPrices:   null,   // {item_id: {buy, cost, short, picks, craft?}}, or 'loading'
  questRegion:   '',
  questOffers:   null,   // {item_id: [offer]} from any region near the player, for the shopping route
  recommend:     null,   // {claims, pool, ready, total, range} from /api/recommend, or {loading: true}
  tasksLoaded:   false,
  stallsLoaded:  false,
  resetTimer:    null,
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
const resetCd       = $('reset-cd');
const creditsSection = $('credits-section');
const questsSection = $('quests-section');
const recSection    = $('recommend-section');
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
const apiWarnings   = $('api-warnings');
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
  _rangeDebounce = setTimeout(() => { if (S.player) { loadTasks(); loadRecommend(); } }, 600);
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
  S.questPrices    = null;
  S.questOffers    = null;
  clearTimers();
  clearWarnings();
  setStatus('Loading…');
  emptyMsg.textContent = '';
  mainTbl.style.display = 'none';

  loadRecommend();   // slower than the rest and not needed for the table, so it fills in when it's ready
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
    let url = `/api/tasks?player_id=${encodeURIComponent(S.player.id)}&username=${encodeURIComponent(S.player.username)}`;
    if (S.player.regionId) url += `&region_id=${S.player.regionId}`;
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
    S.tasks        = data.tasks || [];
    S.credits      = data.credits || [];
    S.rerollCost   = data.reroll_cost ?? null;
    const resets   = S.credits.map(c => c.next_reset).filter(Boolean);
    S.creditsReset = resets.length ? Math.min(...resets) : null;
    S.quests       = data.quests || [];
    S.tasksLoaded  = true;
    showWarnings(data.warnings);
    renderCredits();
    renderQuests();
    loadQuestPrices();
    startResetCountdown();
    if (!S.tasks.length) emptyMsg.textContent = 'No incomplete tasks found.';
    render();
  } catch (err) {
    setStatus(`⚠ Tasks: ${err.message}`);
    S.tasksLoaded = true;
    render();
  }
}

// Cheapest way to buy the quest items the player is missing, from markets and stalls in their region
async function loadQuestPrices() {
  const quests = S.quests;
  const need   = {};
  for (const q of quests) for (const n of q.needs) {
    const key = `${n.id}:${n.type}`;
    if (n.qty > n.have) need[key] = Math.max(need[key] || 0, n.qty - n.have);
  }
  if (!Object.keys(need).length) return;
  S.questPrices = 'loading';
  renderQuests();
  const p      = S.player;
  const params = [`items=${encodeURIComponent(Object.entries(need).map(([k, n]) => `${k}:${n}`).join(','))}`,
                  `username=${encodeURIComponent(p.username)}`, `player_id=${encodeURIComponent(p.id)}`];
  if (p.regionId)          params.push(`regionId=${p.regionId}`);
  if (p.locationX != null) params.push(`x=${p.locationX}`, `z=${p.locationZ}`);
  try {
    const data = await apiFetch(`/api/quest_prices?${params.join('&')}`);
    if (S.quests !== quests) return;   // a newer load replaced these quests
    S.questPrices = data.items || {};
    S.questRegion = data.region || '';
    S.questOffers = data.offers || null;
    showWarnings(data.warnings);
  } catch (err) {
    if (S.quests !== quests) return;
    S.questPrices = null;
    showWarnings([`Quest prices: ${err.message}`]);
  }
  renderQuests();
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
    showWarnings(data.warnings);

    // Populate autocomplete datalist with region stall owners
    if (data.ownerNames?.length) {
      ownersList.innerHTML = data.ownerNames.map(n => `<option value="${esc(n)}">`).join('');
    }


    render();
  } catch (err) {
    S.stallsLoaded = true;
    showWarnings([`Stalls: ${err.message}`]);
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
        stand:       stall.stand || false,
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

// ── Task credits ──────────────────────────────────────────────────────────────
function renderCredits() {
  if (!S.credits.length) { creditsSection.innerHTML = ''; return; }
  creditsSection.innerHTML =
    `<span class="exp-label">Task credits:</span>` +
    S.credits.map(c => {
      const low = S.rerollCost != null && c.credits < S.rerollCost;
      const max = c.weekly != null ? `<span class="credit-max">/${c.weekly}</span>` : '';
      return `<span class="exp-chip"><span class="exp-skill">${esc(c.traveler)}</span><span class="${low ? 'credit-low' : 'exp-amt'}">${c.credits}${max}</span></span>`;
    }).join('') +
    (S.rerollCost != null ? `<span class="sub">Reroll costs ${S.rerollCost}</span>` : '');
}

// ── Claim recommendation ──────────────────────────────────────────────────────
// The claims, anywhere in the world, whose markets cover the most of the tasks the player can be given:
// every task in the tiers they've unlocked, since rerolls and new tasks draw from that pool
async function loadRecommend() {
  const p = S.player;
  const params = [`player_id=${encodeURIComponent(p.id)}`, `username=${encodeURIComponent(p.username)}`, `range=${S.marketRangeH}`];
  if (p.regionId)          params.push(`regionId=${p.regionId}`);
  if (p.locationX != null) params.push(`x=${p.locationX}`, `z=${p.locationZ}`);
  const mine = S.recommend = { loading: true };
  renderRecommend();
  try {
    const data = await apiFetch(`/api/recommend?${params.join('&')}`);
    if (S.recommend !== mine) return;   // a newer load replaced this one
    S.recommend = data;
    showWarnings(data.warnings);
  } catch (err) {
    if (S.recommend !== mine) return;
    S.recommend = null;
    showWarnings([`Claim recommendation: ${err.message}`]);
  }
  renderRecommend();
}

// How much of each traveler's task pool a claim covers
function coverTip(c) {
  return c.travelers.map(t => `${t.traveler}: ${t.covered} of ${t.total}`)
    .concat(`Combined profit if you did each once: ${HEX}${c.pool_profit.toLocaleString()}`).join('\n');
}

// What to buy at a recommended claim for the tasks held now, task by task, then the ones it can't help with
function recommendTip(c) {
  const lines = !c.tasks.length ? ['Nothing here for the tasks you hold now.'] : c.tasks.map(t =>
    `${t.traveler}: +${HEX}${t.profit.toLocaleString()} (pays ${HEX}${t.reward.toLocaleString()}, costs ${HEX}${t.spend.toLocaleString()})\n` +
    t.items.map(i => {
      const own  = i.own ? `${i.own.toLocaleString()} yours` : '';
      const from = i.from.map(f => `${f.units.toLocaleString()} for ${HEX}${f.cost.toLocaleString()}${f.claim !== c.name ? ` in ${f.claim}` : ''}` +
        `${f.stall ? ` from ${f.stall}${f.stand ? ` (${STAND_NOTE})` : ''}` : ''}`);
      return `    ${i.qty.toLocaleString()}× ${i.name} — ${[own, ...from].filter(Boolean).join(', ')}`;
    }).join('\n'));
  const more = list => list.slice(0, 6).map(n => `    ${n}`).concat(list.length > 6 ? [`    … and ${list.length - 6} more`] : []);
  if (c.costly.length)      lines.push('Costs more than it pays here:', ...more(c.costly));
  if (c.unavailable.length) lines.push('Not for sale here:', ...more(c.unavailable));
  return lines.join('\n');
}

function useClaim(id) {
  const c = S.allClaims.find(c => c.id === id);
  if (!c) return;
  const label = `${c.name} (${c.dist}h)`;
  S.selectedClaimId = id;
  claimInput.value  = label;
  localStorage.setItem('bcTasks_selectedClaim', id);
  localStorage.setItem('bcTasks_selectedClaimName', label);
  load();
}

function renderRecommend() {
  const r = S.recommend;
  if (!r) { recSection.innerHTML = ''; return; }
  const head = `<div class="exp-label">Best claim to do your tasks at:</div>`;
  if (r.loading) { recSection.innerHTML = head + `<span class="dim">checking markets in every region…</span>`; return; }
  const where = r.range ? `markets and stalls within ${r.range}h of it` : 'its market and stalls';
  const pool  = r.pool?.total ?? 0;
  const help  = `Claims in any region, ranked by how many of the tasks you can be given are covered by ${where}.\n` +
                `That's every task in the tiers you've unlocked (${pool + (r.pool?.own ?? 0)}), not just the ${r.total} you hold now,\n` +
                `so the claim stays a good place to be after rerolls and new tasks. ${r.pool?.own ?? 0} of them your own items already cover.\n` +
                'A task is covered where every item you lack is for sale and costs less than the task pays.\n' +
                'Your own items are used first and not counted as a cost.\n' +
                'Counts market orders and stalls that sell for Hex Coin; stall stock is checked for the claims shown.\n' +
                'Raise Market range to include neighbouring markets. Hover the numbers for details.';
  const ready = r.ready?.count
    ? `<div class="rec-row"><span class="rec-label">No shopping</span><span class="inv-ok">` +
      `${r.ready.count} task${r.ready.count === 1 ? '' : 's'} you can hand in with what you have, for ${HEX}${r.ready.reward.toLocaleString()}</span></div>`
    : '';
  if (!r.claims.length) {
    recSection.innerHTML = head + ready + `<div class="rec-row"><span class="quest-short">No market sells what your tasks need for less than they pay.</span></div>`;
    return;
  }
  const myRegion = String(S.player?.regionId ?? '');
  const top      = r.claims[0].covered;
  recSection.innerHTML =
    `<div class="exp-label"><span data-tip="${esc(help)}" style="cursor:default;border-bottom:1px dotted #444466">Best claim to do your tasks at</span> <span class="sub">(${pool} possible tasks that need shopping, buying at ${where})</span>:</div>` +
    ready +
    r.claims.map((c, i) => {
      const local  = String(c.regionId) === myRegion;
      const label  = i === 0 ? 'Most tasks' : c.covered === top ? 'As many'
                   : local && !r.claims.slice(0, i).some(o => String(o.regionId) === myRegion) ? 'Best in region' : `#${i + 1}`;
      const others = c.markets.filter(m => m !== c.name);
      const near   = others.length ? `<span class="sub">+ ${esc(others.join(', '))}</span>` : '';
      const use    = S.allClaims.some(a => a.id === c.claimId) && c.claimId !== S.selectedClaimId
        ? `<button class="rec-use" onclick='useClaim(${JSON.stringify(c.claimId)})' title="Show this claim's prices in the table">Use as market</button>` : '';
      return `<div class="rec-row${i === 0 ? ' rec-best' : ''}">` +
        `<span class="rec-label">${label}</span>` +
        `<span class="rec-claim">${esc(c.name)}</span>${near}` +
        `<span class="sub">${esc(c.region)}${local ? ' (your region)' : ''}${c.dist != null ? ` · ${c.dist.toLocaleString()}h away` : ''}</span>` +
        `<span class="rec-cover" data-tip="${esc(coverTip(c))}">${c.covered} of ${pool} possible tasks</span>` +
        `<span class="quest-have" data-tip="${esc(recommendTip(c))}">now: ${c.tasks.length} of your ${r.total - (r.ready?.count ?? 0)}` +
        `${c.tasks.length ? ` for <span class="profit-pos">+${HEX}${c.profit.toLocaleString()}</span>` : ''}</span>` +
        use +
      `</div>`;
    }).join('');
  bindTips(recSection);
}

// ── Unlock quests ─────────────────────────────────────────────────────────────
const QUEST_STATUS = { in_progress: 'Started', ready: 'Ready to start', next: 'Next', locked: 'Locked' };

// Cost of buying what's missing of one quest item, taken from the cheapest offers found for it
// (several quests can need the same item, so the lookup covers the largest shortfall)
function questItemPrice(n) {
  const buy = n.qty - n.have;
  const p   = S.questPrices?.[n.id];
  if (buy <= 0 || !p || p === 'loading') return null;
  if (p.buy === buy) return p;
  let left = buy, cost = 0;
  const picks = [];
  for (const pk of p.picks) {
    if (left <= 0) break;
    const units = Math.min(pk.units, left);
    picks.push({ ...pk, units, cost: units * pk.unit });
    cost += units * pk.unit;
    left -= units;
  }
  return { buy, cost, short: left, picks };
}

// "stall: sfmason's Sturdy Barter Stall (Rumbagh T1 5)"
function sellerLine(s) {
  return `${s.source}: ${s.seller}${s.stand ? ` — ${STAND_NOTE}` : ''}`;
}

// "30× for ⬡5,100 — Solvenar (522h), stall: sfmason's Sturdy Barter Stall (Rumbagh T1 5)"
function pickLine(pk) {
  return `${pk.units.toLocaleString()}× for ${HEX}${pk.cost.toLocaleString()} — ${pk.claim}` +
    `${pk.dist != null ? ` (${pk.dist.toLocaleString()}h)` : ''}, ${sellerLine(pk)}`;
}

// Where the price lookup bought from: "⬡5,100 Solvenar" or "⬡1,475 3 claims", then what's left unsold
function boughtHtml(p, tip) {
  const claims = [...new Set(p.picks.map(pk => pk.claim))];
  let html = p.picks.length ? ` <span class="quest-price" data-tip="${esc(tip)}">${HEX}${p.cost.toLocaleString()}` +
    ` <span class="sub">${esc(claims.length === 1 ? claims[0] : `${claims.length} claims`)}</span>` +
    `${p.picks.some(pk => pk.stand) ? STAND_MARK : ''}</span>` : '';
  if (p.short) html += ` <span class="quest-short" data-tip="${esc(tip)}">` +
    `${p.short === p.buy ? 'not for sale' : `${p.short.toLocaleString()} not for sale`}</span>`;
  return html;
}

// Crafting covers what can't be bought when the player has the levels and every ingredient can be had
function craftable(pr) {
  const c = pr.craft;
  return !!c && c.levels.every(l => l.have >= l.level) && c.ingredients.every(i => !i.short);
}

function craftHtml(n, c, region) {
  const levels = c.levels.map(l => l.have >= l.level
    ? `<span class="sub">${esc(l.skill)} ${l.level} ✓</span>`
    : `<span class="quest-req">needs ${esc(l.skill)} ${l.level} (you have ${l.have})</span>`).join(' ');
  const ingredients = c.ingredients.map(i => {
    const tip = [`${i.qty.toLocaleString()} needed${i.have ? `, you have ${i.have.toLocaleString()}` : ''}`]
      .concat(i.picks.map(pickLine), i.short ? [`${i.short.toLocaleString()} not for sale in ${region}`] : []).join('\n');
    const status = i.buy ? boughtHtml(i, tip) : ` <span class="inv-ok">have</span>`;
    return `<span class="quest-have" data-tip="${esc(tip)}">${i.qty.toLocaleString()}× ${esc(i.name)}</span>${status}`;
  }).join(', ');
  return `<div class="quest-craft">↳ Craft ${c.makes.toLocaleString()} ${esc(n.name)} ` +
    `<span class="sub">(${c.crafts.toLocaleString()}× ${esc(c.recipe)} at ${esc(c.building)})</span> ${levels}: ${ingredients}</div>`;
}

function renderQuests() {
  if (!S.quests.length) { questsSection.innerHTML = ''; return; }
  const loading = S.questPrices === 'loading';
  const region  = S.questRegion || 'your region';
  questsSection.innerHTML =
    `<div class="exp-label">Quests that unlock more tasks:</div>` +
    (loading ? '' : routeHtml()) +
    pickupHtml() +
    S.quests.map(q => {
      const prices = [];
      const crafts = [];
      const needs = q.needs.map(n => {
        const cls  = n.have >= n.qty ? 'inv-ok' : n.have ? 'inv-part' : '';
        const where = [...(n.where || [])].sort((a, b) => b.qty - a.qty)
          .map(l => `${l.qty.toLocaleString()} in ${l.label}`).join('\n');
        const have  = n.have ? ` <span class="sub quest-have" data-tip="${esc(where)}">(have ${n.have.toLocaleString()})</span>` : '';
        let price  = '';
        const pr   = questItemPrice(n);
        if (loading && n.qty > n.have) price = ` <span class="dim">pricing…</span>`;
        else if (pr) {
          prices.push(pr);
          const tip = pr.picks.map(pickLine)
            .concat(pr.short ? [`${pr.short.toLocaleString()} not for sale in ${region}${pr.craft ? ', craft them instead' : ''}`] : []).join('\n');
          price = boughtHtml(pr, tip);
          if (pr.short && pr.craft) crafts.push(craftHtml(n, pr.craft, region));
        }
        return `<span class="${cls}">${n.qty.toLocaleString()}× ${esc(n.name)}</span>${have}${price}`;
      }).join(', ');
      let cost = '';
      if (q.needs.length && q.needs.every(n => n.have >= n.qty)) cost = `<span class="inv-ok">have all items</span>`;
      else if (prices.length) {
        const crafting = prices.filter(p => p.short && craftable(p));
        const total = prices.reduce((sum, p) => sum + p.cost, 0) +
          crafting.reduce((sum, p) => sum + p.craft.ingredients.reduce((s, i) => s + i.cost, 0), 0);
        const short = prices.some(p => p.short && !craftable(p)) ? ' + items not for sale' : '';
        const how   = crafting.length ? ' with crafting' : '';
        cost = total || !short
          ? `<span class="quest-cost" data-tip="${esc(`Cheapest way to buy the missing items${how ? ' (or the ingredients to craft them)' : ''} from markets and stalls in ${region}`)}">` +
            `${HEX}${total.toLocaleString()} to finish${how}${short}</span>`
          : `<span class="quest-short">items not for sale in ${esc(region)}</span>`;
      }
      const req = q.requires.length ? `<span class="quest-req">needs ${esc(q.requires.join(', '))}</span>` :
                  q.after?.length  ? `<span class="quest-after">after ${esc(q.after.join(', '))}</span>` : '';
      return `<div class="quest-row quest-${q.status}">` +
        `<span class="quest-status">${QUEST_STATUS[q.status] || q.status}</span>` +
        `<span class="quest-trav">${esc(q.traveler)}</span>` +
        `<span class="quest-unlock">${esc(q.unlocks)}</span>` +
        `<span class="sub">${esc(q.name)}</span>` +
        req + cost +
        (needs ? `<span class="quest-needs">${needs}</span>` : '') +
        crafts.join('') +
      `</div>`;
    }).join('');
  bindTips(questsSection);
}

// ── Pick-up list ──────────────────────────────────────────────────────────────
// What the player already owns toward the quests they can do now or next, plus ingredients for items
// they'll craft, grouped by where it's stored. Takes from storage in their own region first, then from
// places holding more of the items, then from bigger stacks.
function pickupHtml() {
  const wanted = [];   // [{id, name, qty, where}]
  for (const q of S.quests.filter(q => q.status !== 'locked')) {
    for (const n of q.needs) {
      if (n.have) wanted.push({ id: n.id, name: n.name, qty: n.qty, where: n.where || [] });
      const pr = questItemPrice(n);
      if (pr?.short && craftable(pr)) {
        for (const i of pr.craft.ingredients) if (i.have) wanted.push({ id: i.id, name: i.name, qty: i.qty, where: i.where || [] });
      }
    }
  }
  if (!wanted.length) return '';

  const placeOf = w => w.place || w.container;
  const score   = {};   // place -> how many wanted items are stored there
  for (const w of wanted) for (const p of new Set(w.where.map(placeOf))) score[p] = (score[p] || 0) + 1;
  const stock = {};     // item id -> containers with what's left in them
  const picks = new Map();   // place -> container -> item name -> qty
  for (const w of wanted) {
    stock[w.id] ||= w.where.map(s => ({ ...s }))
      .sort((a, b) => (a.elsewhere - b.elsewhere) || (score[placeOf(b)] - score[placeOf(a)]) || (b.qty - a.qty));
    let left = w.qty;
    for (const s of stock[w.id]) {
      const n = Math.min(left, s.qty);
      if (n <= 0) continue;
      s.qty -= n;
      left  -= n;
      const place = placeOf(s), container = s.place ? s.container : '';
      if (!picks.has(place)) picks.set(place, new Map());
      if (!picks.get(place).has(container)) picks.get(place).set(container, new Map());
      const items = picks.get(place).get(container);
      items.set(w.name, (items.get(w.name) || 0) + n);
    }
  }

  const help = 'Items you own that count toward the quests you can do now or next, plus ingredients for anything ' +
               "you'll craft. Uses storage in your own region first, then places that hold more of the items.";
  return `<div class="quest-route"><span class="route-head" data-tip="${esc(help)}">Pick up what you already have:</span>` +
    [...picks].map(([place, containers]) =>
      `<div class="route-row"><span class="pickup-place">${esc(place)}</span>` +
      [...containers].map(([container, items]) =>
        `<span>${container ? `<span class="sub">${esc(container)}:</span> ` : ''}` +
        [...items].map(([name, qty]) => `${qty.toLocaleString()}× ${esc(name)}`).join(', ') + `</span>`
      ).join('<span class="sub">·</span>') +
      `</div>`
    ).join('') +
  `</div>`;
}

// ── Shopping route ────────────────────────────────────────────────────────────
// Up to 3 claims to visit, in any region near the player, that sell everything for the most quests the
// player can do now or next (any quest that isn't locked). Each item is bought at the stop that sells it cheapest.
// Returns {covered, total, missing, routes: [{label, cost, trip, stops: [{claim, region, leg, buys}]}]} or null.
const ROUTE_RADIUS_H = 3000;   // matches ROUTE_RADIUS in api/quest_prices.py

function planQuestRoute() {
  const p = S.player;
  if (!S.questOffers || p?.locationX == null) return null;
  const quests = S.quests.filter(q => q.status !== 'locked' && q.needs.some(n => n.qty > n.have));
  const wants  = quests.flatMap((q, qi) => q.needs.filter(n => n.qty > n.have)
    .map(n => ({ qi, quest: q.name, name: n.name, id: n.id, buy: n.qty - n.have })));
  if (!wants.length) return null;

  // Cost of each wanted item at each claim that has enough of it, cheapest sellers first
  const claims = new Map();
  wants.forEach((w, wi) => {
    const byClaim = new Map();
    for (const o of S.questOffers[w.id] || []) {
      const key = `${o.region}|${o.claim}`;
      if (!byClaim.has(key)) byClaim.set(key, []);
      byClaim.get(key).push(o);
    }
    for (const [key, list] of byClaim) {
      let left = w.buy, cost = 0;
      const from = [];
      for (const o of list.sort((a, b) => a.price / a.bundle - b.price / b.bundle)) {
        if (left <= 0) break;
        const trades = Math.min(Math.ceil(left / o.bundle), Math.floor(o.units / o.bundle));
        if (trades > 0) from.push(o);
        cost += trades * o.price;
        left -= trades * o.bundle;
      }
      if (left > 0) continue;
      if (!claims.has(key)) claims.set(key, { claim: list[0].claim, region: list[0].region, x: list[0].x, z: list[0].z, cost: [], from: [] });
      claims.get(key).cost[wi] = cost;
      claims.get(key).from[wi] = from;
    }
  });

  const home = { x: p.locationX, z: p.locationZ };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) / 3;
  let best = null;   // {covered, routes} — the routes covering the most quests
  const consider = stops => {
    const at = wants.map((w, wi) => stops.reduce((s, c) => c.cost[wi] != null && (!s || c.cost[wi] < s.cost[wi]) ? c : s, null));
    const done = quests.map((q, qi) => wants.every((w, wi) => w.qi !== qi || at[wi]));
    const covered = done.filter(Boolean).length;
    if (!covered || (best && covered < best.covered)) return;
    const used = new Set(wants.map((w, wi) => done[w.qi] ? at[wi] : null));
    if (stops.some(c => !used.has(c))) return;   // every stop must be needed
    const cost = wants.reduce((sum, w, wi) => sum + (done[w.qi] ? at[wi].cost[wi] : 0), 0);
    let trip = Infinity, order = null;
    for (const perm of permutations(stops)) {
      let d = 0, pos = home;
      for (const c of perm) { d += dist(pos, c); pos = c; }
      if (d < trip) { trip = d; order = perm; }
    }
    const route = { cost, trip, order, at, done };
    if (!best || covered > best.covered) best = { covered, routes: [route] };
    else best.routes.push(route);
  };
  const cands = [...claims.values()];
  for (let i = 0; i < cands.length; i++) {
    consider([cands[i]]);
    for (let j = i + 1; j < cands.length; j++) {
      consider([cands[i], cands[j]]);
      for (let k = j + 1; k < cands.length; k++) consider([cands[i], cands[j], cands[k]]);
    }
  }
  if (!best) return { covered: 0, total: quests.length, missing: quests.map(q => q.name), routes: [] };

  const describe = (label, r) => {
    let pos = home;
    return { label, cost: r.cost, trip: Math.round(r.trip), stops: r.order.map(c => {
      const leg = Math.round(dist(pos, c));
      pos = c;
      const buys = wants.map((w, wi) => ({ ...w, cost: c.cost[wi], from: c.from[wi] })).filter((w, wi) => r.done[w.qi] && r.at[wi] === c);
      return { claim: c.claim, region: c.region, leg, buys };
    }) };
  };
  // Best balance: the smallest sum of trip and cost, each relative to the best possible
  const pick     = score => best.routes.reduce((a, r) => score(r) < score(a) ? r : a);
  const shortest = pick(r => r.trip + r.cost * 1e-9);
  const cheapest = pick(r => r.cost + r.trip * 1e-9);
  const balanced = pick(r => r.trip / Math.max(shortest.trip, 1) + r.cost / Math.max(cheapest.cost, 1));
  const routes   = [['Best balance', balanced], ['Shortest trip', shortest], ['Cheapest', cheapest]]
    .filter(([, r], i, all) => all.findIndex(([, x]) => x === r) === i)
    .map(([label, r]) => describe(label, r));
  return { covered: best.covered, total: quests.length, missing: quests.filter((q, qi) => !balanced.done[qi]).map(q => q.name), routes };
}

function permutations(list) {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [x, ...rest]));
}

function routeHtml() {
  const plan = planQuestRoute();
  if (!plan) return '';
  const missing = plan.missing.length ? ` <span class="quest-short">not enough for sale nearby for: ${esc(plan.missing.join(', '))}</span>` : '';
  if (!plan.routes.length) return `<div class="quest-route"><span class="route-head">Shopping route:</span>${missing}</div>`;
  const which = plan.covered === plan.total ? `all ${plan.total}` : `${plan.covered} of ${plan.total}`;
  const help  = `Up to 3 stops, in any region within ${ROUTE_RADIUS_H.toLocaleString()}h. ` +
                'Each item is bought at the stop that sells it cheapest. Best balance weighs travel against cost. ' +
                `Hover a stop to see what to buy there. ? means a Trader Stand, which can be moved, so it ${STAND_NOTE}.`;
  const when  = S.quests.some(q => q.status === 'next') ? 'now or next' : 'now';
  return `<div class="quest-route"><span class="route-head" data-tip="${esc(help)}">Shopping route for ${which} quests you can do ${when}:</span>${missing}` +
    plan.routes.map(r =>
      `<div class="route-row"><span class="route-label">${r.label}</span>` +
      `<span class="quest-cost">${HEX}${r.cost.toLocaleString()}</span><span class="sub">${r.trip.toLocaleString()}h trip</span>` +
      r.stops.map((s, i) => {
        const subtotal = s.buys.reduce((sum, b) => sum + b.cost, 0);
        const tip = s.buys.map(b => `${b.buy.toLocaleString()}× ${b.name} — ${HEX}${b.cost.toLocaleString()} (${b.quest})\n` +
                                    `    ${[...new Set(b.from.map(sellerLine))].join(', ')}`)
          .concat(`Spend here: ${HEX}${subtotal.toLocaleString()}`).join('\n');
        const region = s.region && s.region !== S.questRegion ? `, ${s.region}` : '';
        const unsure = s.buys.some(b => b.from.some(o => o.stand)) ? STAND_MARK : '';
        return `${i ? '<span class="sub">→</span>' : ''}<span class="route-stop" data-tip="${esc(tip)}">${i + 1}. ${esc(s.claim)}${unsure}` +
          `<span class="sub">${esc(region)} ${i ? '+' : ''}${s.leg.toLocaleString()}h</span></span>`;
      }).join('') +
      `</div>`
    ).join('') +
  `</div>`;
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

  // Cost: every item at its cheapest coin price (barter sources have no coin cost — excluded).
  // Items you already own count at that price too: handing them in means not selling them.
  let buyCost = 0, ownedValue = 0, costKnown = true;
  const unpriced = [];
  for (const item of items) {
    const candidates = [];
    if (item.market_price != null) candidates.push(item.market_price);
    for (const m of (item.stall_matches || [])) {
      if (m.isBarter) continue;
      const sp = hexPrice(m.price_parts);
      if (sp != null) candidates.push(sp);
    }
    const ownQty = Math.min(item.qty, item.inv_have || 0);
    const buyQty = item.qty - ownQty;
    item.unit_price = candidates.length ? Math.min(...candidates) : null;
    if (item.unit_price != null) {
      buyCost    += item.unit_price * buyQty;
      ownedValue += item.unit_price * ownQty;
    } else if (buyQty > 0) costKnown = false;
    else unpriced.push(item.name);
  }
  const hasSource = items.some(i => i.stall_matches.length > 0 || i.market_price != null);
  const known  = costKnown && hasSource;
  const cost   = known ? buyCost + ownedValue : null;
  const profit = cost != null ? task.reward - cost : null;

  return { ...task, items, cost, profit, buyCost: known ? buyCost : null, ownedValue: known ? ownedValue : null, unpriced };
}

// The Cost cell: the total, plus how much of it is your own items, which you'd otherwise sell
function costHtml(task) {
  if (task.cost == null) return `<span class="dim">—</span>`;
  const total = `${HEX} ${task.cost.toLocaleString()}`;
  if (!task.ownedValue && !task.unpriced.length) return total;
  const tip = [
    task.buyCost    ? `${HEX}${task.buyCost.toLocaleString()} to buy` : '',
    task.ownedValue ? `${HEX}${task.ownedValue.toLocaleString()} worth of your own items, at the cheapest price nearby` : '',
    ...task.unpriced.map(n => `${n}: yours, but no price found, so counted as free`),
  ].filter(Boolean).join('\n');
  const yours = task.ownedValue ? `${HEX}${task.ownedValue.toLocaleString()} yours` : 'yours, no price';
  return `<span data-tip="${esc(tip)}">${total}<div class="sub">${yours}</div></span>`;
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
      // Buy the rest here; what you own still counts at its cheapest price, since you could sell it
      const ownQty    = Math.min(item.qty, item.inv_have || 0);
      const profit    = coinPrice != null
        ? task.reward - coinPrice * (item.qty - ownQty) - (item.unit_price ?? coinPrice) * ownQty
        : null;
      const profitStr = profit != null
        ? ` <span class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}">(${HEX}${profit.toLocaleString()})</span>`
        : '';
      const watchedMark = m.watched ? `<span style="color:#f0a500" title="Watched">★ </span>` : '';
      const displayName = m.name !== m.owner && m.name ? m.name : m.owner;
      const standMark = m.stand ? `<span data-tip="Trader Stands can be moved, so this one ${STAND_NOTE}">${STAND_MARK}</span>` : '';
      return `${watchedMark}<span class="stall-name">${esc(displayName)}</span>${standMark}${ph ? ' · ' + ph : ''}${profitStr} ${distStr}`;
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

  const costStr    = costHtml(task);
  const profitStr  = task.profit != null ? `${HEX} ${task.profit.toLocaleString()}` : `<span class="dim">—</span>`;
  const profitCls  = task.profit == null ? '' : task.profit >= 0 ? ' profit-pos' : ' profit-neg';

  const lvlStr = task.min_level > 1 ? ` Lv ${task.min_level}+` : '';
  const expStr = task.exp_qty ? ` · ${task.exp_qty.toLocaleString()} xp` : '';

  return `<tr class="task-row">
    <td class="c-traveler">${esc(task.traveler)}<div class="traveler-sub">${esc(task.skill_name)}${lvlStr}${expStr}</div></td>
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
  clearInterval(S.resetTimer);
  S.resetTimer = null;
}

// Counts down to the weekly task-credit refill (estimated as 7 days after the last reset)
function startResetCountdown() {
  clearInterval(S.resetTimer);
  if (!S.creditsReset) { resetCd.textContent = ''; return; }
  const tick = () => {
    const ms = S.creditsReset * 1000 - Date.now();
    if (ms <= 0) {
      resetCd.textContent = '⟳ Task credits have reset';
      if (S.notifyArmed && Notification.permission === 'granted') {
        S.notifyArmed = false;   // fire once, then wait for next user refresh
        new Notification('BitCraft Task Credits Reset', {
          body: `${S.player?.username ?? 'Your'} traveler task credits have reset — check back in!`,
          icon: '/favicon.ico',
        });
      }
      clearInterval(S.resetTimer);
      return;
    }
    const d  = Math.floor(ms / 86400000);
    const h  = Math.floor((ms % 86400000) / 3600000);
    const m  = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s  = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    resetCd.textContent = `⏱ Credits reset in ${d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`}`;
  };
  tick();
  S.resetTimer = setInterval(tick, 1000);
}

// ── Data-tip hover ────────────────────────────────────────────────────────────
function bindTips(root = tblBody) {
  root.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('mouseenter', e => showTip(e, esc(el.dataset.tip).replace(/\n/g, '<br>')));
    el.addEventListener('mouseleave', hideTip);
  });
}

// ── CSV export ────────────────────────────────────────────────────────────────
function downloadCsv() {
  const q       = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const stallMap = buildStallMap();
  const rows    = [['Traveler','Min Level','Item','Qty','Type','Inv Have','Nearby Stall','Stall Price','Stall Dist','Market Price','Craftable','Reward','Cost','Profit'].join(',')];
  for (const task of S.tasks) {
    const dt = decorateTask(task, stallMap);
    for (const item of dt.items) {
      const best = item.stall_matches?.[0];
      const bestPrice = best ? (hexPrice(best.price_parts) ?? (best.price_parts||[]).map(p=>`${p.qty} ${p.name}`).join('+')) : '';
      rows.push([
        q(task.traveler), task.min_level ?? '', q(item.name), item.qty, item.type, item.inv_have,
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
function showWarnings(list) {
  if (!list?.length) return;
  apiWarnings.innerHTML += list.map(w => `<div class="warn-item">${esc(w)}</div>`).join('');
  apiWarnings.style.display = '';
}
function clearWarnings() {
  apiWarnings.innerHTML = '';
  apiWarnings.style.display = 'none';
}
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
