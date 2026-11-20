"""
Stall planner: what to gather or craft and sell at your own market stall, and at what price.

Local tool, not deployed. Run from the repo root:

    python tools/stall_planner.py                      # Billard, Astra Nova members, Astra Nova + Emberfall
    python tools/stall_planner.py --margin 0.2 --active-days 3 --html

How it decides:
  - Demand: a week of your claim's members' traveler tasks (members who signed in within --active-days),
    estimated as the main app does: each member's task pool is every task in the tiers they've unlocked,
    and a simulated week hands in tasks as the board refills (4 tasks; a replacement shares no item with
    the other 3). Hand-ins a week are measured from task credits: members whose counter still shows last
    week used 50 minus what's left; everyone else gets the median of those, per traveler. Demand is gross,
    as what members hold covers a week at most. With --now: the tasks they hold right now, less what
    they already have in their inventories and banks.
  - Supply: what other players sell at the market claims (--markets) right now: market sell orders and
    Hex Coin stall trades at those claims, stall stock checked against what the stall holds.
  - An item is worth selling only where demand exceeds that supply (the shortfall).
  - Ranking: coins per hour. "Brings in" is every coin the trades put in your stall; "Hours" is the time
    to gather and craft what they need, from the chain calculator in your Bitcraft Effort project
    (--effort-dir) at your toolbelt's tool powers: node odds per health point, crafting actions, cargo
    processing and rare results like Briny Linus Scale from Briny Linus Products. Items it has no chain
    for (monster drops) are listed last, unranked.
  - Price: Trader Stand trades are bundles, so each trade is a task's whole quantity for a lump sum,
    e.g. "10 Muddy Guppi for 60" for Alesi's 65-coin task. The price is the task's reward less the buyer's
    cut (--profit coins or --margin of the reward, whichever is more) and less the rest of the task bought
    at the going price. Never below the bundle at the going price (the quantity-weighted median of the
    region's market sell orders, or BitJita's global median when the region has none). For an item nobody
    sells, the floor is what its ingredients are worth instead ("Parts/u": the cheapest recipe, each
    ingredient at the lower of its going price and its own ingredients' worth). Tasks wanting the
    same quantity share a trade, priced where it brings in the most; "×N" is how many trades a week to
    expect (with --now, how many to stock now).

Recipes and item details are cached in tools/.cache for a week (they hardly change); markets, stalls,
tasks and inventories are always read fresh.
"""

import argparse
import html
import json
import math
import os
import random
import statistics
import sys
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'api'))

import _relay                                                      # noqa: E402
from _lib import RateLimited, api_get, build_inv_map, get_skill_levels  # noqa: E402
from recommend import TRAVELERS, pages, read_tasks, task_pool, unlocked_tiers  # noqa: E402
from quest_prices import get_all_stalls, stall_offers, stall_stock  # noqa: E402

CACHE_DIR   = os.path.join(HERE, '.cache')
CACHE_TTL_S = 7 * 24 * 3600
HEX_COIN    = '1'
MAX_DEPTH   = 12   # recipe chains deeper than this are treated as loops


# ── Small helpers ─────────────────────────────────────────────────────────────

def cached(name, fetch, ttl=CACHE_TTL_S):
    """fetch() once per ttl, kept as JSON in tools/.cache."""
    path = os.path.join(CACHE_DIR, name + '.json')
    try:
        if time.time() - os.path.getmtime(path) < ttl:
            with open(path, encoding='utf-8') as f:
                return json.load(f)
    except OSError:
        pass
    value = fetch()
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(value, f)
    return value


def get(path, params=None, tries=4):
    """api_get, retried: waits out BitJita's rate limit (this tool makes a few hundred calls) and the odd failure."""
    for attempt in range(tries):
        try:
            return api_get(path, params)
        except RateLimited:
            time.sleep(15)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(1 + attempt)
    return api_get(path, params)


def soft(path):
    try:
        return get(path)
    except Exception:
        return None


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace('Z', '+00:00').replace(' ', 'T'))
    except ValueError:
        return None


# ── Catalog and recipes ───────────────────────────────────────────────────────

def catalog():
    """{(id, 'item'|'cargo'): {name, tier}}"""
    def fetch():
        items = get('/api/items')
        cargo = get('/api/cargo')
        items = items.get('items', items) if isinstance(items, dict) else items
        cargo = cargo.get('cargos', cargo) if isinstance(cargo, dict) else cargo
        return {'item':  {str(i['id']): {'name': i.get('name', ''), 'tier': i.get('tier')} for i in items},
                'cargo': {str(c['id']): {'name': c.get('name', ''), 'tier': c.get('tier')} for c in cargo}}
    raw = cached('catalog', fetch)
    return {(iid, typ): v for typ, m in raw.items() for iid, v in m.items()}


def item_detail(key):
    """Recipes and market stats for one item, cached. Only the fields we use are kept."""
    iid, typ = key

    def fetch():
        d = get(f"/api/{'cargo' if typ == 'cargo' else 'items'}/{iid}")   # raises rather than cache a failed read
        recipes = []
        for r in d.get('craftingRecipes') or []:
            if (r.get('name') or '').startswith('Unpack'):
                continue   # "Unpack ... Package" needs a package made from the item itself
            out = next((o.get('quantity') for o in r.get('craftedItemStacks') or []
                        if str(o.get('item_id')) == iid), None)
            if not out:
                continue
            recipes.append({
                'name':     r.get('name', ''),
                'building': r.get('buildingName', ''),
                'makes':    out,
                'inputs':   [[str(c.get('item_id')), 'cargo' if c.get('item_type') == 'cargo' else 'item', c.get('quantity') or 1]
                             for c in r.get('consumedItemStacks') or []],
            })
        gathered = any(str((s.get('item_stack') or {}).get('item_id')) == iid
                       for e in d.get('extractionRecipes') or [] for s in e.get('extractedItemStacks') or [])
        return {'recipes': recipes, 'gathered': gathered, 'median': (d.get('marketStats') or {}).get('medianSellPrice')}
    try:
        return cached(f'detail-{typ}-{iid}', fetch)
    except Exception:
        log(f'  warning: could not read recipes for {typ} {iid}; counted as gathered')
        return {'recipes': [], 'gathered': False, 'median': None, 'failed': True}


EFFORT_DIR = os.path.join(HERE, '..', '..', 'Bitcraft Effort')   # your Bitcraft Effort project


def _load_module(name, path):
    """Import a file under its own module name: both projects have an api/_lib.py."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod  = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Effort:
    """
    Time and stamina to produce items, from the Bitcraft Effort project's chain calculator: node extraction
    odds per health point and tool power, crafting actions, cargo processing and rare processing results
    (Briny Linus Scale from Briny Linus Products), all from its game data (data/recipes.json, game_data.json).
    """

    def __init__(self, project_dir, tools):
        api = os.path.join(project_dir, 'api')
        if not os.path.exists(os.path.join(api, '_effort_calc.py')):
            raise SystemExit(f'Bitcraft Effort project not found at {os.path.abspath(project_dir)}; pass --effort-dir')
        self.calc   = _load_module('effort_calc', os.path.join(api, '_effort_calc.py'))
        self.skills = _load_module('effort_lib', os.path.join(api, '_lib.py')).SKILL_NAMES
        # Its GitHub job refreshes the data every 6 hours; this copy is only as fresh as the last git pull
        age_days = (time.time() - os.path.getmtime(os.path.join(project_dir, 'data', 'recipes.json'))) / 86400
        if age_days > 2:
            log(f'  warning: the Bitcraft Effort recipe data is {age_days:.0f} days old; '
                f'run "git pull" in {os.path.abspath(project_dir)} for the latest')
        with open(os.path.join(project_dir, 'data', 'recipes.json'), encoding='utf-8') as f:
            self.recipes = json.load(f)
        with open(os.path.join(project_dir, 'data', 'game_data.json'), encoding='utf-8') as f:
            self.game = json.load(f)
        self.tools = tools

    def of(self, key, units):
        """{seconds, stamina, outside: [names it couldn't trace]} to produce `units` of the item.
        seconds is None when it has no chain at all (a monster drop, a cargo item)."""
        if key[1] != 'item' or units <= 0:
            return {'seconds': None, 'stamina': None, 'outside': []}
        acc   = self.calc.calculate_effort(key[0], units, self.recipes, self.game, self.tools, self.skills)
        prof  = acc.by_profession.values()
        secs  = sum(p['gathering_time'] + p['crafting_time'] for p in prof)
        stam  = sum(p['gathering_stamina'] + p['crafting_stamina'] for p in prof)
        out   = [v['name'] or k for k, v in acc.ingredient_costs.items()]
        return {'seconds': secs or None, 'stamina': stam, 'outside': out}


def toolbelt(player_id):
    """Your tools by tool type, {type: {level, power, name, tier}}, the way the Bitcraft Effort project reads them."""
    data, tools = soft(f'/api/players/{player_id}/inventories') or {}, {}
    lookup = data.get('items', {})
    for bag in data.get('inventories', []):
        if (bag.get('inventoryName') or '').lower() != 'toolbelt':
            continue
        for pocket in bag.get('pockets', []):
            c = pocket.get('contents')
            info = lookup.get(str(c['itemId']), {}) if c else {}
            tt, level = info.get('toolType'), info.get('toolLevel')
            if tt is None or level is None:
                continue
            if tt not in tools or level > tools[tt]['level']:
                tools[tt] = {'level': level, 'power': info.get('toolPower') or 0, 'name': info.get('name', ''),
                             'tier': info.get('tier')}
    return tools


class Difficulty:
    """Crafting steps from gathered materials, by the easiest recipe, for every item in a recipe tree."""

    def __init__(self, names):
        self.names, self.memo = names, {}

    def prefetch(self, keys):
        """Load every item in the recipe trees under these keys, a level at a time, in parallel."""
        seen, todo = set(), set(keys)
        while todo:
            with ThreadPoolExecutor(max_workers=8) as pool:
                details = dict(zip(todo, pool.map(item_detail, todo)))
            seen |= todo
            todo = {(i, t) for d in details.values() for r in d['recipes'] for i, t, _ in r['inputs']} - seen
            if todo:
                log(f'  recipes: {len(seen)} items read, {len(todo)} more ingredients to look up')
        return seen

    def parts_cost(self, key, going, path=()):
        """
        What one unit's ingredients are worth: the cheapest recipe, each ingredient at the lower of its going
        price and its own ingredients' worth. None when something in every recipe has no price at all.
        """
        memo = self.__dict__.setdefault('cost_memo', {})
        if key in memo:
            return memo[key]
        if key in path or len(path) > MAX_DEPTH:
            return None
        best = None
        for r in item_detail(key)['recipes']:
            total = 0
            for i, t, q in r['inputs']:
                worth = [v for v in (going.get((i, t)), self.parts_cost((i, t), going, path + (key,))) if v is not None]
                if not worth and item_detail((i, t))['median']:
                    worth = [item_detail((i, t))['median']]   # nothing better: BitJita's global median
                if not worth:
                    total = None
                    break
                total += min(worth) * q
            if total is not None and (best is None or total / r['makes'] < best):
                best = total / r['makes']
        memo[key] = best
        return best

    def steps(self, key, path=()):
        """(steps, recipe or None). Gathered and uncraftable items are 0 steps."""
        if key in self.memo:
            return self.memo[key]
        d = item_detail(key)
        if d['gathered'] or not d['recipes']:
            return self.memo.setdefault(key, (0, None))
        if key in path or len(path) > MAX_DEPTH:
            return math.inf, None   # a loop: this route doesn't bottom out
        best = (math.inf, None)
        for r in d['recipes']:
            n = 1 + sum(self.steps((i, t), path + (key,))[0] for i, t, _ in r['inputs'])
            if n < best[0]:
                best = (n, r)
        if best[0] == math.inf:
            if path:
                return best    # every route loops back: let the caller pick another recipe
            best = (0, None)   # only loops: treat like a raw material
        self.memo[key] = best
        return best

    def chain(self, key, depth=0):
        """The easiest recipe tree as text: "Basic Ink ← Basic Pigment ← ..."."""
        n, r = self.steps(key)
        if not r or depth > 3:
            return ''
        parts = []
        for i, t, q in r['inputs']:
            name = self.names.get((i, t), {}).get('name') or i
            sub  = self.chain((i, t), depth + 1)
            parts.append(f'{q}× {name}' + (f' [{sub}]' if sub else ''))
        return ', '.join(parts)


# ── Demand: members' tasks ────────────────────────────────────────────────────

def member_needs(member, names):
    """The member's tasks with what they still lack: [{member, reward, lacks: {key: units}, items: [key, qty]}]."""
    pid = member['playerEntityId']
    tasks_raw = soft(f'/api/players/{pid}/traveler-tasks')
    if not tasks_raw:
        return None
    inv  = build_inv_map(soft(f'/api/players/{pid}/inventories') or {})
    have = dict(inv)
    out  = []
    for t in sorted(read_tasks(tasks_raw), key=lambda t: -t['reward']):
        lacks, qty = {}, {}
        for i in t['items']:
            qty[i['key']] = qty.get(i['key'], 0) + i['qty']
            own = min(i['qty'], have.get(i['key'][0], 0))
            have[i['key'][0]] = have.get(i['key'][0], 0) - own
            if i['qty'] - own > 0:
                lacks[i['key']] = lacks.get(i['key'], 0) + i['qty'] - own
            names.setdefault(i['key'], {'name': i['name'], 'tier': None})
        if lacks:
            out.append({'member': member['userName'], 'traveler': t['traveler'], 'reward': t['reward'],
                        'lacks': lacks, 'qty': qty})
    return out


# ── Demand: a week of members' tasks ──────────────────────────────────────────
# The app's weekly stock estimate (app.js, "Weekly task stock"), per member: a traveler shows 4 tasks; a
# finished task is replaced by a random pool task that isn't the one just finished and shares no item with
# the other 3. Simulated many times to get how often each pool task is handed in a week.

TASK_SLOTS   = 4
WEEK_RUNS    = 150
TIERS_TTL_S  = 24 * 3600   # a member's quests and skill levels, which decide their task pool
REUSED_RESET = 24 * 3600   # a counter last reset this long before the latest reset still shows last week


def member_week(member):
    """A member's held tasks, credits and unlocked tiers: {member, held, credits: {traveler: (left, last_reset)},
    levels, quests}, or None if their tasks can't be read."""
    pid  = member['playerEntityId']
    raw  = soft(f'/api/players/{pid}/traveler-tasks')
    if not raw:
        return None

    def tiers():
        try:
            levels = get_skill_levels(member['userName'], pid)
        except Exception:
            levels = {}
        return {'levels': levels, 'quests': (soft(f'/api/players/{pid}/quests') or {}).get('quests', [])}
    t = cached(f'tiers-{pid}', tiers, TIERS_TTL_S)
    credits = {}
    for tid, c in (raw.get('taskCredits') or {}).items():
        name = TRAVELERS.get(int(tid)) if str(tid).isdigit() else None
        if name:
            credits[name] = (c.get('credits', 0), c.get('lastReset') or 0)
    return {'member': member['userName'], 'held': read_tasks(raw), 'credits': credits, **t,
            'weekly': max((w.get('weekly_task_credits') or 0 for w in raw.get('weeklyCredits') or []), default=50) or 50}


def weekly_handins(weeks):
    """
    {member: {traveler: hand-ins a week}}, measured: a member whose counter wasn't reset in the latest weekly
    reset still shows last week, so they used `weekly - left`. Everyone else gets the median of those, per
    traveler. Returns (handins, {traveler: (median, how many members it's measured from)}).
    """
    latest = max((last for w in weeks for _, last in w['credits'].values()), default=0)
    seen   = {}
    for w in weeks:
        for trav, (left, last) in w['credits'].items():
            if last and last < latest - REUSED_RESET:
                seen.setdefault(trav, []).append(max(0, w['weekly'] - left))
    medians = {trav: (statistics.median(v), len(v)) for trav, v in seen.items()}
    out = {}
    for w in weeks:
        per = {}
        for trav, (left, last) in w['credits'].items():
            if last and last < latest - REUSED_RESET:
                per[trav] = max(0, w['weekly'] - left)
            else:
                per[trav] = medians.get(trav, (0, 0))[0]
        out[w['member']] = per
    return out, medians


class WeekSim:
    """How often each pool task is handed in, for the first k hand-ins of a week, from simulated weeks.
    Cached per pool, as members in the same tiers share one."""

    def __init__(self):
        self.cache = {}

    def counts(self, pool, handins):
        """{task id: expected hand-ins} for `handins` hand-ins a week from this pool (a list of read_tasks tasks)."""
        handins = int(round(handins))
        if handins <= 0 or not pool:
            return {}
        key = tuple(sorted(str(t['id']) for t in pool))
        if key not in self.cache:
            self.cache[key] = self._simulate(pool)
        runs = self.cache[key]
        out  = {}
        for seq in runs:
            for tid in seq[:handins]:
                out[tid] = out.get(tid, 0) + 1
        return {tid: n / len(runs) for tid, n in out.items()}

    @staticmethod
    def _simulate(pool, max_handins=60):
        rand  = random.Random(len(pool) * 7919)
        items = {id(t): frozenset(i['key'] for i in t['items']) for t in pool}

        def replacements(board, done):
            used = frozenset().union(*(items[id(t)] for t in board)) if board else frozenset()
            free = [t for t in pool if t is not done and t not in board]
            best = [t for t in free if not (items[id(t)] & used)]
            return best or free

        runs = []
        for _ in range(WEEK_RUNS):
            board = []
            while len(board) < TASK_SLOTS:
                opts = replacements(board, None)
                if not opts:
                    break
                board.append(rand.choice(opts))
            seq = []
            for _ in range(max_handins):
                if not board:
                    break
                task = board.pop(rand.randrange(len(board)))
                seq.append(str(task['id']))
                opts = replacements(board, task)
                if opts:
                    board.append(rand.choice(opts))
            runs.append(seq)
        return runs


def weekly_tasks(weeks, catalog_tasks, quests, item_names):
    """A week of each member's tasks as [{member, traveler, reward, qty, lacks, weight}], weight = expected
    hand-ins a week. lacks is the whole task: what members hold covers a week at most, so demand is gross."""
    handins, medians = weekly_handins(weeks)
    sim, out = WeekSim(), []
    for w in weeks:
        gated, unlocked = unlocked_tiers(quests, w['quests'], item_names)
        pool = task_pool(catalog_tasks, w['held'], gated, unlocked, w['levels'])
        by_trav = {}
        for t in pool:
            by_trav.setdefault(t['traveler'], []).append(t)
        for trav, tasks in by_trav.items():
            byid = {str(t['id']): t for t in tasks}
            for tid, weight in sim.counts(tasks, handins[w['member']].get(trav, 0)).items():
                t   = byid[tid]
                qty = {}
                for i in t['items']:
                    qty[i['key']] = qty.get(i['key'], 0) + i['qty']
                out.append({'member': w['member'], 'traveler': trav, 'reward': t['reward'], 'qty': qty,
                            'lacks': dict(qty), 'weight': weight})
    return out, handins, medians


# ── Supply and prices ─────────────────────────────────────────────────────────

def weighted_median(orders):
    """Quantity-weighted median price of [(price, units)]."""
    orders = sorted((p, u) for p, u in orders if p and u and p > 0 and u > 0)
    total  = sum(u for _, u in orders)
    if not total:
        return None
    run = 0
    for p, u in orders:
        run += u
        if run * 2 >= total:
            return p


def market_supply(region, market_ids, me_id, keys):
    """({key: units sold by others at the market claims}, {key: going price in the region},
    {key: [(price, units)] of my own orders at the market claims})."""
    found, failed = _relay.markets([region])
    if failed:
        raise SystemExit(f'Could not read the market for region {region} from the relay')
    orders, _claims = found[region]
    supply, going, mine = {}, {}, {}
    for key in keys:
        others = []
        for o in orders.get(key, []):
            price, units = o.get('priceThreshold') or 0, o.get('quantity') or 0
            if o['ownerEntityId'] == me_id:
                if o['claimEntityId'] in market_ids:
                    mine.setdefault(key, []).append((price, units))
                continue
            others.append((price, units))
            if o['claimEntityId'] in market_ids:
                supply[key] = supply.get(key, 0) + units
        going[key] = weighted_median(others)
    return supply, going, mine


def stall_supply(market_names, region, me, keys, market_ids_by_name):
    """{key: units} other players' Hex Coin stalls at the market claims hold, checked against the stall's contents."""
    stalls, missed = get_all_stalls()
    if missed:
        log(f'  warning: {missed} page(s) of stalls failed to load, stall supply may be low')
    here   = [s for s in stalls if s.get('claimName') in market_names and str(s.get('regionId')) == str(region)]
    offers = stall_offers(here, set(keys), me.lower())
    cids   = {market_ids_by_name[o['stall']['claimName']] for o in offers}
    owners = {str(o['stall'].get('ownerEntityId')) for o in offers if o['stall'].get('nickname')} - {'None', ''}
    with ThreadPoolExecutor(max_workers=8) as pool:
        claim_inv = dict(zip(cids, pool.map(lambda c: soft(f'/api/claims/{c}/inventories'), cids)))
        owner_inv = dict(zip(owners, pool.map(lambda e: soft(f'/api/players/{e}/inventories'), owners)))
    supply, prices = {}, {}
    for o in offers:
        st     = o['stall']
        listed = None if o['trades'] is None else o['trades'] * o['bundle']
        held   = stall_stock(o, claim_inv.get(market_ids_by_name[st['claimName']]),
                             owner_inv.get(str(st.get('ownerEntityId'))))
        units  = min(u for u in (listed, held) if u is not None) if (listed, held) != (None, None) else 0
        if units > 0:
            supply[o['key']] = supply.get(o['key'], 0) + units
            prices.setdefault(o['key'], []).append((o['price'] / o['bundle'], units))
    return supply, prices


# ── Pricing ───────────────────────────────────────────────────────────────────

def buyer_cut(reward, profit, margin):
    """Coins a buyer should keep from a task: `profit` coins or `margin` of the reward, whichever is more."""
    return max(profit, round(reward * margin))


def round_price(ceiling, floor):
    """
    A stall price ending in 0: the ceiling rounded down to a multiple of 10, so the buyer keeps a little more.
    When that would drop below the floor (or to 0), the ceiling itself, as no round price fits between them.
    """
    price = ceiling // 10 * 10
    return price if price >= floor and price > 0 else ceiling


def price_item(key, tasks, going, profit, margin, shortfall):
    """
    Trader Stand trades for `key`: each one is a task's whole quantity (a bundle) for a price in Hex Coin.
    A task's ceiling for the bundle is its reward, less the buyer's cut, less the rest of the task bought at
    the going price. The floor is the bundle at the going price. Tasks asking for the same quantity share a
    trade, priced where it brings in the most, rounded down to end in 0 where that stays above the floor.
    Returns ([{bundle, price, trades, revenue, buyers}], best ceiling seen, its bundle) — trades empty when no
    task's ceiling reaches the floor.
    """
    unit_going = going.get(key) or 0
    by_bundle  = {}   # bundle size -> [(ceiling, member, expected hand-ins)]
    for t in tasks:
        bundle = t['qty'][key]
        other  = sum(math.ceil(n * (going.get(k) or 0)) for k, n in t['lacks'].items() if k != key)
        ceil_  = t['reward'] - buyer_cut(t['reward'], profit, margin) - other
        by_bundle.setdefault(bundle, []).append((ceil_, t['member'], t.get('weight', 1)))
    trades, top = [], (None, None)
    left = shortfall
    # Biggest bundles first: one trade covers a whole task
    for bundle, asks in sorted(by_bundle.items(), key=lambda b: -b[0]):
        floor = max(1, math.ceil(bundle * unit_going))
        for c, _, _ in asks:
            if top[0] is None or c / bundle > top[0] / top[1]:
                top = (c, bundle)
        best = None
        for ceiling, _, _ in asks:
            if ceiling < floor:
                continue
            price = round_price(ceiling, floor)
            n = min(math.floor(sum(w for c, _, w in asks if c >= price) + 0.5), math.ceil(left / bundle))
            if n > 0 and (not best or n * price > best['revenue']):
                best = {'bundle': bundle, 'price': price, 'trades': n, 'revenue': n * price,
                        'buyers': sorted({m for c, m, _ in asks if c >= price})}
        if best and left > 0:
            trades.append(best)
            left -= best['trades'] * bundle
    return trades, top


# ── Report ────────────────────────────────────────────────────────────────────

def fmt(n):
    if n is None:
        return '—'
    return f'{n:,.1f}'.rstrip('0').rstrip('.') if isinstance(n, float) else f'{n:,}'


def time_text(hours):
    """'45 min' or '7.5 h'."""
    if hours is None:
        return '—'
    return f'{hours * 60:.0f} min' if hours < 1 else f'{hours:,.1f} h'


def trades_text(r):
    """'10 for 60 ×4, 5 for 28 ×1': each Trader Stand trade to set up, and how many times to stock it."""
    return ', '.join(f"{t['bundle']:,} for {t['price']:,} ×{t['trades']}" for t in r['trades'])


def best_text(r):
    c, bundle = r['best']
    return '—' if c is None else f'{bundle:,} for {c:,}'


def print_table(rows, skipped):
    head = ['#', 'Item', 'Coins/hr', 'Brings in', 'Time', 'Trades (qty for coins ×stock)', 'Short', 'Going/u',
            'Parts/u', 'Buyers']
    data = [[str(n), r['name'][:32], fmt(r['rate'] and round(r['rate'])), fmt(r['revenue']),
             time_text(r['hours']), trades_text(r)[:44], fmt(r['shortfall']), fmt(r['going']),
             fmt(r['parts'] and round(r['parts'], 1)), ', '.join(r['buyers'])[:40]] for n, r in enumerate(rows, 1)]
    widths = [max(len(h), *(len(d[i]) for d in data)) if data else len(h) for i, h in enumerate(head)]
    line = lambda cells: '  '.join(c.ljust(w) if i in (1, 5, 9) else c.rjust(w) for i, (c, w) in enumerate(zip(cells, widths)))
    print(line(head))
    print('  '.join('-' * w for w in widths))
    for d in data:
        print(line(d))
    unknown = [r['name'] for r in rows if r['rate'] is None]
    if unknown:
        print(f'\nNo production chain in the effort data, so ranked last ({len(unknown)}): ' + ', '.join(unknown))
    if skipped:
        print(f'\nShort nearby, but no member profits at the going price or what its parts are worth ({len(skipped)}): '
              + ', '.join(f"{r['name']} (going {fmt(r['going'])}/u, best a buyer could pay {best_text(r)})" for r in skipped[:15]))


def sub_text(r):
    """The line under an item's name: its recipe tree, and what the effort data couldn't trace."""
    if r['hours'] is None:
        return 'No production chain in the effort data (a monster drop?), so ranked last'
    text = r['chain'] or 'gathered'
    if r['outside']:
        text += ' · not counted: ' + ', '.join(r['outside'])
    return text


def write_html(path, rows, skipped, meta):
    def cell(v, cls=''):
        return f'<td class="{cls}">{html.escape(str(v))}</td>'
    body = []
    for n, r in enumerate(rows, 1):
        mine = ', '.join(f'{u:,} @ {p:,}' for p, u in r['mine']) if r['mine'] else ''
        body.append('<tr>' + cell(n, 'num') +
                    f'<td><b>{html.escape(r["name"])}</b><div class="sub">{html.escape(sub_text(r))}</div></td>' +
                    cell(fmt(r['rate'] and round(r['rate'])), 'num price') + cell(fmt(r['revenue']), 'num') +
                    cell(time_text(r['hours']), 'num') + cell(fmt(r['stamina'] and round(r['stamina'])), 'num') +
                    cell(trades_text(r), 'price') + cell(fmt(r['units']), 'num') +
                    cell(fmt(r['demand']), 'num') + cell(fmt(r['supply']), 'num') + cell(fmt(r['shortfall']), 'num') +
                    cell(fmt(r['going']), 'num') + cell(fmt(r['parts'] and round(r['parts'], 1)), 'num') +
                    cell(fmt(r['tier']), 'num') +
                    cell(', '.join(r['buyers'])) + cell(mine) + '</tr>')
    skipped_html = ''.join(
        f'<li>{html.escape(r["name"])}: short {fmt(r["shortfall"])}, going {fmt(r["going"])} each, '
        f'best a member could pay {best_text(r)}</li>' for r in skipped)
    page = f"""<!doctype html><html><head><meta charset="utf-8"><title>Stall planner</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {{ --bg:#fbfaf7; --fg:#1f1d1a; --mute:#6f6a62; --line:#e4e0d8; --accent:#9a5b13; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#191816; --fg:#ece8e1; --mute:#9d978d; --line:#33302b; --accent:#e0a458; }} }}
body {{ background:var(--bg); color:var(--fg); font:14px/1.45 system-ui, sans-serif; margin:0; padding:24px 16px; }}
h1 {{ font-size:20px; margin:0 0 4px; }} p.meta {{ color:var(--mute); margin:0 0 20px; }}
.wrap {{ overflow-x:auto; }} table {{ border-collapse:collapse; width:100%; }}
th, td {{ padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; text-align:left; }}
th {{ font-size:12px; color:var(--mute); font-weight:600; white-space:nowrap; position:sticky; top:0; background:var(--bg); }}
td.num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
td.price {{ color:var(--accent); font-weight:700; }} .sub {{ color:var(--mute); font-size:12px; max-width:420px; }}
h2 {{ font-size:15px; margin:28px 0 8px; }} li {{ color:var(--mute); }}
</style></head><body>
<h1>Stall planner</h1>
<p class="meta">{html.escape(meta)}</p>
<div class="wrap"><table><thead><tr><th>#</th><th>Item</th><th>Coins per hour</th><th>Brings in</th><th>Time</th><th>Stamina</th>
<th>Trades to set up (qty for coins ×stock)</th><th>Units</th><th>Members need</th><th>Sold nearby</th><th>Short</th>
<th>Going price (each)</th><th>Parts worth (each)</th><th>Tier</th><th>Buyers</th><th>You list now</th></tr></thead>
<tbody>{''.join(body)}</tbody></table></div>
{f'<h2>Short nearby, but no member profits at the going price or what its parts are worth</h2><ul>{skipped_html}</ul>' if skipped else ''}
</body></html>"""
    with open(path, 'w', encoding='utf-8') as f:
        f.write(page)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--me', default='Billard', help='your username (default Billard)')
    ap.add_argument('--claim', help="the claim whose members you sell to (default: your first claim)")
    ap.add_argument('--markets', default='Astra Nova,Emberfall', help='market claims to check, comma-separated')
    ap.add_argument('--profit', type=int, default=5, help='coins a buyer keeps from each task, at least (default 5)')
    ap.add_argument('--margin', type=float, default=0.08,
                    help="share of a task's reward the buyer keeps, when that's more than --profit (default 0.08)")
    ap.add_argument('--active-days', type=float, default=7, help='only members signed in within this many days (default 7)')
    ap.add_argument('--now', action='store_true',
                    help="price for the tasks members hold right now instead of an estimated week of tasks")
    ap.add_argument('--min-steps', type=int, default=0, help='leave out items easier than this many crafting steps')
    ap.add_argument('--effort-dir', default=EFFORT_DIR,
                    help='your Bitcraft Effort project, whose chain calculator times each item (default: next to this repo)')
    ap.add_argument('--html', nargs='?', const=os.path.join(HERE, 'stall_plan.html'),
                    help='also write an HTML report (default tools/stall_plan.html) and open it')
    args = ap.parse_args()

    # Who and where
    log('Reading your profile...')
    found = get('/api/players', {'q': args.me, 'limit': 5}).get('players', [])
    me = next((p for p in found if p.get('username', '').lower() == args.me.lower()), None)
    if not me:
        raise SystemExit(f'No player named {args.me}')
    me_id   = str(me['entityId'])
    profile = get(f'/api/players/{me_id}').get('player', {})
    claims  = profile.get('claims') or []
    claim   = next((c for c in claims if not args.claim or c['name'].lower() == args.claim.lower()), None)
    if not claim:
        raise SystemExit(f"{args.me} isn't a member of {args.claim or 'any claim'}")
    region = int(claim['regionId'])

    market_names = [m.strip() for m in args.markets.split(',') if m.strip()]
    _, region_claims = _relay.region_market(region)
    market_ids_by_name = {}
    for name in market_names:
        cid = next((c['id'] for c in region_claims.values() if c['name'].lower() == name.lower()), None)
        if not cid:
            raise SystemExit(f'No claim named {name} in region {region}')
        market_ids_by_name[region_claims[cid]['name']] = cid
    market_names = list(market_ids_by_name)
    market_ids   = set(market_ids_by_name.values())

    # Demand
    members = get(f"/api/claims/{claim['entityId']}/members").get('members', [])
    since   = datetime.now(timezone.utc) - timedelta(days=args.active_days)
    active  = [m for m in members if m['playerEntityId'] != me_id
               and (parse_ts(m.get('lastLoginTimestamp')) or datetime.min.replace(tzinfo=timezone.utc)) >= since]
    names = catalog()
    if args.now:
        log(f"Reading tasks and inventories of {len(active)} of {len(members)} {claim['name']} members "
            f"(signed in within {args.active_days:g} days)...")
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda m: member_needs(m, names), active))
        failed = sum(1 for r in results if r is None)
        tasks  = [t for r in results if r for t in r]
        basis  = f'{len(tasks)} open tasks'
    else:
        log(f"Reading tasks, credits and unlocked tiers of {len(active)} of {len(members)} {claim['name']} members "
            f"(signed in within {args.active_days:g} days; tiers are cached for a day)...")
        with ThreadPoolExecutor(max_workers=4) as pool:
            cat_f   = pool.submit(pages, '/api/traveler-tasks', 'tasks')
            quest_f = pool.submit(pages, '/api/quests', 'quests')
            weeks   = list(ThreadPoolExecutor(max_workers=8).map(member_week, active))
            rows_, first = cat_f.result()
            quests, _    = quest_f.result()
        failed = sum(1 for w in weeks if w is None)
        for w in weeks:
            for t in (w or {}).get('held', []):
                for i in t['items']:
                    names.setdefault(i['key'], {'name': i['name'], 'tier': None})
        log('Simulating a week of tasks per member...')
        item_names = {k[0]: v['name'] for k, v in names.items() if k[1] == 'item'}
        tasks, handins, medians = weekly_tasks([w for w in weeks if w], read_tasks({**first, 'tasks': rows_}),
                                               quests, item_names)
        per_week = sum(sum(v.values()) for v in handins.values())
        log('  hand-ins a week, median of members whose counter shows last week: ' +
            ', '.join(f'{t} {m:g} ({n} measured)' for t, (m, n) in sorted(medians.items())))
        basis = f'about {per_week:,.0f} task hand-ins a week'
    if failed:
        log(f'  warning: could not read {failed} member(s)')
    need = {}
    for t in tasks:
        for k, n in t['lacks'].items():
            need[k] = need.get(k, 0) + n * t.get('weight', 1)
    need = {k: math.ceil(n) for k, n in need.items() if n >= 0.5}
    need.pop((HEX_COIN, 'item'), None)
    log(f'  {basis} need {len(need)} different items')

    # Supply
    log(f"Reading markets and stalls at {', '.join(market_names)}...")
    supply, going, mine = market_supply(region, market_ids, me_id, need)
    stalls, stall_prices = stall_supply(market_names, region, args.me, need, market_ids_by_name)
    for k, n in stalls.items():
        supply[k] = supply.get(k, 0) + n

    short = {k: n - supply.get(k, 0) for k, n in need.items() if n > supply.get(k, 0)}
    log(f'  {len(short)} items are short at those markets')

    # Difficulty
    log('Working out recipe trees...')
    diff = Difficulty(names)
    tree = diff.prefetch(short)
    _, tree_going, _ = market_supply(region, market_ids, me_id, tree - set(going))   # ingredients' going prices
    going.update(tree_going)
    # Items you'd sell fall back to BitJita's global median; ingredients don't, as their own parts are a
    # better guide than a median from other regions (Rough Tanned Pelt: global 10, its parts about 31)
    for k in short:
        if going.get(k) is None:
            going[k] = item_detail(k)['median'] or weighted_median(stall_prices.get(k, []))

    # What a unit is worth: its going price, or for an item nobody sells, what its ingredients are worth
    value = dict(going)
    for k in tree:
        if value.get(k) is None:
            value[k] = diff.parts_cost(k, going)

    tools  = toolbelt(me_id)
    effort = Effort(args.effort_dir, tools)
    log(f"Timing each item with the Bitcraft Effort chain calculator ({len(tools)} tools on your toolbelt)...")

    rows, skipped = [], []
    for k, gap in short.items():
        info  = names.get(k, {})
        steps = diff.steps(k)[0]
        if steps < args.min_steps:
            continue
        trades, top = price_item(k, [t for t in tasks if k in t['lacks']], value, args.profit, args.margin, gap)
        row = {'name': info.get('name') or k[0], 'tier': info.get('tier'), 'steps': steps, 'chain': diff.chain(k),
               'demand': need[k], 'supply': supply.get(k, 0), 'shortfall': gap, 'going': going.get(k),
               'parts': diff.parts_cost(k, going),
               'mine': mine.get(k, [])}
        if trades:
            units   = sum(t['bundle'] * t['trades'] for t in trades)
            revenue = sum(t['revenue'] for t in trades)
            e       = effort.of(k, units)
            hours   = e['seconds'] / 3600 if e['seconds'] else None
            rows.append({**row, 'trades': trades, 'units': units, 'revenue': revenue, 'hours': hours,
                         'stamina': e['stamina'], 'outside': e['outside'], 'rate': revenue / hours if hours else None,
                         'buyers': sorted({m for t in trades for m in t['buyers']})})
        else:
            skipped.append({**row, 'best': top})
    # Coins that land in the stall per hour it takes to stock it; items the effort data can't time go last
    rows.sort(key=lambda r: (r['rate'] is None, -(r['rate'] or 0), -r['revenue']))
    skipped.sort(key=lambda r: -r['shortfall'])

    meta = (f"{len(active)} active {claim['name']} members, {basis} · "
            f"{'stock for the tasks held now' if args.now else 'trades and coins are per week'} · supply at "
            f"{' + '.join(market_names)} · buyer keeps {args.profit} coins or {args.margin:.0%} of the reward · "
            f"timed at your toolbelt's powers · "
            f"{datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f'\n{meta}\n')
    print_table(rows, skipped)
    if args.html:
        write_html(args.html, rows, skipped, meta)
        log(f'\nWrote {args.html}')
        webbrowser.open('file:///' + os.path.abspath(args.html).replace('\\', '/'))


if __name__ == '__main__':
    main()
