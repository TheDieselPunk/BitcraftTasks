"""
GET /api/recommend?player_id=P&username=Name&x=X&z=Z&regionId=R&range=H

Which claim, anywhere in the world, to do traveler tasks at: the one whose market and Hex Coin stalls (plus
those of claims within `range` display units of it) cover the most of the tasks the player can be given. That's every task
in the tiers they've unlocked, not just the ones they hold now, since rerolls and new tasks draw from the same pool.

A task is covered at a claim when everything the player doesn't already own can be bought there for less
than the reward. Pool tasks are each priced on their own. The tasks the player holds now are also planned
together: they share the market's stock and the player's items, most profitable first.
Tasks the player's own items cover need no market, so they're left out of the pool and reported as `ready`.

Stalls are counted at their listed stock to rank every claim, then the stalls at the best claims are checked
against what they actually hold (as in quest_prices) and those claims are ranked again. Every stall purchase
in the claims returned has been checked; a stall whose contents can't be read isn't counted.

Returns:
  - claims: up to MAX_CLAIMS of {claimId, name, region, regionId, x, z, dist, covered, pool_profit, markets,
      travelers: [{traveler, covered, total}],
      profit, spend, reward, costly: [str], unavailable: [str],
      tasks: [{traveler, reward, spend, profit,
               items: [{name, qty, own, buy, cost, from: [{claim, units, cost, unit, stall, stand}]}]}]},
    most pool tasks covered first; if none of those is in the player's region (regionId), the best there is added
    dist = display units from the player (None without x/z); markets = claims bought from
    stall = the stall to buy from (None for a market order); stand = it's a Trader Stand, which may have moved
    covered = pool tasks covered; pool_profit = their combined profit
    profit, spend, reward, tasks, costly, unavailable = the plan for the tasks held now
    costly = tasks that cost more than they pay there; unavailable = tasks with items not for sale there
  - pool: {total, own, travelers: [{traveler, total}]}: tasks the player can be given that need shopping,
    and how many more their own items already cover
  - ready: {count, reward}: held tasks covered by the player's own items
  - total: number of held tasks
  - range: the radius used
"""

import json
import sys
import os
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(__file__))
from _lib import api_get, distance, cors_headers, build_inv_map, build_name_maps, get_claims, get_player_housing_items, \
    get_skill_levels
from quest_prices import get_all_stalls, stall_offers, stall_label, stall_stock

TRAVELERS  = {1: 'Rumbagh', 2: 'Svim', 3: 'Heimlich', 5: 'Brico', 6: 'Alesi', 7: 'Ramparte'}
# The task catalog has no traveler ids, but each traveler's tasks need their own skill
SKILL_TRAVELER = {13: 'Heimlich', 15: 'Brico', 17: 'Alesi', 18: 'Ramparte', 19: 'Rumbagh', 21: 'Svim'}
MAX_CLAIMS = 5
SHORTLIST  = 12   # claims whose stalls get their real stock checked before the final ranking
MAX_RANGE  = 1000


def get(path, params=None):
    """api_get with one retry: this endpoint makes well over a hundred calls, and the odd one fails."""
    try:
        return api_get(path, params)
    except Exception:
        time.sleep(0.5)
        return api_get(path, params)


def pages(path, field):
    """Every page of a paged BitJita list."""
    first = get(path, {'limit': 100, 'page': 1})
    rows  = list(first.get(field, []))
    for page in range(2, (first.get('totalPages') or 1) + 1):
        rows += get(path, {'limit': 100, 'page': page}).get(field, [])
    return rows, first


def read_tasks(tasks_data):
    """Incomplete tasks as [{id, traveler, skill, tier, reward, items: [{key, name, qty}]}], key = (id, type).
    Works on a player's tasks and on the task catalog. tier = the task's minimum skill level."""
    tasks = []
    for t in tasks_data.get('tasks', []):
        if t.get('completed'):
            continue
        items = []
        for req in t.get('requiredItems', []):
            typ     = 'cargo' if req.get('item_type') == 'cargo' else 'item'
            catalog = tasks_data.get('cargo' if typ == 'cargo' else 'items') or {}
            iid     = str(req.get('item_id'))
            info    = (catalog.get(iid) or catalog.get(req.get('item_id')) or {}) if isinstance(catalog, dict) else {}
            items.append({'key': (iid, typ), 'name': info.get('name') or iid, 'qty': req.get('quantity', 1)})
        if not items:
            continue
        level = t.get('levelRequirement') or {}
        skill = level.get('skill_id') or (t.get('rewardedExperience') or {}).get('skill_id')
        tasks.append({
            'id':       t.get('taskId') or t.get('id'),
            'traveler': TRAVELERS.get(t.get('travelerId')) or SKILL_TRAVELER.get(skill)
                        or (t.get('description') or '').split(' ')[0] or '?',
            'skill':    skill,
            'tier':     level.get('min_level') or 1,
            'reward':   next((r.get('quantity', 0) for r in t.get('rewardedItems', []) if r.get('item_id') == 1), 0),
            'items':    items,
        })
    return tasks


def unlocked_tiers(quests, my_quests, item_names):
    """
    Task tiers gated by an "Unlock ... Tasks" quest: ({(skill_id, level)} with a quest, the ones the player
    has unlocked). Each of those quests needs the skill level its tier starts at.
    """
    done  = {q.get('questChainDescId') for q in my_quests if q.get('completed')}
    gated, unlocked = set(), set()
    for q in quests:
        names = [item_names.get(str(r.get('item_id')), '') for r in q.get('rewards', []) if r.get('type') == 'ItemStack']
        if not any(n.startswith('Unlock ') and n.endswith(' Tasks') for n in names):
            continue
        for r in q.get('requirements', []):
            if r.get('type') == 'Level':
                gated.add((r.get('skill_id'), r.get('level')))
                if q.get('id') in done:
                    unlocked.add((r.get('skill_id'), r.get('level')))
    return gated, unlocked


def task_pool(catalog, held, gated, unlocked, levels):
    """
    The catalog tasks the player can be given: tiers they've unlocked by quest, tiers no quest gates that
    their skill level reaches, and the tier of any task they hold (they wouldn't have it otherwise).
    """
    seen = {(t['skill'], t['tier']) for t in held}

    def open_to(t):
        tier = (t['skill'], t['tier'])
        if tier in seen or tier in unlocked:
            return True
        return tier not in gated and t['tier'] <= max(1, int(levels.get(str(t['skill']), 0)))

    return [t for t in catalog if open_to(t)]


def task_label(t):
    return f"{t['traveler']}: " + ', '.join(f"{i['qty']:,}× {i['name']}" for i in t['items'])


def read_orders(market, me):
    """Sell orders as ([{claim, price, units, bundle, cost, stall}], {claim_id: {name, region, regionId, x, z}}),
    skipping the player's own. price is per unit; a stall sells `bundle` units for `cost`."""
    orders, claims = [], {}
    for o in market.get('sellOrders', []):
        cid = str(o.get('claimEntityId') or '')
        try:
            price, units = int(o['priceThreshold']), int(o['quantity'])
            x, z = float(o['claimLocationX']), float(o['claimLocationZ'])
        except (KeyError, TypeError, ValueError):
            continue
        if not cid or units <= 0 or price <= 0 or (o.get('ownerUsername') or '').lower() == me:
            continue
        orders.append({'claim': cid, 'price': price, 'units': units, 'bundle': 1, 'cost': price, 'stall': None})
        claims[cid] = {'name': o.get('claimName') or '', 'region': o.get('regionName') or '',
                       'regionId': o.get('regionId'), 'x': x, 'z': z}
    return orders, claims


def read_stalls(stalls, wanted, me, all_claims, claims):
    """
    Hex Coin stall offers for the wanted (id, type) keys, at their listed stock, in the shape read_orders gives.
    Stalls only name their claim, so its id comes from the claim at the stall's position.
    Adds the stalls' claims to `claims`. Returns {key: [offer]}.
    """
    at = {(c['name'], round(c['x']), round(c['z'])): c['id'] for c in all_claims}
    found = {}
    for o in stall_offers(stalls, wanted, me):
        st = o['stall']
        try:
            x, z = float(st['locationX']), float(st['locationZ'])
        except (KeyError, TypeError, ValueError):
            continue
        cid = at.get((st['claimName'], round(x), round(z)))
        if not cid:
            continue
        units = (10 ** 9 if o['trades'] is None else o['trades']) * o['bundle']
        claims.setdefault(cid, {'name': st['claimName'], 'region': st.get('regionName') or '',
                                'regionId': st.get('regionId'), 'x': x, 'z': z})
        found.setdefault(o['key'], []).append({
            'claim': cid, 'price': o['price'] / o['bundle'], 'units': units, 'bundle': o['bundle'], 'cost': o['price'],
            'stall': {'st': st, 'key': o['key'], 'listed': units, 'label': st.get('nickname') or st.get('ownerName') or 'Stall',
                      'stand': bool(st.get('nickname'))},   # only Trader Stands have a nickname
        })
    return found


def check_stalls(orders, claim_ids):
    """Cap the stall offers at these claims to what the stalls actually hold, and name the stalls properly.
    Building stalls sit in the claim's buildings, Trader Stands in their owner's inventories."""
    offers = [o for lst in orders.values() for o in lst if o['stall'] and o['claim'] in claim_ids]
    owners = {str(o['stall']['st'].get('ownerEntityId')) for o in offers if o['stall']['stand']} - {'None', ''}

    def fetch(path):
        try:
            return get(path)
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=16) as pool:
        claim_inv = dict(zip(claim_ids, pool.map(lambda c: fetch(f'/api/claims/{c}/inventories'), claim_ids)))
        owner_inv = dict(zip(owners, pool.map(lambda e: fetch(f'/api/players/{e}/inventories'), owners)))
    for o in offers:
        s    = o['stall']
        inv  = claim_inv.get(o['claim'])
        held = stall_stock({'stall': s['st'], 'key': s['key']}, inv, owner_inv.get(str(s['st'].get('ownerEntityId'))))
        # A stall whose container can't be found doesn't count: its listing alone isn't proof of stock
        o['units']  = min(s['listed'], held or 0)
        o['units'] -= o['units'] % o['bundle']
        s['label']  = stall_label(s['st'], inv)


def take_own(tasks, have):
    """Split off the tasks the player's own items cover (best reward first), using those items up."""
    ready, rest = [], []
    for t in sorted(tasks, key=lambda t: -t['reward']):
        need = {}
        for i in t['items']:
            need[i['key'][0]] = need.get(i['key'][0], 0) + i['qty']
        if all(have.get(iid, 0) >= n for iid, n in need.items()):
            for iid, n in need.items():
                have[iid] -= n
            ready.append(t)
        else:
            rest.append(t)
    return ready, rest


def lot_cost(lot, units):
    """Price of `units` from a lot: stalls sell whole bundles."""
    o = lot[4]
    return -(-units // o['bundle']) * o['cost']


def buy_task(task, stock, have, commit):
    """
    Cost of a task from `stock` ({key: [[price, units, claim, rank, offer], ...]} cheapest first) and the player's items.
    Returns {spend, items} or None if something isn't for sale. With commit, uses up the stock and items taken.
    """
    spend, lines, used_own, used_stock = 0, [], {}, []
    for i in task['items']:
        iid   = i['key'][0]
        own   = min(i['qty'], have.get(iid, 0) - used_own.get(iid, 0))
        left  = i['qty'] - own
        cost, picks = 0, []
        for n, lot in enumerate(stock.get(i['key'], [])):
            if left <= 0:
                break
            units = min(left, lot[1] - sum(u for k, m, u in used_stock if k == i['key'] and m == n))
            if units <= 0:
                continue
            used_stock.append((i['key'], n, units))
            paid = lot_cost(lot, units)
            sold = lot[4]['stall']
            picks.append({'claim': lot[2], 'units': units, 'cost': paid, 'unit': round(lot[0]),
                          'stall': sold['label'] if sold else None, 'stand': bool(sold and sold['stand'])})
            cost += paid
            left -= units
        if left > 0:
            return None
        used_own[iid] = used_own.get(iid, 0) + own
        spend += cost
        lines.append({'name': i['name'], 'qty': i['qty'], 'own': own, 'buy': i['qty'] - own, 'cost': cost, 'from': picks})
    if commit:
        for iid, n in used_own.items():
            if n:
                have[iid] -= n
        for key, n, units in used_stock:
            stock[key][n][1] -= units
    return {'spend': spend, 'items': lines}


def plan_claim(members, tasks, orders, have):
    """The profitable tasks doable with the markets of `members` (claim ids, nearest to the hub first).
    orders = {claim_id: {key: [offer]}}."""
    stock = {}
    for n, cid in enumerate(members):
        for key, lots in orders.get(cid, {}).items():
            stock.setdefault(key, []).extend([o['price'], o['units'], cid, n, o] for o in lots)
    for lots in stock.values():
        lots.sort(key=lambda lot: (lot[0], lot[3]))
    have  = dict(have)

    # Most profitable first, priced before anything is used up
    first = [(t, buy_task(t, stock, have, False)) for t in tasks]
    order = sorted((p for p in first if p[1]), key=lambda p: -(p[0]['reward'] - p[1]['spend']))
    done, costly = [], []
    for t, _ in order:
        b = buy_task(t, stock, have, False)
        if b and b['spend'] < t['reward']:
            buy_task(t, stock, have, True)
            done.append({'traveler': t['traveler'], 'reward': t['reward'], 'spend': b['spend'],
                         'profit': t['reward'] - b['spend'], 'items': b['items']})
        else:
            costly.append(task_label(t))   # too dear, or outbid for the stock by a better task
    bought = {p['claim'] for d in done for i in d['items'] for p in i['from']}
    return {
        'tasks':       done,
        'profit':      sum(d['profit'] for d in done),
        'spend':       sum(d['spend'] for d in done),
        'reward':      sum(d['reward'] for d in done),
        'markets':     [c for c in members if c in bought],
        'costly':      costly,
        'unavailable': [task_label(t) for t, b in first if not b],
    }


def cover(needs, reward, stock):
    """Spend to buy a pool task's missing items from `stock`, and the claims bought from. None if it isn't
    all for sale or costs as much as the task pays."""
    spend, used = 0, set()
    for key, left in needs:
        for lot in stock.get(key, ()):
            units  = min(left, lot[1])
            spend += lot_cost(lot, units)
            left  -= units
            used.add(lot[2])
            if left <= 0:
                break
        if left > 0 or spend >= reward:
            return None
    return spend, used


def recommend(tasks, pool, orders, claims, have, px, pz, radius, region_id=None, check=None):
    """Best claims to do tasks at, plus the best one in the player's region if that isn't among them.
    check(orders, claim_ids) corrects the stall stock at those claims. Returns (plans, ready, pool_info)."""
    # Pool tasks, each priced on its own against everything the player owns
    shop, own = [], 0
    for t in pool:
        needs = {}
        for i in t['items']:
            needs[i['key']] = needs.get(i['key'], 0) + i['qty']
        needs = [(k, n - have.get(k[0], 0)) for k, n in needs.items() if n > have.get(k[0], 0)]
        if needs:
            shop.append((t, needs))
        else:
            own += 1
    travelers = sorted({t['traveler'] for t, _ in shop})

    have = dict(have)
    ready, rest = take_own(tasks, have)

    def gap(a, b):
        return distance(a['x'], a['z'], b['x'], b['z']) / 3

    by_claim = {}

    def index():
        by_claim.clear()
        for key, lst in orders.items():
            for o in lst:
                if o['units'] > 0:
                    by_claim.setdefault(o['claim'], {}).setdefault(key, []).append(o)

    index()

    def stock_of(members):
        stock = {}
        for n, cid in enumerate(members):
            for key, lots in by_claim.get(cid, {}).items():
                stock.setdefault(key, []).extend((o['price'], o['units'], cid, n, o) for o in lots)
        for lots in stock.values():
            lots.sort(key=lambda lot: (lot[0], lot[3]))
        return stock

    def covered_by(members):
        stock = stock_of(members)
        hits  = []
        for n, (t, needs) in enumerate(shop):
            if all(k in stock for k, _ in needs):
                c = cover(needs, t['reward'], stock)
                if c:
                    hits.append((n, t['reward'] - c[0], c[1]))
        return hits

    def score(hub, members):
        """What the hub covers, or None if it covers nothing or sells none of it itself."""
        c    = claims[hub]
        hits = covered_by(members)
        used = set().union(*(u for _, _, u in hits)) if hits else set()
        if hub not in used:
            return None   # nothing to buy at the hub itself: one of its neighbours is the place to stand
        return {
            'claimId': hub, 'name': c['name'], 'region': c['region'], 'regionId': c['regionId'], 'x': c['x'], 'z': c['z'],
            'dist':        round(distance(px, pz, c['x'], c['z']) / 3) if px is not None else None,
            'covered':     len(hits),
            'pool_profit': sum(profit for _, profit, _ in hits),
            'travelers':   [{'traveler': name, 'covered': sum(1 for n, _, _ in hits if shop[n][0]['traveler'] == name),
                             'total': sum(1 for t, _ in shop if t['traveler'] == name)} for name in travelers],
            'markets':     [m for m in members if m in used],
            '_members':    members,
            '_used':       used,
            '_sig':        frozenset(n for n, _, _ in hits) if radius else hub,
        }

    def rank(plans):
        return sorted(plans, key=lambda p: (-p['covered'], -p['pool_profit'], p['dist'] if p['dist'] is not None else 0, p['name']))

    def in_region(p):
        return region_id and str(p['regionId']) == str(region_id)

    best = {}   # the pool tasks covered -> the hub to stand at for them
    for hub, c in claims.items():
        members = [hub]
        if radius:
            near    = [(gap(c, o), cid) for cid, o in claims.items()
                       if cid != hub and abs(o['x'] - c['x']) <= radius * 3 and abs(o['z'] - c['z']) <= radius * 3]
            members += [cid for d, cid in sorted(near) if d <= radius]
        plan = score(hub, members)
        if not plan:
            continue
        # Neighbouring hubs often cover exactly the same tasks: keep the one that covers the most by itself
        plan['_solo'] = len(covered_by([hub])) if radius else plan['covered']
        if plan['_sig'] not in best or best[plan['_sig']]['_solo'] < plan['_solo']:
            best[plan['_sig']] = plan

    ranked = rank(best.values())
    # Stall listings overstate their stock, so check the stalls the front-runners rely on and rank those again.
    # A corrected claim can turn to other stalls, so repeat until nothing shown rests on an unchecked stall;
    # past a few rounds, whatever is still unchecked is dropped instead.
    if check:
        short   = ranked[:SHORTLIST] + [p for p in ranked[SHORTLIST:] if in_region(p)][:3]
        checked = set()
        for attempt in range(6):
            todo = set().union(*(p['_used'] for p in short)) - checked if short else set()
            todo = {cid for cid in todo if any(o['stall'] for lots in by_claim.get(cid, {}).values() for o in lots)}
            if not todo:
                break
            if attempt < 5:
                check(orders, todo)
            else:
                for lst in orders.values():
                    for o in lst:
                        if o['stall'] and o['claim'] in todo:
                            o['units'] = 0
            checked |= todo
            index()
            short = [p for p in (score(s['claimId'], s['_members']) for s in short) if p]
        ranked = rank(short)

    plans  = ranked[:MAX_CLAIMS]
    local  = next((p for p in ranked if in_region(p)), None)
    if local and local not in plans:
        plans.append(local)
    for p in plans:
        now = plan_claim(p.pop('_members'), rest, by_claim, have)
        del p['_used'], p['_sig'], now['markets']
        p.pop('_solo', None)
        p.update(now)
        p['markets'] = [claims[c]['name'] for c in p['markets']]
        for d in p['tasks']:
            for i in d['items']:
                for pick in i['from']:
                    pick['claim'] = claims[pick['claim']]['name']
    pool_info = {'total': len(shop), 'own': own,
                 'travelers': [{'traveler': name, 'total': sum(1 for t, _ in shop if t['traveler'] == name)} for name in travelers]}
    return plans, {'count': len(ready), 'reward': sum(t['reward'] for t in ready)}, pool_info


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params    = parse_qs(urlparse(self.path).query)
        player_id = params.get('player_id', [''])[0].strip()
        username  = params.get('username', [''])[0].strip()
        region_id = params.get('regionId', [''])[0].strip()
        if not player_id:
            self._send(400, {'error': 'player_id parameter is required'})
            return
        try:
            px = float(params.get('x', [''])[0])
            pz = float(params.get('z', [''])[0])
        except ValueError:
            px = pz = None
        try:
            radius = min(max(int(params.get('range', ['0'])[0]), 0), MAX_RANGE)
        except ValueError:
            radius = 0

        try:
            warnings = []

            def soft(future, default, what):
                try:
                    return future.result()
                except Exception:
                    warnings.append(f'Could not load {what} for the claim recommendation')
                    return default

            with ThreadPoolExecutor(max_workers=16) as pool:
                tasks_f   = pool.submit(get, f'/api/players/{player_id}/traveler-tasks')
                inv_f     = pool.submit(get, f'/api/players/{player_id}/inventories')
                house_f   = pool.submit(get_player_housing_items, player_id)
                catalog_f = pool.submit(pages, '/api/traveler-tasks', 'tasks')
                quests_f  = pool.submit(pages, '/api/quests', 'quests')
                mine_f    = pool.submit(get, f'/api/players/{player_id}/quests')
                items_f   = pool.submit(get, '/api/items')
                levels_f  = pool.submit(get_skill_levels, username, player_id) if username else None
                stalls_f  = pool.submit(get_all_stalls)
                claims_f  = pool.submit(get_claims, px or 0, pz or 0, None)

                tasks = read_tasks(tasks_f.result())

                # Every task the player can be given. Without the catalog, fall back to the tasks they hold
                rows, first = soft(catalog_f, ([], {}), 'the task catalog')
                catalog     = read_tasks({**first, 'tasks': rows})
                if catalog:
                    items_raw   = soft(items_f, {}, 'item names')
                    names, _    = build_name_maps(items_raw.get('items', items_raw) if isinstance(items_raw, dict) else items_raw, None)
                    quests, _   = soft(quests_f, ([], {}), 'the quest list')
                    my_quests   = soft(mine_f, {}, 'your quests').get('quests', [])
                    levels      = soft(levels_f, {}, 'your skill levels') if levels_f else {}
                    gated, unlocked = unlocked_tiers(quests, my_quests, names)
                    task_set    = task_pool(catalog, tasks, gated, unlocked, levels)
                else:
                    task_set = tasks

                keys    = {i['key'] for t in tasks + task_set for i in t['items']}
                markets = {k: pool.submit(get, f'/api/market/{k[1]}/{k[0]}') for k in keys}

                have = build_inv_map(soft(inv_f, {}, 'your inventory'))
                for storage in house_f.result():
                    for iid, qty in storage['items'].items():
                        have[iid] = have.get(iid, 0) + qty

                orders, claims, failed = {}, {}, 0
                for k, f in markets.items():
                    try:
                        orders[k], found = read_orders(f.result(), username.lower())
                        claims.update(found)
                    except Exception:
                        failed += 1
                if failed:
                    warnings.append(f'Claim recommendation may be off — market orders for {failed} item(s) failed to load')

                stalls, missed = soft(stalls_f, ([], 0), 'stalls')
                if missed:
                    warnings.append(f'Claim recommendation may miss some stalls — {missed} page(s) failed to load')
                for k, offers in read_stalls(stalls, keys, username.lower(), claims_f.result()[1], claims).items():
                    orders.setdefault(k, []).extend(offers)

            plans, ready, pool_info = recommend(tasks, task_set, orders, claims, have, px, pz, radius, region_id, check_stalls)
            self._send(200, {'claims': plans, 'pool': pool_info, 'ready': ready, 'total': len(tasks),
                             'range': radius, 'warnings': warnings})

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
