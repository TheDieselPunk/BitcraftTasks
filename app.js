'use strict';

const APP_VERSION = '1.23.0';
const HEX = '⬡';
// Trader Stands can be moved or packed away, and BitJita only gives the claim they're listed under
const STAND_NOTE = 'may not be there';
const STAND_MARK = ' <span class="stand-mark">?</span>';

const COLS = [
  { label: 'Traveler',         sort: 'traveler' },
  { label: 'Item',             sort: null        },
  { label: 'Have',             sort: null        },
  { label: 'Where to get it',  sort: null        },
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
  travelerFilter: null,  // traveler name picked in Task credits: show only their tasks
  credits:       [],
  rerollCost:    null,
  creditsReset:  null,
  quests:        [],
  activeQuests:  [],     // every quest the player has started: [{id, name, stage, needs, other, rewards, ...}]
  aqFilter:      'all',  // Quests tab filter: all | done | short | game
  tab:           localStorage.getItem('bcTasks_tab') === 'quests' ? 'quests' : 'tasks',
  questPrices:   null,   // {item_id: {buy, cost, short, picks, craft?}}, or 'loading'
  questRegion:   '',
  questOffers:   null,   // {item_id: [offer]} from any region near the player, for the shopping route
  pool:          {},     // {traveler: [{id, reward, items: [{id, type, name, qty, have}]}]}: tasks they can give
  invBags:       {},     // {container entity id: {item_id: qty}} as BitJita last saw it
  recommend:     null,   // {claims, pool, ready, total, range} from /api/recommend, or {loading: true}
  tasksLoaded:   false,
  stallsLoaded:  false,
  resetTimer:    null,
  notifyArmed:   false,
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
const aqSection     = $('active-quests-section');
const tabsBar       = $('tabs');
const recSection    = $('recommend-section');
const stockSection  = $('stock-section');
const expSection    = $('exp-section');
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
renderHousingChips();

localStorage.removeItem('bcTasks_watched');   // the old Watch Traders list

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
btnRefresh.addEventListener('click', () => { S.notifyArmed = true; load(true); });
btnFilter.addEventListener('click', () => {
  S.filterOn = !S.filterOn;
  btnFilter.classList.toggle('active', S.filterOn);
  render();
});
btnCsv.addEventListener('click', downloadCsv);

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(tab) {
  S.tab = tab;
  localStorage.setItem('bcTasks_tab', tab);
  tabsBar.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('tab-tasks').hidden  = tab !== 'tasks';
  $('tab-quests').hidden = tab !== 'quests';
  document.body.classList.toggle('tab-quests', tab === 'quests');
  hideTip();
}
tabsBar.addEventListener('click', e => {
  const b = e.target.closest('.tab-btn');
  if (b) showTab(b.dataset.tab);
});
showTab(S.tab);

function renderTabCounts() {
  $('tab-count-tasks').textContent = S.tasksLoaded ? S.tasks.length : '';
  const ready = S.activeQuests.filter(q => AQ_DONE.has(q._verdict)).length;
  $('tab-count-quests').textContent = S.tasksLoaded ? (ready ? `${S.activeQuests.length} · ${ready} ready` : S.activeQuests.length) : '';
}

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
  _rangeDebounce = setTimeout(() => { if (S.player) { render(); loadRecommend(); } }, 600);   // range picks Trader Stands; market prices are region-wide
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
    if (data.regionId)          parts.push(data.regionName || `Region ${data.regionId}`);
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
    housingRow.classList.add('visible');
    toolbar.classList.add('visible');
    tabsBar.classList.add('visible');
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
async function load(fresh = false) {   // fresh: skip the CDN cache (Refresh button)
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

  loadRecommend(fresh);   // slower than the rest and not needed for the table, so it fills in when it's ready
  await Promise.all([
    loadTasks(fresh),
    S.player.locationX != null ? loadStalls(fresh) : Promise.resolve(),
  ]);

  setStatus('');
}

// A Trader Stand counts when it's within the market range of the selected claim (or of the player, with
// no claim picked). At 0h that's the claim itself. Its live position is used when the relay has one.
const STAND_CLAIM_RADIUS_H = 10;
function standInRange(stall) {
  const x = stall.live ? stall.live_x : stall.x, z = stall.live ? stall.live_z : stall.z;
  if (x == null || z == null) return false;
  const sel = S.allClaims.find(c => c.id === S.selectedClaimId);
  const cx  = sel?.x ?? S.player?.locationX, cz = sel?.z ?? S.player?.locationZ;
  if (cx == null || cz == null) return true;
  return Math.hypot(x - cx, z - cz) / 3 <= Math.max(S.marketRangeH, STAND_CLAIM_RADIUS_H);
}

async function loadTasks(fresh = false) {
  try {
    let url = `/api/tasks?player_id=${encodeURIComponent(S.player.id)}&username=${encodeURIComponent(S.player.username)}`;
    // Every market in a region shares its listings, so prices come from the region's market nearest the player
    if (S.player.regionId)          url += `&region_id=${S.player.regionId}`;
    if (S.player.locationX != null) url += `&x=${S.player.locationX}&z=${S.player.locationZ}`;
    const data = await apiFetch(url, fresh);
    S.tasks        = data.tasks || [];
    S.credits      = data.credits || [];
    S.rerollCost   = data.reroll_cost ?? null;
    const resets   = S.credits.map(c => c.next_reset).filter(Boolean);
    S.creditsReset = resets.length ? Math.min(...resets) : null;
    S.quests       = data.quests || [];
    S.activeQuests = data.active_quests || [];
    S.pool         = data.pool || {};
    S.invBags      = data.inv_bags || {};
    S.tasksLoaded  = true;
    liveStart();          // keep tasks, credits and inventory in sync with the game from here on
    // BitJita can lag behind the game: drop tasks the relay says are done, use the relay's counts
    liveReconcile(false);
    liveApplyCredits();
    liveApplyInventory();
    liveApplyQuests(false);
    L.dirty = L.creditsDirty = false;   // everything below renders anyway
    showWarnings(data.warnings);
    renderCredits();
    renderStock();
    renderQuests();
    loadQuestPrices(fresh);
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
async function loadQuestPrices(fresh = false) {
  const quests = S.quests;
  const need   = {};
  for (const q of [...quests, ...S.activeQuests]) for (const n of q.needs) {
    const key = `${n.id}:${n.type}`;
    if (n.id !== HEX_COIN_ID && n.qty > n.have) need[key] = Math.max(need[key] || 0, n.qty - n.have);
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
    const data = await apiFetch(`/api/quest_prices?${params.join('&')}`, fresh);
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

async function loadStalls(fresh = false) {
  const { locationX: x, locationZ: z, regionId } = S.player;
  try {
    const params = [`x=${x}`, `z=${z}`];
    if (regionId) params.push(`regionId=${regionId}`);
    if (S.selectedClaimId) {
      params.push(`claimId=${S.selectedClaimId}`);
      const selClaim = (S.allClaims || []).find(c => c.id === S.selectedClaimId);
      if (selClaim) params.push(`claimName=${encodeURIComponent(selClaim.name)}`);
    }
    if (S.housedPlayers.length)  params.push(`housing=${encodeURIComponent(S.housedPlayers.join(','))}`);
    const data = await apiFetch(`/api/stalls?${params.join('&')}`, fresh);
    S.stalls         = data.stalls || [];
    S.barterSources  = data.barterSources || [];
    S.housingSources = data.housingSources || [];
    S.marketMap     = data.nearestMarket?.items  || {};
    S.marketClaim   = data.nearestMarket || null;
    S.stallsLoaded  = true;
    liveWatchStands();      // follow the region's Trader Stands live
    L.dirty = false;        // render() below covers it
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
    if (stall.live && !stall.deployed) continue;   // the relay says this stand is packed up
    if (!standInRange(stall)) continue;
    for (const it of stall.items) {
      // live: what the stand actually holds, capped by the trade's remaining stock
      const stock = stall.live ? (it.stock == null ? it.stock_live : Math.min(it.stock, it.stock_live)) : it.stock;
      if (stall.live && !stock) continue;
      if (!map[it.id]) map[it.id] = [];
      map[it.id].push({
        name:        stall.name,
        stand:       stall.stand || false,
        liveSpot:    stall.live ? { x: stall.live_x, z: stall.live_z, stock } : null,
        owner:       stall.owner,
        claimName:   stall.claimName,
        distance:    stall.distance,
        isBarter:    false,
        qty:         it.qty,
        stock,
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
        isBarter:    true,
        qty:         itemData.qty,
        stock:       itemData.qty,
        price_parts: itemData.price_parts || [],
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
      const on  = S.travelerFilter === c.traveler;
      return `<button type="button" class="exp-chip credit-chip${on ? ' active' : ''}" data-traveler="${esc(c.traveler)}" title="${on ? 'Show all travelers' : `Show only ${esc(c.traveler)}'s tasks`}"><span class="exp-skill">${esc(c.traveler)}</span><span class="${low ? 'credit-low' : 'exp-amt'}">${c.credits}${max}</span></button>`;
    }).join('') +
    (S.rerollCost != null ? `<span class="sub">Reroll costs ${S.rerollCost}</span>` : '');
}

creditsSection.addEventListener('click', e => {
  const chip = e.target.closest('.credit-chip');
  if (!chip) return;
  const name = chip.dataset.traveler;
  S.travelerFilter = S.travelerFilter === name ? null : name;
  renderCredits();
  render();
});

// ── Weekly task stock ─────────────────────────────────────────────────────────
// How much of each pool item the rest of the week's task credits will ask for, from the task rules:
// a traveler shows 4 tasks; a finished task is replaced by a random pool task that isn't the one just
// finished and shares no item with the other 3. Simulated many times from the tasks held now.
const TASK_SLOTS       = 4;
const CREDITS_PER_TASK = 1;     // credits a hand-in uses
const STOCK_RUNS       = 400;   // simulated weeks per traveler

// Small seeded RNG so the estimates don't jitter between renders
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pool tasks that can replace `done`, given the tasks left on the board. When every one of them shares an
// item with the board, the slot is assumed to still be filled, so the shared-item rule is dropped.
function replacements(pool, board, done) {
  const used = new Set(board.flatMap(t => t.items.map(i => i.id)));
  const free = pool.filter(t => t !== done && !board.includes(t));
  const best = free.filter(t => !t.items.some(i => used.has(i.id)));
  return best.length ? best : free;
}

// One simulated week. pick(board) = the index of the task to hand in, or -1 to stop.
// Returns {done: [task], choices: largest number of tasks a replacement was drawn from}
function simulateWeek(pool, start, handins, rand, pick) {
  const board = [...start];
  while (board.length < TASK_SLOTS) {
    const opts = replacements(pool, board, null);
    if (!opts.length) break;
    board.push(opts[Math.floor(rand() * opts.length)]);
  }
  const done = [];
  let choices = 0;
  for (let n = 0; n < handins && board.length; n++) {
    const k = pick(board);
    if (k < 0) break;
    const [task] = board.splice(k, 1);
    done.push(task);
    const opts = replacements(pool, board, task);
    choices = Math.max(choices, opts.length);
    if (opts.length) board.push(opts[Math.floor(rand() * opts.length)]);
  }
  return { done, choices };
}

// Per traveler: expected demand per item if tasks are handed in in any order, and how many hand-ins
// the player's own stock covers if they always hand in the task they hold the most of
function stockEstimate(traveler, pool) {
  const credit  = S.credits.find(c => c.traveler === traveler);
  const handins = Math.floor((credit?.credits ?? credit?.weekly ?? 0) / CREDITS_PER_TASK);
  const byId    = new Map(pool.map(t => [String(t.id), t]));
  const start   = S.tasks.filter(t => t.traveler === traveler && byId.has(String(t.id))).map(t => byId.get(String(t.id)));
  const items   = new Map();   // item id → {name, have, need, perTask: [qty]}
  for (const t of pool) for (const i of t.items) {
    const it = items.get(i.id) || { id: i.id, name: i.name, have: i.have, need: 0, tasks: 0 };
    it.tasks++;
    items.set(i.id, it);
  }

  const rand = rng(pool.length * 7919 + handins);
  let choices = 0;
  for (let r = 0; r < STOCK_RUNS; r++) {
    const w = simulateWeek(pool, start, handins, rand, board => Math.floor(rand() * board.length));
    choices = Math.max(choices, w.choices);
    for (const t of w.done) for (const i of t.items) items.get(i.id).need += i.qty;
  }
  for (const it of items.values()) it.need = Math.ceil(it.need / STOCK_RUNS);

  // Steering: hand in the held task the stock lasts longest for; stop when nothing held can be handed in
  let covered = 0;
  for (let r = 0; r < STOCK_RUNS; r++) {
    const left = new Map([...items.values()].map(it => [it.id, it.have]));
    const lasts = t => Math.min(...t.items.map(i => Math.floor(left.get(i.id) / i.qty)));
    const w = simulateWeek(pool, start, handins, rand, board => {
      let best = -1;
      board.forEach((t, k) => { if (lasts(t) > 0 && (best < 0 || lasts(t) > lasts(board[best]))) best = k; });
      if (best >= 0) for (const i of board[best].items) left.set(i.id, left.get(i.id) - i.qty);
      return best;
    });
    covered += w.done.length;
  }

  return {
    traveler, handins, pool: pool.length, choices, forced: choices <= 1,
    covered: Math.round(covered / STOCK_RUNS),
    items: [...items.values()].sort((a, b) => b.need - a.need || a.name.localeCompare(b.name)),
  };
}

function stockBar(it, handins) {
  const pct  = it.need ? Math.min(100, it.have / it.need * 100) : 100;
  const cls  = it.have >= it.need ? 'ok' : it.have > 0 ? 'part' : 'none';
  const tip  = `${it.name}\nYou have ${it.have.toLocaleString()}; your ${handins} remaining hand-ins are expected to ask for ` +
               `${it.need.toLocaleString()}\n(in ${it.tasks} of the traveler's tasks, handed in in no particular order)`;
  return `<div class="stock-row" data-tip="${esc(tip)}">` +
    `<span class="stock-name">${esc(it.name)}</span>` +
    `<span class="stock-bar"><span class="stock-fill stock-${cls}" style="width:${pct}%"></span></span>` +
    `<span class="stock-num stock-${cls}-t">${it.have.toLocaleString()}<span class="sub"> / ${it.need.toLocaleString()}</span></span>` +
  `</div>`;
}

function renderStock() {
  const pools = Object.entries(S.pool || {});
  if (!pools.length) { stockSection.innerHTML = ''; return; }
  const help = 'Items the travelers can ask for this week: every task in the tiers you have unlocked.\n' +
               `Bars show what you have over what your remaining task credits (${CREDITS_PER_TASK} per hand-in) are expected to ask for,\n` +
               `from ${STOCK_RUNS} simulated weeks that start with the tasks you hold now. A finished task is replaced by a\n` +
               'random task that isn\'t the one just handed in and uses none of the items on the other 3 tasks.\n' +
               '"Your stock covers" assumes you always hand in the task you have the most of, so the new tasks\n' +
               'keep coming from what you can do. In a pool of 5, the task that comes back is always the one\n' +
               'not on the board, so you can alternate two tasks all week.';
  stockSection.innerHTML =
    `<div class="exp-label"><span data-tip="${esc(help)}" style="cursor:default;border-bottom:1px dotted #444466">Stock for this week's tasks</span></div>` +
    `<div class="stock-grid">` +
    pools.sort(([a], [b]) => a.localeCompare(b)).map(([trav, pool]) => {
      const e = stockEstimate(trav, pool);
      if (!e.handins) {
        return `<div class="stock-card"><div class="stock-head"><span class="quest-trav">${esc(trav)}</span>` +
               `<span class="sub">no credits left this week</span></div></div>`;
      }
      const cov  = e.covered >= e.handins ? 'inv-ok' : e.covered ? 'inv-part' : 'quest-short';
      const mode = e.forced ? `<span class="stock-forced" data-tip="${esc(`Only ${e.pool} tasks: each hand-in brings back the task that isn't on the board,\nso you choose what comes next. Alternate two tasks you have items for:\n${Math.ceil(e.handins / 2)} hand-ins of each covers the week.`)}">steerable</span>`
                            : `<span class="sub" data-tip="${esc(`Each new task is drawn from up to ${e.choices} that fit the rules`)}">random pick of ${e.choices}</span>`;
      return `<div class="stock-card">` +
        `<div class="stock-head"><span class="quest-trav">${esc(trav)}</span>` +
        `<span class="sub">${e.handins} hand-ins left · ${e.pool} tasks</span>${mode}</div>` +
        `<div class="stock-cover">Your stock covers <span class="${cov}">${Math.min(e.covered, e.handins)} of ${e.handins}</span></div>` +
        e.items.map(it => stockBar(it, e.handins)).join('') +
      `</div>`;
    }).join('') +
    `</div>`;
  bindTips(stockSection);
}

// ── Claim recommendation ──────────────────────────────────────────────────────
// The claims, anywhere in the world, whose markets cover the most of the tasks the player can be given:
// every task in the tiers they've unlocked, since rerolls and new tasks draw from that pool
async function loadRecommend(fresh = false) {
  const p = S.player;
  const params = [`player_id=${encodeURIComponent(p.id)}`, `username=${encodeURIComponent(p.username)}`, `range=${S.marketRangeH}`];
  if (p.regionId)          params.push(`regionId=${p.regionId}`);
  if (p.locationX != null) params.push(`x=${p.locationX}`, `z=${p.locationZ}`);
  const mine = S.recommend = { loading: true };
  renderRecommend();
  try {
    const data = await apiFetch(`/api/recommend?${params.join('&')}`, fresh);
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

// Crafting covers what can't be bought when the player has the levels and every ingredient can be had,
// bought, or crafted in turn
function craftable(pr) {
  const c = pr.craft;
  return !!c && c.levels.every(l => l.have >= l.level) && c.ingredients.every(i => !i.short || craftable(i));
}

// What crafting costs: the ingredients to buy, plus those of ingredients crafted in turn
function craftCost(c) {
  return c.ingredients.reduce((s, i) => s + i.cost + (i.short && craftable(i) ? craftCost(i.craft) : 0), 0);
}

function craftHtml(n, c, region, depth = 0) {
  const levels = c.levels.map(l => l.have >= l.level
    ? `<span class="sub">${esc(l.skill)} ${l.level} ✓</span>`
    : `<span class="quest-req">needs ${esc(l.skill)} ${l.level} (you have ${l.have})</span>`).join(' ');
  const ingredients = c.ingredients.map(i => {
    const tip = [`${i.qty.toLocaleString()} needed${i.have ? `, you have ${i.have.toLocaleString()}` : ''}`]
      .concat(i.picks.map(pickLine), i.short ? [`${i.short.toLocaleString()} not for sale in ${region}`] : []).join('\n');
    const status = i.buy ? boughtHtml(i, tip) : ` <span class="inv-ok">have</span>`;
    return `<span class="quest-have" data-tip="${esc(tip)}">${i.qty.toLocaleString()}× ${esc(i.name)}</span>${status}`;
  }).join(', ');
  const deeper = c.ingredients.filter(i => i.short && i.craft).map(i => craftHtml(i, i.craft, region, depth + 1)).join('');
  return `<div class="quest-craft" style="padding-left:${114 + depth * 16}px">↳ Craft ${c.makes.toLocaleString()} ${esc(n.name)} ` +
    `<span class="sub">(${c.crafts.toLocaleString()}× ${esc(c.recipe)} at ${esc(c.building)})</span> ${levels}: ${ingredients}</div>` + deeper;
}

function renderQuests() {
  renderActiveQuests();
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
          crafting.reduce((sum, p) => sum + craftCost(p.craft), 0);
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

// ── Active quests (Quests tab) ────────────────────────────────────────────────
// For each quest the player has started: can the current stage be finished with what they own (inventories,
// banks, their house), the player housing they added, the region's market, or the Trader Stands and stalls
// in market range? Each item is taken from the player first, then added housing, then bought cheapest, then
// bartered for at a nearby stall.
const HEX_COIN_ID = '1';
const AQ_VERDICT = {
  ready:   'Ready to hand in — you have everything',
  housing: 'Ready with items from player housing',
  buy:     'Can finish by buying',
  barter:  'Can finish with barter trades',
  craft:   'Can finish by crafting',
  short:   'Missing items',
  game:    'Do this step in game',
  stale:   'Stage moved on in game — updating…',
};
const AQ_RANK = { ready: 0, housing: 1, buy: 2, barter: 3, craft: 4, short: 5, game: 6, stale: 7 };
const AQ_DONE = new Set(['ready', 'housing', 'buy', 'barter', 'craft']);
const AQ_FILTERS = [
  ['all',   'All',           () => true],
  ['done',  'Can complete',  q => AQ_DONE.has(q._verdict)],
  ['short', 'Missing items', q => q._verdict === 'short'],
  ['game',  'In game',       q => q._verdict === 'game'],
];

function playerDist(x, z) {
  const p = S.player;
  if (p?.locationX == null || x == null || z == null) return null;
  return Math.round(Math.hypot(x - p.locationX, z - p.locationZ) / 3);
}

// A stall entry sells for coin alone (not a barter of other goods)
function coinOnly(e) {
  return !e.isBarter && e.price_parts?.length === 1 && hexPrice(e.price_parts) != null;
}

// How one stage item gets covered: {own, housing, buys, trades, short, cost, pricing, craft}
function questNeedPlan(n, stallMap) {
  const plan = { own: Math.min(n.qty, n.have), housing: [], buys: [], trades: [], short: 0, cost: 0, pricing: false, craft: null };
  let left = n.qty - plan.own;
  const entries = stallMap[n.id] || [];
  for (const e of entries.filter(e => e.isHousing)) {
    if (left <= 0) break;
    const units = Math.min(left, e.stock || 0);
    if (units > 0) { plan.housing.push({ who: e.owner, where: e.storageLabel, units }); left -= units; }
  }
  if (left > 0 && n.id !== HEX_COIN_ID) {
    // Coin offers: the region's market (from the quest price lookup) and the stalls in market range
    const cands = [];
    const pr = S.questPrices && S.questPrices !== 'loading' ? S.questPrices[n.id] : null;
    if (S.questOffers) {
      for (const o of S.questOffers[n.id] || []) {
        if (o.source !== 'market' || (S.questRegion && o.region !== S.questRegion)) continue;
        cands.push({ unit: o.price / o.bundle, units: o.units, kind: 'market', label: o.claim, seller: o.seller, dist: playerDist(o.x, o.z) });
      }
    } else if (pr) {   // no route offers (no position): fall back on the lookup's own picks
      for (const pk of pr.picks.filter(pk => pk.source === 'market')) {
        cands.push({ unit: pk.unit, units: pk.units, kind: 'market', label: pk.claim, seller: pk.seller, dist: pk.dist });
      }
    }
    for (const e of entries.filter(e => !e.isHousing && coinOnly(e))) {
      cands.push({ unit: hexPrice(e.price_parts), units: e.stock == null ? Infinity : e.stock, kind: e.stand ? 'stand' : 'stall',
                   label: e.claimName || e.name, seller: e.name, dist: e.distance, live: !!e.liveSpot });
    }
    cands.sort((a, b) => a.unit - b.unit || (a.dist ?? Infinity) - (b.dist ?? Infinity));
    for (const c of cands) {
      if (left <= 0) break;
      const units = Math.min(left, c.units);
      if (units <= 0) continue;
      const cost = Math.round(units * c.unit);
      plan.buys.push({ ...c, units, cost });
      plan.cost += cost;
      left -= units;
    }
    // Barter: stalls in range that trade the item for other goods
    for (const e of entries.filter(e => !e.isHousing && !coinOnly(e))) {
      if (left <= 0) break;
      const units = Math.min(left, e.stock == null ? left : e.stock);
      if (units <= 0) continue;
      plan.trades.push({ units, label: e.claimName || e.name, seller: e.name, dist: e.distance, price_parts: e.price_parts || [] });
      left -= units;
    }
    if (left > 0 && S.questPrices === 'loading') plan.pricing = true;
    // Crafting what can't be had otherwise: the recipe's ingredients, each from storage, housing or the market
    if (left > 0 && pr?.craft) {
      plan.craft = questCraftPlan(pr.craft, left, stallMap);
      if (plan.craft.ok) {
        plan.cost += plan.craft.cost;
        left = 0;
      }
    }
  }
  plan.short = Math.max(0, left);
  return plan;
}

// Buy `units` from a price lookup's picks, cheapest first (the lookup may have priced a larger amount)
function repick(p, units) {
  let left = units, cost = 0;
  const picks = [];
  for (const pk of p?.picks || []) {
    if (left <= 0) break;
    const u = Math.min(pk.units, left);
    picks.push({ ...pk, units: u, cost: u * pk.unit });
    cost += u * pk.unit;
    left -= u;
  }
  return { cost, short: Math.max(0, left), picks };
}

// Crafting `units` of a quest item: how many crafts, and per ingredient what the player has, what added
// housing holds and what the region sells. ok = the player has the levels and every ingredient can be had.
function questCraftPlan(c, units, stallMap) {
  const perCraft = c.per_craft || Math.max(1, Math.floor(c.makes / c.crafts));
  const crafts   = Math.ceil(units / perCraft);
  const ings = c.ingredients.map(i => {
    const qty = Math.ceil((i.per ?? i.qty / c.crafts) * crafts);
    const own = Math.min(qty, i.have || 0);
    let left  = qty - own;
    const housing = [];
    for (const e of (stallMap[i.id] || []).filter(e => e.isHousing)) {
      if (left <= 0) break;
      const u = Math.min(left, e.stock || 0);
      if (u > 0) { housing.push({ who: e.owner, where: e.storageLabel, units: u }); left -= u; }
    }
    const bought = left > 0 ? repick(i, left) : { cost: 0, short: 0, picks: [] };
    // Not for sale either: craft it too, when the lookup found its recipe
    const craft  = bought.short && i.craft ? questCraftPlan(i.craft, bought.short, stallMap) : null;
    const short  = craft?.ok ? 0 : bought.short;
    return { id: i.id, name: i.name, where: i.where || [], qty, own, housing, bought, craft, short,
             cost: bought.cost + (craft?.ok ? craft.cost : 0) };
  });
  const lowLevels = c.levels.filter(l => l.have < l.level);
  const cost = ings.reduce((s, i) => s + i.cost, 0);
  return { recipe: c.recipe, building: c.building, crafts, makes: units, levels: c.levels, lowLevels, ings, cost,
           ok: !lowLevels.length && ings.every(i => !i.short) };
}

function questVerdict(q) {
  if (q.stale) return 'stale';   // the relay says this stage is done; its next items are on the way
  if (!q.needs.length) return 'game';
  if (q._plans.some(p => p.short)) return 'short';
  if (q._plans.some(p => p.craft?.ok)) return 'craft';
  if (q._plans.some(p => p.trades.length)) return 'barter';
  if (q._plans.some(p => p.buys.length)) return 'buy';
  if (q._plans.some(p => p.housing.length)) return 'housing';
  return 'ready';
}

function aqNeedHtml(n, p, sharedBy) {
  const got  = p.own + p.housing.reduce((s, h) => s + h.units, 0);
  const cls  = p.short ? (got ? 'stock-part-t' : 'stock-none-t') : 'stock-ok-t';
  const tags = [];
  if (p.own) {
    const where = [...(n.where || [])].sort((a, b) => b.qty - a.qty).map(l => `${l.qty.toLocaleString()} in ${l.label}`).join('\n');
    tags.push(`<span class="aq-tag aq-tag-have" data-tip="${esc(where || 'In your inventory')}">have ${p.own.toLocaleString()}</span>`);
  }
  for (const h of p.housing) {
    tags.push(`<span class="aq-tag aq-tag-house" data-tip="${esc(`${h.units.toLocaleString()} in ${h.who}'s house${h.where ? ` (${h.where})` : ''}`)}">` +
      `${h.units.toLocaleString()} at ${esc(h.who)}'s house</span>`);
  }
  if (p.buys.length) {
    const units = p.buys.reduce((s, b) => s + b.units, 0);
    const tip = p.buys.map(b => `${b.units.toLocaleString()}× for ${HEX}${b.cost.toLocaleString()} — ${b.label}` +
      `${b.dist != null ? ` (${b.dist.toLocaleString()}h)` : ''}, ${b.kind}${b.seller && b.seller !== b.label ? `: ${b.seller}` : ''}` +
      `${b.kind === 'stand' && !b.live ? ` — ${STAND_NOTE}` : ''}`).join('\n');
    const where = [...new Set(p.buys.map(b => b.label))];
    tags.push(`<span class="aq-tag aq-tag-buy" data-tip="${esc(tip)}">buy ${units.toLocaleString()} for ${HEX}${p.cost.toLocaleString()} ` +
      `<span class="sub">${esc(where.length === 1 ? where[0] : `${where.length} places`)}</span>` +
      `${p.buys.some(b => b.kind === 'stand' && !b.live) ? STAND_MARK : ''}</span>`);
  }
  for (const t of p.trades) {
    const price = t.price_parts.map(pp => `${Math.round(pp.qty).toLocaleString()} ${pp.name}`).join(' + ');
    tags.push(`<span class="aq-tag aq-tag-trade" data-tip="${esc(`${t.seller} — ${t.label}${t.dist != null ? ` (${t.dist}h)` : ''}${price ? `\n${price} each` : ''}`)}">` +
      `trade for ${t.units.toLocaleString()} <span class="sub">${esc(t.label)}</span></span>`);
  }
  if (p.pricing) tags.push(`<span class="dim">checking markets…</span>`);
  else if (p.short) {
    const why = n.id === HEX_COIN_ID ? 'Hex Coin has to be earned' : 'Not for sale on your region\'s market or at the stalls in market range';
    tags.push(`<span class="aq-tag aq-tag-short" data-tip="${esc(why)}">${p.short.toLocaleString()} missing</span>`);
  }
  if (p.craft) {
    const c = p.craft;
    tags.push(`<span class="aq-tag ${c.ok ? 'aq-tag-craft-ok' : 'aq-tag-craft'}" data-tip="${esc(`${c.crafts.toLocaleString()}× ${c.recipe} at ${c.building}`)}">` +
      `craft ${c.makes.toLocaleString()}${c.cost ? ` for ${HEX}${c.cost.toLocaleString()}` : ''}</span>`);
  }
  const shared = sharedBy.length ? ` <span class="aq-keep" data-tip="${esc(`Also needed by: ${sharedBy.join(', ')}\nEach quest is checked on its own, so the same items count for each.`)}">shared</span>` : '';
  const kept   = n.consumed ? '' : ` <span class="aq-keep" data-tip="Only has to be in your inventory; the quest doesn't take it">kept</span>`;
  return `<div class="aq-need"><span class="aq-item">${esc(n.name)}${kept}${shared}</span>` +
    `<span class="aq-count ${cls}">${Math.min(got, n.qty).toLocaleString()}<span class="sub"> / ${n.qty.toLocaleString()}</span></span>` +
    `<span class="aq-src">${tags.join('')}</span>${p.craft ? aqRecipeHtml(p.craft) : ''}</div>`;
}

// The recipe and one row per ingredient: what you have, what added housing holds, what to buy and where
function aqRecipeHtml(c) {
  const levels = c.levels.map(l => l.have >= l.level
    ? `<span class="sub">${esc(l.skill)} ${l.level} ✓</span>`
    : `<span class="aq-tag aq-tag-short">needs ${esc(l.skill)} ${l.level} (you have ${l.have})</span>`).join(' ');
  const rows = c.ings.map(i => {
    const got  = i.own + i.housing.reduce((s, h) => s + h.units, 0);
    const buy  = i.bought.picks.reduce((s, pk) => s + pk.units, 0);
    const cls  = i.short ? (got + buy ? 'stock-part-t' : 'stock-none-t') : 'stock-ok-t';
    const tags = [];
    if (i.own) {
      const where = [...i.where].sort((a, b) => b.qty - a.qty).map(l => `${l.qty.toLocaleString()} in ${l.label}`).join('\n');
      tags.push(`<span class="aq-tag aq-tag-have" data-tip="${esc(where || 'In your inventory')}">have ${i.own.toLocaleString()}</span>`);
    }
    for (const h of i.housing) {
      tags.push(`<span class="aq-tag aq-tag-house" data-tip="${esc(`${h.units.toLocaleString()} in ${h.who}'s house${h.where ? ` (${h.where})` : ''}`)}">` +
        `${h.units.toLocaleString()} at ${esc(h.who)}'s house</span>`);
    }
    if (buy) {
      const where = [...new Set(i.bought.picks.map(pk => pk.claim))];
      tags.push(`<span class="aq-tag aq-tag-buy" data-tip="${esc(i.bought.picks.map(pickLine).join('\n'))}">buy ${buy.toLocaleString()} for ` +
        `${HEX}${i.bought.cost.toLocaleString()} <span class="sub">${esc(where.length === 1 ? where[0] : `${where.length} places`)}</span>` +
        `${i.bought.picks.some(pk => pk.stand) ? STAND_MARK : ''}</span>`);
    }
    if (i.short) tags.push(`<span class="aq-tag aq-tag-short" data-tip="Not for sale on your region's market">${i.short.toLocaleString()} missing</span>`);
    if (i.craft) {
      tags.push(`<span class="aq-tag ${i.craft.ok ? 'aq-tag-craft-ok' : 'aq-tag-craft'}">craft ${i.craft.makes.toLocaleString()}` +
        `${i.craft.cost ? ` for ${HEX}${i.craft.cost.toLocaleString()}` : ''}</span>`);
    }
    return `<div class="aq-ing"><span class="aq-item">${esc(i.name)}</span>` +
      `<span class="aq-count ${cls}">${Math.min(got + buy, i.qty).toLocaleString()}<span class="sub"> / ${i.qty.toLocaleString()}</span></span>` +
      `<span class="aq-src">${tags.join('')}</span>${i.craft ? aqRecipeHtml(i.craft) : ''}</div>`;
  }).join('');
  return `<div class="aq-recipe"><div class="aq-recipe-head">↳ ${c.crafts.toLocaleString()}× ${esc(c.recipe)} ` +
    `<span class="sub">at ${esc(c.building || 'a crafting station')}</span> ${levels}</div>${rows}</div>`;
}

// Everything one quest has you buy or trade for, by place: the quest's own items and the ingredients of
// crafts it can go ahead with. [{place, dist, cost, unsure, items: [{name, units, cost, from}]}], nearest first.
function questShopping(q) {
  const at  = new Map();
  const add = (place, dist, name, units, cost, from, unsure) => {
    if (!at.has(place)) at.set(place, { place, dist, cost: 0, unsure: false, items: new Map() });
    const p = at.get(place);
    if (p.dist == null || (dist != null && dist < p.dist)) p.dist = dist;
    p.unsure ||= unsure;
    p.cost += cost || 0;
    const it = p.items.get(name) || { name, units: 0, cost: 0, trade: false, from: new Set() };
    it.units += units;
    it.cost  += cost || 0;
    it.trade ||= cost == null;
    it.from.add(from);
    p.items.set(name, it);
  };
  const crafted = c => {
    for (const i of c.ings) {
      for (const pk of i.bought.picks) add(pk.claim, pk.dist, i.name, pk.units, pk.cost, sellerLine(pk), !!pk.stand);
      if (i.craft?.ok) crafted(i.craft);
    }
  };
  q.needs.forEach((n, k) => {
    const p = q._plans[k];
    for (const b of p.buys) {
      add(b.label, b.dist, n.name, b.units, b.cost, `${b.kind}${b.seller && b.seller !== b.label ? `: ${b.seller}` : ''}`,
          b.kind === 'stand' && !b.live);
    }
    for (const t of p.trades) {
      const price = t.price_parts.map(pp => `${Math.round(pp.qty).toLocaleString()} ${pp.name}`).join(' + ');
      add(t.label, t.dist, n.name, t.units, null, `trade: ${t.seller}${price ? ` (${price} each)` : ''}`, false);
    }
    if (p.craft?.ok) crafted(p.craft);
  });
  return [...at.values()].map(p => ({ ...p, items: [...p.items.values()] }))
    .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity) || a.place.localeCompare(b.place));
}

function aqShoppingHtml(q) {
  const places = questShopping(q);
  if (!places.length) return '';
  const total = places.reduce((s, p) => s + p.cost, 0);
  return `<div class="aq-shop"><div class="aq-shop-head">Shopping list` +
    `${total ? ` <span class="quest-cost">${HEX}${total.toLocaleString()}</span>` : ''}` +
    `${q._verdict === 'short' ? ` <span class="sub">(what's for sale; the quest still needs more)</span>` : ''}</div>` +
    places.map(p =>
      `<div class="aq-shop-row"><span class="aq-shop-place">${esc(p.place)}${p.unsure ? STAND_MARK : ''}` +
      `${p.dist != null ? ` <span class="sub">${p.dist.toLocaleString()}h</span>` : ''}</span>` +
      `<span class="aq-shop-cost">${p.cost ? `${HEX}${p.cost.toLocaleString()}` : ''}</span>` +
      `<span class="aq-shop-items">` + p.items.map(it =>
        `<span class="aq-shop-item" data-tip="${esc([...it.from].join('\n'))}">${it.units.toLocaleString()}× ${esc(it.name)}` +
        `${it.cost ? ` <span class="sub">${HEX}${it.cost.toLocaleString()}</span>` : it.trade ? ' <span class="sub">trade</span>' : ''}</span>`
      ).join('') + `</span></div>`
    ).join('') + `</div>`;
}

function renderActiveQuests(stallMap = buildStallMap()) {
  if (!S.tasksLoaded || !S.activeQuests.length) {
    aqSection.innerHTML = S.tasksLoaded ? '<div class="exp-label">No active quests found.</div>' : '';
    renderTabCounts();
    return;
  }
  const users = {};   // item id → names of the quests needing it
  for (const q of S.activeQuests) for (const n of q.needs) (users[n.id] ||= []).push(q.name);
  for (const q of S.activeQuests) {
    q._plans   = q.needs.map(n => questNeedPlan(n, stallMap));
    q._verdict = questVerdict(q);
  }
  const counts = Object.fromEntries(AQ_FILTERS.map(([k, , f]) => [k, S.activeQuests.filter(f).length]));
  if (!counts[S.aqFilter]) S.aqFilter = 'all';
  const show = S.activeQuests.filter(AQ_FILTERS.find(([k]) => k === S.aqFilter)[2])
    .sort((a, b) => AQ_RANK[a._verdict] - AQ_RANK[b._verdict] || (b.tracked - a.tracked) || a.name.localeCompare(b.name));

  const range  = Math.max(S.marketRangeH, STAND_CLAIM_RADIUS_H);
  const claim  = S.allClaims.find(c => c.id === S.selectedClaimId)?.name;
  const houses = S.housedPlayers.length ? `, ${S.housedPlayers.length} added player house${S.housedPlayers.length === 1 ? '' : 's'}` : '';
  const help = 'Checks the current stage of each quest you have started.\n' +
    `Items come from your inventories, banks and house first${houses ? ', then the player housing you added' : ''},\n` +
    `then the cheapest coin offers on the ${S.questRegion || 'region'} market and at stalls and Trader Stands within ${range}h of ${claim || 'you'},\n` +
    'then barter trades at those stalls. Anything still missing is crafted when you have the levels and every\n' +
    "ingredient can be had from your storage, added housing or the region's market (stalls included).\n" +
    'Move the market range slider to look further for stalls.';
  aqSection.innerHTML =
    `<div class="aq-summary"><span class="exp-label" style="display:inline;margin:0">` +
    `<span data-tip="${esc(help)}" style="cursor:default;border-bottom:1px dotted #444466">Active quests</span></span>` +
    AQ_FILTERS.map(([k, label]) => counts[k] || k === 'all'
      ? `<button type="button" class="aq-filter${S.aqFilter === k ? ' active' : ''}" data-aqf="${k}">${label} <b>${counts[k]}</b></button>` : '').join('') +
    `<span class="sub">Sources: your storage${houses}, ${esc(S.questRegion || 'region')} market, stalls within ${range}h` +
    `${S.questPrices === 'loading' ? ' · checking markets…' : ''}</span></div>` +
    `<div class="aq-list">` + show.map(q => {
      const total = q._plans.reduce((s, p) => s + p.cost, 0);
      const cost  = !total ? '' : q._verdict === 'short'
        ? ` <span class="sub" style="text-transform:none;font-weight:400">· ${HEX}${total.toLocaleString()} buys what's for sale</span>`
        : ` <span class="quest-cost">${HEX}${total.toLocaleString()}</span>`;
      const extra = q.needs.length && q.other ? ` <span class="sub">+ ${q.other} step${q.other === 1 ? '' : 's'} in game</span>` : '';
      const needs = q.stale ? '' : q.needs.map((n, i) => aqNeedHtml(n, q._plans[i], [...new Set(users[n.id].filter(x => x !== q.name))])).join('');
      const track = q.tracked ? `<span class="aq-track" data-tip="Tracked in game">★</span>` : '';
      return `<div class="aq-card aq-${q._verdict}">` +
        `<div class="aq-head"><span class="aq-name">${esc(q.name)}</span>${track}` +
        `<span class="aq-stagen">stage ${q.stage_index + 1} of ${q.total_stages || '?'}</span></div>` +
        `<div class="aq-stage">${esc(q.stage)}</div>` +
        `<div class="aq-verdict">${AQ_VERDICT[q._verdict]}${cost}${extra}</div>` +
        needs +
        (q.rewards?.length ? `<div class="aq-rewards">Rewards: ${q.rewards.map(r => `<b>${esc(r)}</b>`).join(', ')}</div>` : '') +
        aqShoppingHtml(q) +
      `</div>`;
    }).join('') + `</div>`;
  bindTips(aqSection);
  renderTabCounts();
}

aqSection.addEventListener('click', e => {
  const b = e.target.closest('[data-aqf]');
  if (!b) return;
  S.aqFilter = b.dataset.aqf;
  renderActiveQuests();
});

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
        const gather = c => {
          for (const i of c.ingredients) {
            if (i.have) wanted.push({ id: i.id, name: i.name, qty: i.qty, where: i.where || [] });
            if (i.short && i.craft) gather(i.craft);   // ingredients crafted in turn
          }
        };
        gather(pr.craft);
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
  renderActiveQuests(stallMap);   // nearby stalls and player housing feed the Quests tab too
  let tasks = [...S.tasks].filter(t => !S.travelerFilter || t.traveler === S.travelerFilter)
                          .map(t => decorateTask(t, stallMap));

  tasks.sort((a, b) => {
    const sa = STATUS_RANK[taskStatus(a)], sb = STATUS_RANK[taskStatus(b)];
    if (sa !== sb) return sa - sb;
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
    const who = S.travelerFilter ? ` for ${S.travelerFilter}` : '';
    emptyMsg.textContent = S.filterOn ? `No completable tasks found${who}.`
      : (S.travelerFilter ? `No incomplete tasks found${who}.` : (S.tasks.length ? '' : 'No incomplete tasks found.'));
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
    // A stall with some stock but not enough for what's left to buy is still listed, marked partial;
    // only stalls that can cover it all count towards cost, profit and "completable"
    const toBuy  = item.qty - Math.min(item.qty, item.inv_have || 0);
    const nearby = (stallMap[item.id] || [])
      .filter(e => e.stock == null || e.stock > 0)
      .map(e => ({ ...e, partial: e.stock != null && e.stock < toBuy }));
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
      if (m.isBarter || m.partial) continue;
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
  const hasSource = items.some(i => i.stall_matches.some(m => !m.partial) || i.market_price != null);
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
    (item.stall_matches || []).some(m => !m.partial) ||
    item.market_price != null ||
    item.craft_info?.status === 'yes'
  );
}

// ── Row renderer ──────────────────────────────────────────────────────────────
// One table row per item, so each item's sources sit right beside it; the task's own cells (traveler,
// reward, cost, profit) span its items.

// ready: everything's in hand. buyable: every item has a full source. missing: some item has none.
function taskStatus(task) {
  if (task.items.every(i => (i.inv_have || 0) >= i.qty)) return 'ready';
  return isCompletable(task) ? 'buyable' : 'missing';
}
const STATUS_RANK  = { ready: 0, buyable: 1, missing: 2 };
const STATUS_LABEL = { ready: 'Ready to hand in', buyable: 'Can get it all', missing: 'Missing a source' };

function haveHtml(item) {
  if (!item.inv_have) return `<span class="dim">—</span>`;
  const cls  = item.inv_have >= item.qty ? 'inv-ok' : 'inv-part';
  const locs = (item.inv_locations || []).map(l => `${l.qty.toLocaleString()} in ${l.label}`).join('\n');
  const tip  = `${item.inv_have.toLocaleString()} / ${item.qty.toLocaleString()} needed${locs ? '\n' + locs : ''}` +
               (item.inv_have_live ? '\n(live count; the breakdown is from the last refresh)' : '');
  return `<span class="${cls}" data-tip="${esc(tip)}">${item.inv_have.toLocaleString()}</span>`;
}

function distHtml(d) {
  return d != null ? `<span class="sub">${Math.round(d / 3).toLocaleString()}h</span>` : `<span class="sub dim">?h</span>`;
}

// Every place to get an item, best first: {order, html}. order sorts full sources by unit price, then
// partial stock, then barter stalls, housing and crafting.
function itemSources(task, item) {
  const out    = [];
  const ownQty = Math.min(item.qty, item.inv_have || 0);
  const toBuy  = item.qty - ownQty;
  const tag    = (cls, label) => `<span class="src-tag src-${cls}">${label}</span>`;

  for (const m of (item.stall_matches || [])) {
    if (m.isHousing) {
      out.push({ order: 3e9, html: `${tag('house', 'Housing')} <span class="housing-name">${esc(m.name)}</span> <span class="sub">(${esc(m.storageLabel)})</span>` });
      continue;
    }
    if (m.isBarter) {
      const claim = m.claimName ? ` <span class="sub">(${esc(m.claimName)})</span>` : '';
      const bp = priceHtml(m.price_parts);
      out.push({ order: 2e9, html: `${tag('barter', 'Barter')} <span class="stall-name">${esc(m.name)}</span>${bp ? ' · ' + bp : ''}${claim} ${distHtml(m.distance)}` });
      continue;
    }
    const coin   = hexPrice(m.price_parts);
    const profit = coin != null ? task.reward - coin * toBuy - (item.unit_price ?? coin) * ownQty : null;
    const note   = m.partial
      ? ` <span class="stock-short" data-tip="${esc(`Only ${m.stock.toLocaleString()} in stock; you need ${toBuy.toLocaleString()}`)}">only ${m.stock.toLocaleString()} left</span>`
      : profit != null ? ` <span class="${profit >= 0 ? 'profit-pos' : 'profit-neg'}" data-tip="Task profit buying here">(${HEX}${profit.toLocaleString()})</span>` : '';
    const name  = m.name !== m.owner && m.name ? m.name : m.owner;
    const mark  = !m.stand ? ''
      : m.liveSpot ? `<span class="stand-live" data-tip="${esc(`Live: set up at N ${Math.round(m.liveSpot.z / 3)}, E ${Math.round(m.liveSpot.x / 3)}, ${m.liveSpot.stock.toLocaleString()} in stock`)}">●</span>`
      : `<span data-tip="Trader Stands can be moved, so this one ${STAND_NOTE}">${STAND_MARK}</span>`;
    const ph    = priceHtml(m.price_parts);
    out.push({
      order: m.partial ? 1e9 + (coin ?? 0) : (coin ?? 5e8),
      html:  `${tag('stall', m.stand ? 'Stand' : 'Stall')} <span class="stall-name">${esc(name)}</span>${mark}${ph ? ' · ' + ph : ''}${note} ${distHtml(m.distance)}`,
    });
  }

  for (const mp of item.market_prices || []) {
    const claim = mp.claimName ? ` <span class="stall-name" data-tip="Every market in the region sells the same listings; this is the nearest one">${esc(mp.claimName)}</span>` : '';
    out.push({
      order: mp.price,
      html:  `${tag('market', 'Market')}${claim} · <span class="market-price">${HEX}${mp.price.toLocaleString()}/u</span> <span class="sub">(${HEX}${(mp.price * toBuy).toLocaleString()} for ${toBuy.toLocaleString()})</span> ${distHtml(mp.distance)}`,
    });
  }

  const ci = item.craft_info;
  if (ci && ci.status && ci.status !== 'none' && ci.status !== 'no') {
    const tip = (ci.details || []).map(d => `${d.name}: ${d.have.toLocaleString()} / ${d.need.toLocaleString()}`).join('\n');
    const bld = ci.building ? ` <span class="sub">(${esc(ci.building)})</span>` : '';
    const how = ci.status === 'yes' ? '<span class="craft-ok">you have the materials</span>' : '<span class="inv-part">some materials</span>';
    out.push({ order: 4e9, html: `<span data-tip="${esc(tip)}">${tag('craft', 'Craft')} ${how}${bld}</span>` });
  }
  return out.sort((a, b) => a.order - b.order);
}

const SOURCES_SHOWN = 3;
function sourcesHtml(task, item) {
  if ((item.inv_have || 0) >= item.qty) {
    const where = item.inv_locations?.[0]?.label;
    return `<span class="src-have">✓ You have ${item.qty > 1 ? 'them' : 'it'}</span>${where ? ` <span class="sub">(${esc(where)}${item.inv_locations.length > 1 ? ' +' + (item.inv_locations.length - 1) : ''})</span>` : ''}`;
  }
  if (!S.stallsLoaded && !item.market_price && !item.market_prices?.length) return '<span class="dim">⏳</span>';
  const all = itemSources(task, item);
  if (!all.length) return `<span class="src-none">No source found nearby</span>`;
  const lines = all.map(s => `<div class="src-line">${s.html}</div>`);
  const more  = lines.length - SOURCES_SHOWN;
  return lines.slice(0, SOURCES_SHOWN).join('') +
    (more > 0 ? `<details class="src-more"><summary>+${more} more</summary>${lines.slice(SOURCES_SHOWN).join('')}</details>` : '');
}

function renderRow(task) {
  const n      = task.items.length;
  const status = taskStatus(task);
  const missing = status === 'missing'
    ? task.items.filter(i => (i.inv_have || 0) < i.qty && !itemSources(task, i).some(s => s.order < 1e9)).map(i => i.name) : [];
  const lvlStr = task.min_level > 1 ? ` Lv ${task.min_level}+` : '';
  const expStr = task.exp_qty ? ` · ${task.exp_qty.toLocaleString()} xp` : '';
  const profitStr = task.profit != null ? `${HEX} ${task.profit.toLocaleString()}` : `<span class="dim">—</span>`;
  const profitCls = task.profit == null ? '' : task.profit >= 0 ? ' profit-pos' : ' profit-neg';
  const statusTip = status === 'missing' ? `No full source nearby for: ${missing.join(', ')}` : STATUS_LABEL[status];
  const span = `rowspan="${n}"`;

  return task.items.map((item, i) => {
    const tag   = item.type === 'cargo' ? ` <span class="type-tag">cargo</span>` : '';
    const first = i === 0 ? `
      <td class="c-traveler" ${span}>${esc(task.traveler)}<div class="traveler-sub">${esc(task.skill_name)}${lvlStr}${expStr}</div>
        <div class="task-status status-${status}" data-tip="${esc(statusTip)}">${STATUS_LABEL[status]}</div></td>` : '';
    const last  = i === 0 ? `
      <td class="c-num" ${span}>${HEX} ${task.reward.toLocaleString()}</td>
      <td class="c-num" ${span}>${costHtml(task)}</td>
      <td class="c-num${profitCls}" ${span}>${profitStr}</td>` : '';
    return `<tr class="task-row status-row-${status}${i === 0 ? ' task-first' : ''}">${first}
      <td class="c-items"><span class="qty">${item.qty.toLocaleString()}×</span> ${esc(item.name)}${tag}</td>
      <td class="c-inv">${haveHtml(item)}</td>
      <td class="c-sources">${sourcesHtml(task, item)}</td>${last}
    </tr>`;
  }).join('');
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

// ── Live tasks, credits and inventory ─────────────────────────────────────────
// BitJita's relay streams the game's own tables over SpacetimeDB's v1 JSON protocol, one database per
// region. Rows come as JSON arrays in column order:
//   traveler_task_state         [entity_id, player_entity_id, traveler_id, task_id, completed]
//   traveler_task_credit_state  [entity_id, player_entity_id, traveler_id, credits, last_reset]
//   inventory_state             [entity_id, pockets, inventory_index, cargo_index, owner_entity_id, player_owner_entity_id]
// A hand-in, credits and the player's own containers in their region are applied straight away. The relay
// only has ids, so a new task triggers a quiet reload of /api/tasks for its names, prices and stock.
// Containers the relay doesn't hold (deployables, other regions, housing) keep BitJita's counts.
const RELAYS          = [{ host: 'relay.bitjita.com' }, { host: 'relay.bitcraftsync.app', portBase: 3000 }];
const LIVE_RELOAD_MS  = 4000;                  // gather a burst of changes into one reload
const LIVE_RETRY_MS   = [15000, 30000, 60000]; // BitJita can lag: reload again while new tasks are missing
const LIVE_FILL_MS    = 60000;                 // a new task built from the pool gets the rest a minute later
const LIVE_RENDER_MS  = 300;                   // inventory changes come in bursts while playing
const LIVE_STALLS_RELOAD_MS = 15000;           // gather trade changes across all the region's stands
const liveEl          = $('live-status');
const L = {
  ws: null, key: null, ready: false, relay: 0, fails: 0,
  tasks: new Map(), credits: new Map(), bags: new Map(), positions: new Map(), orders: new Map(), quests: new Map(),
  questReloadTries: 0, sentStands: [], liveStands: new Set(), requestId: 0, dirty: false, creditsDirty: false,
  retryTimer: null, reloadTimer: null, renderTimer: null, stallsTimer: null, reloadTries: 0, reloading: false,
};

function liveKey() {
  const id = String(S.player?.id ?? ''), region = parseInt(S.player?.regionId, 10);
  return /^\d+$/.test(id) && region > 0 ? `${region}:${id}` : null;
}

function liveStart() {
  const key = liveKey();
  if (key === L.key && L.ws) return;   // already following this player
  liveStop();
  if (!key) { liveSetStatus('off', 'Live updates need the player’s region'); return; }
  L.key = key;
  liveConnect(0);
}

function liveStop() {
  clearTimeout(L.retryTimer);
  clearTimeout(L.reloadTimer);
  clearTimeout(L.renderTimer);
  clearTimeout(L.stallsTimer);
  clearInterval(L.probeTimer);
  const ws = L.ws;
  Object.assign(L, { ws: null, key: null, ready: false, fails: 0, reloadTries: 0, sentStands: [], liveStands: new Set(),
                     tasks: new Map(), credits: new Map(), bags: new Map(), positions: new Map(), orders: new Map() });
  if (ws) { ws.onclose = null; ws.close(); }
  liveSetStatus('off');
}

function liveRelayUrl(i) {
  const region = L.key.split(':')[0];
  const relay  = RELAYS[i];
  const port   = relay.portBase ? `:${relay.portBase + Number(region)}` : '';
  return `wss://${relay.host}${port}/v1/database/idc-${region}/subscribe?compression=None&light=true`;
}

// BitJita's relay first. The backup is only for when it doesn't answer: a failed attempt moves straight
// on to the next relay, and once all have failed the page waits and starts over from BitJita's.
function liveConnect(i = 0) {
  clearInterval(L.probeTimer);
  L.relay = i;
  liveSetStatus(L.fails ? 'retrying' : 'connecting');
  let ws;
  try { ws = new WebSocket(liveRelayUrl(i), ['v1.json.spacetimedb']); }
  catch { liveNextRelay(i); return; }
  L.ws = ws;
  ws.onopen = () => liveSubscribe();
  ws.onmessage = e => liveMessage(ws, e.data);
  ws.onclose = () => {
    if (L.ws !== ws) return;
    if (ws.gotData) liveRetry();   // dropped after working: start over from BitJita's relay
    else liveNextRelay(i);         // never answered: try the next relay now
  };
}

function liveNextRelay(i) {
  L.ws = null; L.ready = false;
  if (i + 1 < RELAYS.length) liveConnect(i + 1);
  else liveRetry();
}

function liveRetry() {
  L.ws = null; L.ready = false; L.fails++;
  const wait = Math.min(30000, 1000 * 2 ** Math.min(L.fails, 5));
  liveSetStatus('retrying');
  clearTimeout(L.retryTimer);
  L.retryTimer = setTimeout(() => { if (L.key) liveConnect(0); }, wait);
}

// While on the backup, check BitJita's relay every couple of minutes and move back once it answers
const LIVE_PROBE_MS = 120000;
function liveProbePrimary() {
  clearInterval(L.probeTimer);
  L.probeTimer = setInterval(() => {
    if (!L.key || L.relay === 0) { clearInterval(L.probeTimer); return; }
    const key = L.key;
    let probe;
    try { probe = new WebSocket(liveRelayUrl(0), ['v1.json.spacetimedb']); } catch { return; }
    const done = setTimeout(() => probe.close(), 10000);
    probe.onmessage = () => {
      clearTimeout(done);
      probe.onclose = null;
      probe.close();
      if (L.key !== key || L.relay === 0) return;
      const old = L.ws;
      if (old) { old.onclose = null; old.close(); }
      liveConnect(0);
    };
    probe.onclose = () => clearTimeout(done);
  }, LIVE_PROBE_MS);
}

// Each table's columns in order. BitJita's relay sends rows as arrays in this order; the backup relay
// sends objects keyed by column name. liveParse turns both into arrays.
const LIVE_TABLES = {
  traveler_task_state: {
    cols: ['entity_id', 'player_entity_id', 'traveler_id', 'task_id', 'completed'],
    map:  'tasks',   read: v => ({ key: String(v[0]), task: String(v[3]), traveler: v[2], completed: !!v[4] }),
  },
  traveler_task_credit_state: {
    cols: ['entity_id', 'player_entity_id', 'traveler_id', 'credits', 'last_reset'],
    map:  'credits', read: v => ({ key: String(v[2]), credits: v[3], last: v[4] }),
  },
  inventory_state: {
    cols: ['entity_id', 'pockets', 'inventory_index', 'cargo_index', 'owner_entity_id', 'player_owner_entity_id'],
    map:  'bags',    read: v => ({ key: String(v[0]), items: liveBagItems(v[1]), owner: String(v[4]), playerOwner: String(v[5]) }),
  },
  // where a Trader Stand is now; a packed-up stand has no row
  mobile_entity_state: {
    cols: ['entity_id', 'chunk_index', 'timestamp', 'location_x', 'location_z'],
    map:  'positions', read: v => ({ key: String(v[0]), x: Number(v[3]) / 1000, z: Number(v[4]) / 1000 }),
  },
  // a stand's trades: only followed for changes, which reload /api/stalls for names and prices
  // the player's quests: which stage each is on, finished, tracked
  quest_chain_state: {
    cols: ['entity_id', 'player_entity_id', 'quest_chain_desc_id', 'stage_id', 'completed', 'stage_rewards_awarded', 'tracked'],
    map:  'quests',  read: v => ({ key: String(v[2]), stage: String(v[3]), completed: !!v[4], tracked: !!v[6] }),
  },
  trade_order_state: {
    cols: ['entity_id', 'shop_entity_id', 'remaining_stock'],
    map:  'orders',  read: v => ({ key: String(v[0]), shop: String(v[1]), stock: v[2] }),
  },
};

// The region's Trader Stands to follow: their position, trades and stock (the stand's own inventory)
function liveStandIds() {
  return [...new Set(S.stalls.filter(s => s.stand && /^\d+$/.test(String(s.stallEntityId || '')))
    .map(s => String(s.stallEntityId)))].sort();
}

function liveQueries() {
  const playerId = L.key.split(':')[1];
  const q = [
    `SELECT * FROM traveler_task_state WHERE player_entity_id = ${playerId}`,
    `SELECT * FROM traveler_task_credit_state WHERE player_entity_id = ${playerId}`,
    `SELECT * FROM inventory_state WHERE owner_entity_id = ${playerId}`,          // pockets, toolbelt, wallet
    `SELECT * FROM inventory_state WHERE player_owner_entity_id = ${playerId}`,   // banks and stashes
    `SELECT * FROM quest_chain_state WHERE player_entity_id = ${playerId}`,
  ];
  for (const id of L.sentStands) {
    q.push(`SELECT * FROM mobile_entity_state WHERE entity_id = ${id}`,
           `SELECT * FROM trade_order_state WHERE shop_entity_id = ${id}`,
           `SELECT * FROM inventory_state WHERE owner_entity_id = ${id}`);
  }
  return q;
}

// (Re)send the subscription; the relay answers with a fresh InitialSubscription for all of it
function liveSubscribe() {
  if (!L.ws || L.ws.readyState !== WebSocket.OPEN) return;
  L.sentStands = liveStandIds();
  L.ws.send(JSON.stringify({ Subscribe: { query_strings: liveQueries(), request_id: ++L.requestId } }));
}

// Called when the region's stands change: follow the new set
function liveWatchStands() {
  if (liveStandIds().join() !== L.sentStands.join()) liveSubscribe();
  liveApplyStands();
  liveRenderSoon();
}

function liveMessage(ws, raw) {
  if (L.ws !== ws) return;
  // rows arrive as JSON strings inside the message; liveParse reads those with their big ids kept exact
  let msg;
  try { msg = JSON.parse(String(raw)); }
  catch { return; }
  if (msg.SubscriptionError) {
    console.warn('[live] subscription error', msg.SubscriptionError.error);
    liveSetStatus('off', 'The relay refused the live feed');
    ws.onclose = null; ws.close(); L.ws = null;
    return;
  }
  const initial = msg.InitialSubscription?.database_update;
  const update  = msg.TransactionUpdateLight?.update ?? msg.TransactionUpdate?.status?.Committed;
  if (!initial && !update) return;
  if (initial) {
    Object.assign(L, { tasks: new Map(), credits: new Map(), bags: new Map(), positions: new Map(), orders: new Map(), quests: new Map(),
                       ready: true, fails: 0, liveStands: new Set(L.sentStands) });
    ws.gotData = true;
    liveSetStatus('live');
    if (L.relay > 0) liveProbePrimary();
  }
  const changed = new Set();
  for (const table of (initial || update).tables || []) {
    const spec = LIVE_TABLES[table.table_name];
    if (!spec) continue;
    const map = L[spec.map];
    for (const u of table.updates || []) {
      for (const r of u.deletes || []) { const v = liveParse(r, spec.cols); if (v) map.delete(spec.read(v).key); }
      for (const r of u.inserts || []) { const v = liveParse(r, spec.cols); if (v) { const row = spec.read(v); map.set(row.key, row); } }
    }
    changed.add(spec.map);
  }
  if (initial || changed.has('credits')) liveApplyCredits();
  if (initial || changed.has('bags'))    liveApplyInventory();
  if (initial || changed.has('tasks'))   liveReconcile(!initial);
  if (initial || changed.has('quests'))  liveApplyQuests(!initial);
  if (initial || changed.has('positions') || changed.has('bags')) liveApplyStands();
  if (!initial && changed.has('orders')) liveScheduleStallsReload();
  liveRenderSoon();
}

function liveParse(r, cols) {
  // entity ids are bigger than JS numbers can hold exactly, so read them as strings
  let v = r;
  if (typeof r === 'string') {
    try { v = JSON.parse(r.replace(/([:[,])(-?\d{16,})(?=[,}\]])/g, '$1"$2"')); } catch { return null; }
  }
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object' && cols.every(c => c in v)) return cols.map(c => v[c]);
  return null;
}

// {item_id: qty} in one container. A pocket is [volume, contents, locked]; contents is an option,
// [0, [item_id, quantity, item_type, durability]] when something is in it.
function liveBagItems(pockets) {
  const items = {};
  for (const p of pockets || []) {
    const c = p?.[1];
    if (!c || c[0] !== 0 || !Array.isArray(c[1])) continue;
    const id = String(c[1][0]);
    items[id] = (items[id] || 0) + (Number(c[1][1]) || 0);
  }
  return items;
}

// Make the table match the relay: drop finished tasks now, reload for tasks BitJita hasn't shown yet.
// changed = the relay just reported a change to the tasks.
function liveReconcile(changed) {
  if (!L.ready || !S.tasksLoaded) return;
  if (!L.tasks.size) {   // every player has tasks, so none means this region's database doesn't hold them
    liveSetStatus('off', 'No live task data for this player in their region');
    return;
  }
  const open   = new Set([...L.tasks.values()].filter(r => !r.completed).map(r => r.key));
  const before = S.tasks.length;
  S.tasks = S.tasks.filter(t => !t.entity_id || open.has(t.entity_id));
  const handedIn = before - S.tasks.length;
  if (handedIn) {
    if (!S.tasks.length) emptyMsg.textContent = 'No incomplete tasks found.';
    L.dirty = true;
    liveFlash(`${handedIn} task${handedIn === 1 ? '' : 's'} handed in`);
  }
  // New tasks: built straight from the traveler's task pool (which /api/tasks already sent), so they show
  // at once without a reload. One quiet reload later fills in what the pool doesn't have (crafting, all
  // market prices); it's only retried while a task isn't in the pool and BitJita hasn't caught up.
  const shown = new Set(S.tasks.map(t => t.entity_id));
  let added = 0, unknown = false;
  for (const row of L.tasks.values()) {
    if (row.completed || shown.has(row.key)) continue;
    const task = liveTaskFromPool(row);
    if (task) { S.tasks.push(task); added++; } else unknown = true;
  }
  if (added) {
    L.dirty = true;
    liveApplyInventory();
    liveFlash(`${added} new task${added === 1 ? '' : 's'}`);
  }
  if (changed) L.reloadTries = 0;
  if (added && !unknown && changed) liveScheduleReload(LIVE_FILL_MS);
  else if (unknown && L.reloadTries < LIVE_RETRY_MS.length) {
    liveScheduleReload(changed ? LIVE_RELOAD_MS : LIVE_RETRY_MS[L.reloadTries++]);
  }
}

// A task the relay just gave the player, from the pool of tasks their traveler can hand out
function liveTaskFromPool(row) {
  const traveler = S.credits.find(c => String(c.traveler_id) === String(row.traveler))?.traveler
                ?? S.tasks.find(t => String(t.traveler_id) === String(row.traveler))?.traveler;
  const entry = traveler && (S.pool[traveler] || []).find(p => String(p.id) === String(row.task));
  if (!entry) return null;
  // reuse what other tasks already know about an item (its market prices)
  const known = id => S.tasks.flatMap(t => t.items).find(i => String(i.id) === String(id));
  return {
    id: entry.id, entity_id: row.key, traveler, traveler_id: Number(row.traveler),
    description: '', reward: entry.reward, exp_qty: 0, exp_skill_id: '', skill_name: traveler,
    min_level: null, max_level: null, from_pool: true,
    items: entry.items.map(i => {
      const k = known(i.id);
      return {
        id: String(i.id), name: i.name, type: i.type, qty: i.qty,
        inv_have: k?.inv_have_base ?? k?.inv_have ?? i.have_base ?? i.have ?? 0, inv_locations: k?.inv_locations || [],
        market_price: k?.market_price ?? null, market_prices: k?.market_prices ?? [],
      };
    }),
  };
}

// Weekly credits per traveler. The reset is global but last_reset only moves when the player is
// active, so a reset that has passed since then means the credits are full again (as in api/tasks.py).
const CREDIT_PERIOD_S = 7 * 24 * 3600;
function liveApplyCredits() {
  if (!L.ready || !L.credits.size || !S.credits.length) return;
  const now = Date.now() / 1000;
  for (const c of S.credits) {
    const row = L.credits.get(String(c.traveler_id));
    if (!row) continue;
    let amount = row.credits, next = null;
    if (row.last) {
      const periods = Math.max(1, Math.ceil((now - row.last) / CREDIT_PERIOD_S));
      next = row.last + periods * CREDIT_PERIOD_S;
      if (periods > 1 && c.weekly != null) amount = c.weekly;
    }
    if (amount !== c.credits || (next && next !== c.next_reset)) {
      c.credits = amount;
      if (next) c.next_reset = next;
      L.dirty = L.creditsDirty = true;
    }
  }
}

// Live item counts: BitJita's total, with each container the relay holds swapped for its live contents.
function liveApplyInventory() {
  if (!L.ready || !S.tasksLoaded) return;
  const playerId = L.key.split(':')[1];
  const delta = {};
  for (const [bag, row] of L.bags) {
    if (row.owner !== playerId && row.playerOwner !== playerId) continue;   // a Trader Stand's stock
    const base = S.invBags[bag] || {};
    for (const id of new Set([...Object.keys(base), ...Object.keys(row.items)])) {
      const d = (row.items[id] || 0) - (base[id] || 0);
      if (d) delta[id] = (delta[id] || 0) + d;
    }
  }
  const set = (obj, field, id) => {
    const baseKey = `${field}_base`;
    if (obj[baseKey] == null) obj[baseKey] = obj[field] || 0;
    const v = Math.max(0, obj[baseKey] + (delta[String(id)] || 0));
    if (v !== obj[field]) { obj[field] = v; L.dirty = true; }
    obj[`${field}_live`] = !!delta[String(id)];
  };
  for (const t of S.tasks) for (const i of t.items) set(i, 'inv_have', i.id);
  for (const list of Object.values(S.pool)) for (const t of list) for (const i of t.items) set(i, 'have', i.id);
  for (const q of S.quests) for (const n of q.needs) set(n, 'have', n.id);
  for (const q of S.activeQuests) for (const n of q.needs) set(n, 'have', n.id);
}

// Quests: drop the ones the relay says are finished, follow tracking, and reload when a quest has moved to a
// stage BitJita hasn't shown yet (its items come from BitJita) or one was started. changed = the relay just
// reported a quest change; otherwise a few spaced-out retries while BitJita catches up.
function liveApplyQuests(changed) {
  if (!L.ready || !S.tasksLoaded || !L.quests.size) return;
  const before = S.activeQuests.length;
  S.activeQuests = S.activeQuests.filter(q => !L.quests.get(String(q.id))?.completed);
  const done = before - S.activeQuests.length;
  let stale = 0;
  for (const q of S.activeQuests) {
    const row = L.quests.get(String(q.id));
    if (!row) continue;
    if (row.tracked !== q.tracked) { q.tracked = row.tracked; L.dirty = true; }
    const moved = !!q.stage_id && row.stage !== q.stage_id;
    if (moved !== !!q.stale) { q.stale = moved; L.dirty = true; }
    if (moved) stale++;
  }
  const known   = new Set(S.activeQuests.map(q => String(q.id)));
  const started = [...L.quests.values()].some(r => !r.completed && !known.has(r.key));
  if (done) {
    L.dirty = true;
    liveFlash(`${done} quest${done === 1 ? '' : 's'} completed`);
  }
  if (changed) L.questReloadTries = 0;
  if (stale || started) {
    if (changed) liveScheduleReload(LIVE_RELOAD_MS);
    else if (L.questReloadTries < LIVE_RETRY_MS.length) liveScheduleReload(LIVE_RETRY_MS[L.questReloadTries++]);
  }
}

// Trader Stands: where they are now, whether they're packed up, and what's in stock.
// stall.live is set once the relay has answered for that stand.
function liveApplyStands() {
  if (!S.stallsLoaded) return;
  const px = S.player?.locationX, pz = S.player?.locationZ;
  for (const s of S.stalls) {
    if (!s.stand) continue;
    const id = String(s.stallEntityId || '');
    if (s.distance_base === undefined) s.distance_base = s.distance;
    if (!L.ready || !L.liveStands.has(id)) {
      if (s.live) { s.live = false; s.distance = s.distance_base; L.dirty = true; }
      continue;
    }
    const pos   = L.positions.get(id);
    const stock = {};
    for (const row of L.bags.values()) {
      if (row.owner !== id) continue;
      for (const [iid, q] of Object.entries(row.items)) stock[iid] = (stock[iid] || 0) + q;
    }
    s.live     = true;
    s.deployed = !!pos;
    s.live_x   = pos?.x ?? null;
    s.live_z   = pos?.z ?? null;
    s.distance = pos && px != null && pz != null ? Math.round(Math.hypot(pos.x - px, pos.z - pz)) : s.distance_base;
    for (const it of s.items) it.stock_live = stock[String(it.id)] || 0;
    L.dirty = true;
  }
}

// A stand's trades changed: reload the stalls for their names and prices (debounced: with every
// stand in the region followed, trades change often)
function liveScheduleStallsReload() {
  clearTimeout(L.stallsTimer);
  L.stallsTimer = setTimeout(() => { if (S.player && L.key) loadStalls(true); }, LIVE_STALLS_RELOAD_MS);
}

function liveRenderSoon() {
  if (!L.dirty) return;
  clearTimeout(L.renderTimer);
  L.renderTimer = setTimeout(() => {
    if (!L.dirty) return;
    L.dirty = false;
    if (L.creditsDirty) {
      L.creditsDirty = false;
      const resets   = S.credits.map(c => c.next_reset).filter(Boolean);
      S.creditsReset = resets.length ? Math.min(...resets) : null;
      renderCredits();
      startResetCountdown();
    }
    renderStock();
    renderQuests();
    render();
  }, LIVE_RENDER_MS);
}

function liveScheduleReload(ms) {
  clearTimeout(L.reloadTimer);
  L.reloadTimer = setTimeout(async () => {
    if (!S.player || !L.key) return;
    if (L.reloading) { liveScheduleReload(ms); return; }
    L.reloading = true;
    try { await loadTasks(true); } finally { L.reloading = false; }
  }, ms);
}

function liveSetStatus(state, why = '') {
  if (!liveEl) return;
  const label = { live: 'Live', connecting: 'Connecting…', retrying: 'Reconnecting…', off: 'Offline' }[state];
  liveEl.className = `live-${state}`;
  liveEl.innerHTML = `<span class="live-dot"></span>${label}`;
  liveEl.title     = why || {
    live:       `Connected to the live relay (${RELAYS[L.relay % RELAYS.length].host}): tasks, task credits and the inventory in your region update as you play`,
    connecting: 'Connecting to BitJita’s live relay…',
    retrying:   'Lost the connection to BitJita’s live relay; retrying. Refresh still works.',
    off:        'Not connected to BitJita’s live relay. Refresh to update tasks.',
  }[state];
}

function liveFlash(msg) {
  setStatus(msg);
  setTimeout(() => { if (statusEl.textContent === msg) setStatus(''); }, 5000);
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

// The API is cached on Vercel's CDN for a minute or few; fresh adds a unique param so the request runs the function
async function apiFetch(url, fresh = false) {
  if (fresh) url += (url.includes('?') ? '&' : '?') + `_=${Date.now()}`;
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}
