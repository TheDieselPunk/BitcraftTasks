"""
GET /api/tasks?player_id=X&claim_id=Y

Returns all incomplete traveler tasks for a player, enriched with:
- Item names (from /api/items + /api/cargo catalogs)
- Player inventory counts per item
- Crafting status per item (yes/partial/no/none)
- Market price at the given claim (lowestSell from /api/market/item/{id})
- Skill level requirement per task
Plus per-traveler weekly task credits, the reroll cost, and the quests that unlock more task tiers.
Optional: username=Name (needed to check quest level requirements).
"""

import json
import math
import sys
import os
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))
import urllib.parse
from _lib import api_get, build_inv_map, build_inv_detail_map, build_name_maps, get_craft_info, get_market_price, get_market_prices_for_claims, get_player_housing_items, cors_headers


TRAVELERS = {
    1: 'Rumbagh',
    2: 'Svim',
    3: 'Heimlich',
    5: 'Brico',
    6: 'Alesi',
    7: 'Ramparte',
}

# weeklyCredits names some travelers by role instead of by name
TRAVELER_TYPE = {'Alesi': 'Tamer', 'Ramparte': 'Slayer'}

SKILL_NAMES = {
    13: 'Cooking',
    15: 'Construction',
    17: 'Taming',
    18: 'Slayer',
    19: 'Merchanting',
    21: 'Sailing',
}

CREDIT_PERIOD = 7 * 24 * 3600   # task credits refill weekly (Thursdays ~14:46 UTC)

# Keyword in an "Unlock ... Tasks" reward name → the traveler whose tasks it unlocks
UNLOCK_TRAVELER = {
    'Construction': 'Brico',
    'Cooking':      'Heimlich',
    'Merchanting':  'Rumbagh',
    'Rumbagh':      'Rumbagh',
    'Sailor':       'Svim',
    'Tamer':        'Alesi',
    'Slayer':       'Ramparte',
}
QUEST_STATUS_ORDER = {'in_progress': 0, 'ready': 1, 'locked': 2}


def get_quest_catalog():
    first  = api_get('/api/quests', {'limit': 100, 'page': 1})
    quests = list(first.get('quests', []))
    for page in range(2, (first.get('totalPages') or 1) + 1):
        quests += api_get('/api/quests', {'limit': 100, 'page': page}).get('quests', [])
    return quests


def get_skill_levels(username, player_id):
    """{skill_id_str: level} from the skills leaderboard (the player profile only has XP)."""
    data = api_get('/api/leaderboard/skills', {'search': username})
    me   = next((p for p in data.get('players', []) if str(p.get('entityId')) == str(player_id)), None)
    return (me or {}).get('skills', {})


def build_quests(catalog, player_quests, levels, inv_map, items_map, cargo_map):
    """
    Quests that unlock more traveler tasks: ones in progress, ones ready to start, and for travelers
    with neither, the next locked one.
    Returns [{name, traveler, unlocks, status, needs: [{id, type, name, qty, have}], requires: [str]}].
    """
    by_id     = {q.get('id'): q for q in catalog}
    mine      = {q.get('questChainDescId'): q for q in player_quests}
    completed = {qid for qid, q in mine.items() if q.get('completed')}

    def item_name(c):
        iid = str(c.get('item_id', ''))
        if str(c.get('item_type', '')).lower() == 'cargo':
            return cargo_map.get(iid) or iid
        return items_map.get(iid) or iid

    def needs(conds):
        return [{'id': str(c.get('item_id')), 'type': 'cargo' if str(c.get('item_type', '')).lower() == 'cargo' else 'item',
                 'name': item_name(c), 'qty': c.get('quantity', 1), 'have': inv_map.get(str(c.get('item_id')), 0)}
                for c in conds if c.get('type') == 'ItemStack']

    found = []
    for q in catalog:
        if q.get('id') in completed or q.get('unstartable'):
            continue
        unlocks = [n for n in (item_name(r) for r in q.get('rewards', []) if r.get('type') == 'ItemStack')
                   if n.startswith('Unlock ') and n.endswith(' Tasks')]
        if not unlocks:
            continue
        label    = unlocks[0][len('Unlock '):]
        traveler = next((t for k, t in UNLOCK_TRAVELER.items() if k in label), '?')
        started  = mine.get(q.get('id'))
        requires = []
        if not started:
            for r in q.get('requirements', []):
                if r.get('type') == 'Level' and int(levels.get(str(r.get('skill_id')), 0)) < r.get('level', 0):
                    requires.append(f"{SKILL_NAMES.get(r.get('skill_id'), 'Skill')} {r.get('level')}")
                elif r.get('type') == 'QuestChain' and r.get('value') not in completed:
                    prev = by_id.get(r.get('value'))
                    requires.append(prev['name'] if prev else 'an earlier quest')
        if started:
            status, conds = 'in_progress', started.get('currentStageConditions') or []
        else:
            status = 'locked' if requires else 'ready'
            conds  = [c for s in q.get('stageDetails', []) for c in s.get('completionConditions', [])]
        found.append({
            'name':     q.get('name', ''),
            'traveler': traveler,
            'unlocks':  label,
            'status':   status,
            'needs':    needs(conds),
            'requires': requires,
            '_level':   max((r.get('level', 0) for r in q.get('requirements', []) if r.get('type') == 'Level'), default=0),
        })

    active = {f['traveler'] for f in found if f['status'] != 'locked'}
    shown  = [f for f in found if f['status'] != 'locked']
    for trav in sorted({f['traveler'] for f in found} - active):
        shown.append(min((f for f in found if f['traveler'] == trav), key=lambda f: f['_level']))
    shown.sort(key=lambda f: (QUEST_STATUS_ORDER[f['status']], f['traveler'], f['_level']))
    for f in shown:
        del f['_level']
    return shown


def build_credits(tasks_data):
    """
    Per-traveler task credits from the traveler-tasks response.
    Returns [{traveler, credits, weekly, next_reset}] sorted by traveler name.
    The reset is global, but lastReset only advances when the player is active,
    so the next reset is the first weekly step from lastReset that is still ahead.
    """
    weekly = {w.get('traveler_type'): w.get('weekly_task_credits') for w in tasks_data.get('weeklyCredits') or []}
    now = time.time()
    credits = []
    for tid, c in (tasks_data.get('taskCredits') or {}).items():
        name   = (TRAVELERS.get(int(tid)) if str(tid).isdigit() else None) or str(tid)
        last   = c.get('lastReset')
        cap    = weekly.get(TRAVELER_TYPE.get(name, name))
        amount = c.get('credits', 0)
        next_reset = None
        if last:
            periods    = max(1, math.ceil((now - last) / CREDIT_PERIOD))
            next_reset = last + periods * CREDIT_PERIOD
            if periods > 1 and cap is not None:
                amount = cap   # a reset has passed since lastReset, so credits are full again
        credits.append({
            'traveler':   name,
            'credits':    amount,
            'weekly':     cap,
            'next_reset': next_reset,
        })
    credits.sort(key=lambda c: c['traveler'])
    return credits


def build_tasks(tasks_data, inv_map, inv_detail, items_map, cargo_map):
    tasks = []
    for task in tasks_data.get('tasks', []):
        if task.get('completed'):
            continue

        traveler_id = task.get('travelerId')
        traveler    = TRAVELERS.get(traveler_id) or (task.get('description') or '').split(' ')[0] or '?'
        reward   = next(
            (r.get('quantity', 0) for r in task.get('rewardedItems', []) if r.get('item_id') == 1),
            0
        )

        items = []
        for req in task.get('requiredItems', []):
            is_cargo = req.get('item_type') == 'cargo'
            catalog  = tasks_data.get('cargo' if is_cargo else 'items', {})
            info     = catalog.get(req['item_id']) or catalog.get(str(req['item_id'])) or {}
            id_str   = str(req['item_id'])
            name     = info.get('name') or (cargo_map if is_cargo else items_map).get(id_str) or id_str
            qty      = req.get('quantity', 1)
            have     = inv_map.get(id_str, 0)

            items.append({
                'id':           id_str,
                'name':         name,
                'type':         req.get('item_type', 'item'),
                'qty':          qty,
                'inv_have':     have,
                'inv_locations': inv_detail.get(id_str, []),
            })

        if not items:
            continue

        exp      = task.get('rewardedExperience') or {}
        level    = task.get('levelRequirement') or {}
        skill_id = level.get('skill_id') or exp.get('skill_id')
        tasks.append({
            'traveler':    traveler,
            'traveler_id': traveler_id,
            'description': task.get('description', ''),
            'reward':      reward,
            'exp_qty':     exp.get('quantity', 0),
            'exp_skill_id': str(exp.get('skill_id', '')),
            'skill_name':  SKILL_NAMES.get(skill_id, traveler),
            'min_level':   level.get('min_level'),
            'max_level':   level.get('max_level'),
            'items':       items,
        })

    return tasks


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params    = parse_qs(urlparse(self.path).query)
        player_id = params.get('player_id', [''])[0].strip()
        claim_id  = params.get('claim_id',  [''])[0].strip() or None
        username  = params.get('username',  [''])[0].strip()

        # market_claims: comma-separated "claimId:claimName" pairs (URL-encoded per pair)
        # When provided, replaces single claim_id for market price lookups
        market_claims_raw = params.get('market_claims', [''])[0]
        market_claims = {}  # {claim_id: claim_name}
        if market_claims_raw:
            for encoded_part in market_claims_raw.split(','):
                part = urllib.parse.unquote(encoded_part).strip()
                if ':' in part:
                    cid, cname = part.split(':', 1)
                    market_claims[cid.strip()] = cname.strip()
        # Fall back to single claim_id with empty name
        if not market_claims and claim_id:
            market_claims = {claim_id: ''}

        if not player_id:
            self._send(400, {'error': 'player_id parameter is required'})
            return

        try:
            # Fetch all data in parallel
            results = {}
            warnings = []
            _warn_names = {
                'tasks':   'traveler tasks',
                'inv':     'player inventory',
                'items':   'item catalog',
                'cargo':   'cargo catalog',
                'housing': 'housing storage',
                'quests':  'quest list',
                'my_quests': 'player quests',
                'levels':  'skill levels',
            }
            with ThreadPoolExecutor(max_workers=9) as pool:
                futures = {
                    pool.submit(api_get, f'/api/players/{player_id}/traveler-tasks'): 'tasks',
                    pool.submit(api_get, f'/api/players/{player_id}/inventories'):    'inv',
                    pool.submit(api_get, '/api/items'):                               'items',
                    pool.submit(api_get, '/api/cargo'):                               'cargo',
                    pool.submit(get_player_housing_items, player_id):                 'housing',
                    pool.submit(get_quest_catalog):                                   'quests',
                    pool.submit(api_get, f'/api/players/{player_id}/quests'):         'my_quests',
                }
                if username:
                    futures[pool.submit(get_skill_levels, username, player_id)] = 'levels'
                for f in as_completed(futures):
                    key = futures[f]
                    try:
                        results[key] = f.result()
                    except Exception:
                        results[key] = {} if key in ('tasks', 'inv', 'my_quests', 'levels') else []
                        warnings.append(f'Could not load {_warn_names.get(key, key)} from BitJita')

            tasks_data   = results.get('tasks', {})
            inv_data     = results.get('inv', {})
            items_raw    = results.get('items', {})
            cargo_raw    = results.get('cargo', {})
            housing_items = results.get('housing', []) or []
            items_data = items_raw.get('items',  items_raw) if isinstance(items_raw, dict) else items_raw
            cargo_data = cargo_raw.get('cargos', cargo_raw) if isinstance(cargo_raw, dict) else cargo_raw

            inv_map              = build_inv_map(inv_data)
            inv_detail           = build_inv_detail_map(inv_data)
            items_map, cargo_map = build_name_maps(items_data, cargo_data)

            # Merge housing storage into inv_map and inv_detail
            for storage in housing_items:
                for iid, qty in storage['items'].items():
                    inv_map[iid] = inv_map.get(iid, 0) + qty
                    inv_detail.setdefault(iid, []).append({'qty': qty, 'label': storage['label']})

            tasks = build_tasks(tasks_data, inv_map, inv_detail, items_map, cargo_map)

            # Tasks no longer expire on a timer; travelers have weekly credits instead
            meta = {
                'credits':     build_credits(tasks_data),
                'reroll_cost': tasks_data.get('rerollCreditCost'),
                'quests':      build_quests(results.get('quests') or [], (results.get('my_quests') or {}).get('quests', []),
                                            results.get('levels') or {}, inv_map, items_map, cargo_map),
                'warnings':    warnings,
            }

            if not tasks:
                self._send(200, {'tasks': [], **meta})
                return

            # Enrich crafting info — one API call per unique item, in parallel
            seen = {}
            unique = []
            for t in tasks:
                for item in t['items']:
                    k = f"{item['id']}|{item['type']}"
                    if k not in seen:
                        seen[k] = None
                        unique.append(item)

            with ThreadPoolExecutor(max_workers=10) as pool:
                futures = {
                    pool.submit(get_craft_info, it['id'], it['type'], it['qty'], inv_map, items_map, cargo_map): f"{it['id']}|{it['type']}"
                    for it in unique
                }
                for f in as_completed(futures):
                    k = futures[f]
                    try:
                        seen[k] = f.result()
                    except Exception:
                        seen[k] = {'status': 'none', 'details': [], 'building': ''}

            # Attach craft_info back to items
            for t in tasks:
                for item in t['items']:
                    k = f"{item['id']}|{item['type']}"
                    item['craft_info'] = seen.get(k, {'status': 'none', 'details': [], 'building': ''})

            # Enrich market prices from selected claim(s)
            if market_claims:
                unique_items = {(item['id'], item['type']) for t in tasks for item in t['items']}
                price_map = {}
                with ThreadPoolExecutor(max_workers=10) as pool:
                    futures = {
                        pool.submit(get_market_prices_for_claims, iid, itype, market_claims): iid
                        for iid, itype in unique_items
                    }
                    for f in as_completed(futures):
                        iid = futures[f]
                        try:
                            price_map[iid] = f.result()  # [{claimId, claimName, price}] sorted asc
                        except Exception:
                            price_map[iid] = []
                for t in tasks:
                    for item in t['items']:
                        prices = price_map.get(item['id'], [])
                        # Filter by available qty; None means quantity not reported — treat as sufficient
                        sufficient = [p for p in prices if p.get('available') is None or p.get('available', 0) >= item['qty']]
                        item['market_prices'] = sufficient
                        # market_price = lowest for backward-compat cost calculation
                        item['market_price'] = sufficient[0]['price'] if sufficient else None

            self._send(200, {'tasks': tasks, **meta})

        except Exception as e:
            self._send(500, {'error': str(e)})

    def _send(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        for k, v in cors_headers().items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        pass
