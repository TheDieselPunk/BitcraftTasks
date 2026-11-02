"""
GET /api/quest_prices?items=ID:TYPE:QTY,...&regionId=R&x=X&z=Z&username=Name&player_id=P

Cheapest way to buy QTY of each quest item in the player's region, from claim markets and
from stalls that sell for Hex Coin. Stall stock is checked against what the stall actually holds.
For items the region can't supply in full, how to craft the rest: the recipe, the ingredients the
player still needs (player_id gives what they have) and where to buy those in the region.

Returns:
  - items: {id: {buy, cost, short, picks: [{units, cost, unit, claim, source, seller, dist}], craft?}}
    short = units that can't be bought in the region; dist is in display units (raw / 3)
    craft = {recipe, building, crafts, makes, levels: [{skill, level, have}],
             ingredients: [{id, type, name, qty, have, where, buy, cost, short, picks}]}
    where = [{qty, label, container, place, elsewhere}]: the player's containers holding the ingredient
  - offers: {id: [{claim, region, x, z, price, bundle, units, source, seller}]}: every offer within
    ROUTE_RADIUS of the player in any region, for planning a shopping route (price is per bundle)
  - region: region name
"""

import json
import sys
import os
import math
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(__file__))
from _lib import api_get, distance, cors_headers, get_claims, build_inv_map, build_inv_detail_map, get_player_housing_items, \
    get_skill_levels, merge_housing

INFINITE_STOCK = 2_000_000_000
HEX_COIN_ID    = '1'
ROUTE_RADIUS   = 3000   # how far (display units) to look for shopping-route stops, in any region


def dist_h(px, pz, x, z):
    if None in (px, pz, x, z):
        return None
    return round(distance(px, pz, float(x), float(z)) / 3)


def fetch(path):
    try:
        return api_get(path)
    except Exception:
        return None


def get_all_stalls():
    """All stalls (every page). Returns (stalls, failed_page_count)."""
    first  = api_get('/api/stalls', {'limit': 100, 'page': 1})
    stalls = list(first.get('stalls', []))
    failed = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        pages = [pool.submit(api_get, '/api/stalls', {'limit': 100, 'page': p})
                 for p in range(2, (first.get('totalPages') or 1) + 1)]
        for f in pages:
            try:
                stalls += f.result().get('stalls', [])
            except Exception:
                failed += 1
    return stalls, failed


def player_items(player_id, home_region):
    """({item_id: qty}, {item_id: [{qty, label, container, place, elsewhere}]}) across the player's inventories,
    banks and house storage."""
    with ThreadPoolExecutor(max_workers=3) as pool:
        inv_f     = pool.submit(api_get, f'/api/players/{player_id}/inventories')
        houses_f  = pool.submit(get_player_housing_items, player_id)
        regions_f = pool.submit(fetch, '/api/regions')
        inv_data, houses, regions = inv_f.result(), houses_f.result(), regions_f.result() or []
    names = {str(r.get('regionId')): r.get('regionName') for r in regions}
    have, where = build_inv_map(inv_data), build_inv_detail_map(inv_data, names, home_region)
    merge_housing(have, where, houses)
    return have, where


def stall_offers(stalls, wanted, me):
    """Hex Coin offers for wanted (id, type) keys: [{key, stall, bundle, price, trades}]."""
    offers = []
    for st in stalls:
        if not st.get('claimName') or (st.get('ownerName') or '').lower() == me:
            continue
        for o in st.get('orders', []):
            req   = o.get('requiredItems') or []
            stock = o.get('remainingStock', 0)
            if o.get('requiredCargo') or len(req) != 1 or str(req[0].get('itemId')) != HEX_COIN_ID \
                    or req[0].get('quantity', 0) <= 0 or stock == 0:
                continue
            for field, typ in (('offerItems', 'item'), ('offerCargo', 'cargo')):
                for off in o.get(field) or []:
                    key = (str(off.get('itemId') or off.get('cargoId') or ''), typ)
                    if key in wanted:
                        offers.append({'key': key, 'stall': st, 'bundle': max(off.get('quantity', 1), 1),
                                       'price': req[0]['quantity'],
                                       'trades': None if stock >= INFINITE_STOCK else stock})
    return offers


def stall_stock(offer, claim_inv, owner_inv):
    """Units of the item the stall actually holds, or None if the stall's container wasn't found."""
    st, iid = offer['stall'], offer['key'][0]
    buildings = [b for b in (claim_inv or {}).get('buildings', []) if str(b.get('entityId')) == str(st.get('entityId'))]
    if buildings:
        return sum((s.get('contents') or {}).get('quantity', 0) for b in buildings for s in b.get('inventory', [])
                   if str((s.get('contents') or {}).get('item_id')) == iid)
    bags = [b for b in (owner_inv or {}).get('inventories', []) if str(b.get('entityId')) == str(st.get('entityId'))]
    if bags:
        return sum((p.get('contents') or {}).get('quantity', 0) for b in bags for p in b.get('pockets', [])
                   if str((p.get('contents') or {}).get('itemId')) == iid)
    return None


def cheapest(need, sources):
    """Buy `need` units from the cheapest sources first."""
    left, cost, picks = need, 0, []
    for s in sorted(sources, key=lambda s: (s['price'] / s['bundle'], s['dist'] if s['dist'] is not None else math.inf)):
        if left <= 0:
            break
        trades = min(math.ceil(left / s['bundle']), s['units'] // s['bundle'])
        if trades <= 0:
            continue
        units = trades * s['bundle']
        cost += trades * s['price']
        left -= units
        picks.append({'units': units, 'cost': trades * s['price'], 'unit': round(s['price'] / s['bundle']),
                      'claim': s['claim'], 'source': s['source'], 'seller': s['seller'], 'dist': s['dist']})
    return {'buy': need, 'cost': cost, 'short': max(0, left), 'picks': picks}


def craft_plan(key, units, detail, have, where, levels):
    """How to craft `units` of an item: its recipe and the ingredients still needed. None without a recipe."""
    recipes = [r for r in (detail or {}).get('craftingRecipes') or [] if r.get('consumedItems')]
    if not recipes:
        return None
    # "Unpack ... Package" recipes need a package made from the item itself
    recipe = next((r for r in recipes if not (r.get('name') or '').startswith('Unpack')), recipes[0])
    makes  = next((o.get('quantity') for o in recipe.get('craftedItems', []) if str(o.get('id')) == key[0]), None) \
        or recipe.get('outputQuantity') or 1
    crafts = math.ceil(units / makes)
    ingredients = []
    for c in recipe['consumedItems']:
        iid = str(c.get('id'))
        qty = (c.get('quantity') or 1) * crafts
        got = have.get(iid, 0)
        ingredients.append({'id': iid, 'type': 'cargo' if c.get('itemType') == 1 else 'item', 'name': c.get('name') or iid,
                            'qty': qty, 'have': got, 'buy': max(0, qty - got), 'where': where.get(iid, []) if got else []})
    return {
        'recipe':      recipe.get('name', ''),
        'building':    recipe.get('buildingName', ''),
        'crafts':      crafts,
        'makes':       units,
        'levels':      [{'skill': (r.get('skill') or {}).get('name') or f"Skill {r.get('skill_id')}", 'level': r.get('level'),
                         'have': int(levels.get(str(r.get('skill_id')), 0))} for r in recipe.get('levelRequirements') or []],
        'ingredients': ingredients,
    }


class Sources:
    """Offers near the player for each (id, type) key: claim market orders and Hex Coin stall trades."""

    def __init__(self, region_id, me, px, pz, stalls, claims):
        self.region_id, self.me, self.px, self.pz = region_id, me, px, pz
        self.stalls      = [s for s in stalls if self.keep(s.get('regionId'), s.get('locationX'), s.get('locationZ'))[0]]
        self.claim_at    = {(c['name'], round(c['x']), round(c['z'])): c['id'] for c in claims}
        self.claim_named = {c['name']: c['id'] for c in claims}
        self.claim_inv   = {}
        self.owner_inv   = {}
        self.region      = ''
        self.by_key      = {}

    def keep(self, region_of, x, z):
        """In the player's region (for prices) or close enough for a shopping route."""
        in_region = not self.region_id or str(region_of) == self.region_id
        d = dist_h(self.px, self.pz, x, z)
        return in_region or (d is not None and d <= ROUTE_RADIUS), in_region, d

    def add(self, key, in_region, d, region, **source):
        if in_region:
            self.region = self.region or region
        self.by_key.setdefault(key, []).append({**source, 'dist': d, 'region': region, 'in_region': in_region})

    def add_market(self, key, orders):
        for o in orders:
            ok, in_region, d = self.keep(o.get('regionId'), o.get('claimLocationX'), o.get('claimLocationZ'))
            if not ok or (o.get('ownerUsername') or '').lower() == self.me:
                continue
            try:
                price, units = int(o['priceThreshold']), int(o['quantity'])
            except (KeyError, TypeError, ValueError):
                continue
            self.add(key, in_region, d, o.get('regionName') or '', bundle=1, price=price, units=units,
                     claim=o.get('claimName', ''), source='market', seller=o.get('ownerUsername') or '',
                     x=o.get('claimLocationX'), z=o.get('claimLocationZ'))

    def claim_id(self, st):
        # Claim names can repeat across regions, so match on position too (a stall's position is its claim's)
        x, z = st.get('locationX'), st.get('locationZ')
        at = (st['claimName'], round(float(x)), round(float(z))) if x is not None and z is not None else None
        return self.claim_at.get(at) or self.claim_named.get(st['claimName'])

    def add_stalls(self, keys):
        """Stall offers for these keys, keeping only stock the stall actually holds: building stalls sit in the
        claim's buildings, deployable stands in their owner's inventories."""
        offers = stall_offers(self.stalls, set(keys), self.me)
        cids   = {self.claim_id(o['stall']) for o in offers} - {None} - set(self.claim_inv)
        owners = {str(o['stall'].get('ownerEntityId')) for o in offers if o['stall'].get('ownerEntityId')} - set(self.owner_inv)
        with ThreadPoolExecutor(max_workers=10) as pool:
            self.claim_inv.update(zip(cids, pool.map(lambda c: fetch(f'/api/claims/{c}/inventories'), cids)))
            self.owner_inv.update(zip(owners, pool.map(lambda e: fetch(f'/api/players/{e}/inventories'), owners)))
        for o in offers:
            st   = o['stall']
            held = stall_stock(o, self.claim_inv.get(self.claim_id(st)), self.owner_inv.get(str(st.get('ownerEntityId'))))
            caps = [u for u in (held, None if o['trades'] is None else o['trades'] * o['bundle']) if u is not None]
            if not caps or min(caps) <= 0:
                continue
            _, in_region, d = self.keep(st.get('regionId'), st.get('locationX'), st.get('locationZ'))
            self.add(o['key'], in_region, d, st.get('regionName') or '', bundle=o['bundle'], price=o['price'],
                     units=min(caps), claim=st['claimName'], source='stall',
                     seller=st.get('nickname') or st.get('ownerName') or '', x=st.get('locationX'), z=st.get('locationZ'))

    def in_region(self, key, units):
        return cheapest(units, [s for s in self.by_key.get(key, []) if s['in_region']])


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params    = parse_qs(urlparse(self.path).query)
        region_id = params.get('regionId', [''])[0].strip()
        username  = params.get('username', [''])[0].strip()
        player_id = params.get('player_id', [''])[0].strip()
        try:
            px = float(params.get('x', [''])[0])
            pz = float(params.get('z', [''])[0])
        except ValueError:
            px = pz = None

        # items: comma-separated "id:type:qty" (qty = units still needed)
        need = {}
        for part in params.get('items', [''])[0].split(','):
            bits = part.split(':')
            if len(bits) == 3 and bits[0] and bits[2].isdigit() and int(bits[2]) > 0:
                need[(bits[0], 'cargo' if bits[1] == 'cargo' else 'item')] = int(bits[2])
        if not need:
            self._send(400, {'error': 'items parameter is required'})
            return

        try:
            warnings = []

            def market(pool, keys):
                return {k: pool.submit(api_get, f'/api/market/{k[1]}/{k[0]}') for k in keys}

            def add_markets(futures):
                for k, f in futures.items():
                    try:
                        src.add_market(k, f.result().get('sellOrders', []))
                    except Exception:
                        warnings.append(f'Could not load market orders for item {k[0]}')

            with ThreadPoolExecutor(max_workers=12) as pool:
                markets  = market(pool, need)
                stalls_f = pool.submit(get_all_stalls)
                claims_f = pool.submit(get_claims, px, pz, None) if px is not None else None
                have_f   = pool.submit(player_items, player_id, region_id) if player_id else None
                levels_f = pool.submit(get_skill_levels, username, player_id) if player_id and username else None

                try:
                    stalls, failed = stalls_f.result()
                    if failed:
                        warnings.append(f'Quest prices may miss some stalls — {failed} page(s) failed to load')
                except Exception:
                    stalls = []
                    warnings.append('Could not load stalls for quest prices')
                src = Sources(region_id, username.lower(), px, pz, stalls, claims_f.result()[1] if claims_f else [])
                add_markets(markets)
                try:
                    have, where = have_f.result() if have_f else ({}, {})
                except Exception:
                    have, where = {}, {}
                    warnings.append('Could not load your inventory for crafting ingredients')
                try:
                    levels = levels_f.result() if levels_f else {}
                except Exception:
                    levels = {}

            src.add_stalls(need)
            items = {k[0]: src.in_region(k, n) for k, n in need.items()}

            # Crafting what the region can't supply: recipes, then where to buy the missing ingredients
            short = [k for k in need if items[k[0]]['short']]
            if short:
                with ThreadPoolExecutor(max_workers=10) as pool:
                    details = list(pool.map(lambda k: fetch(f'/api/{"cargo" if k[1] == "cargo" else "items"}/{k[0]}'), short))
                plans = {k: craft_plan(k, items[k[0]]['short'], d, have, where, levels) for k, d in zip(short, details)}
                plans = {k: p for k, p in plans.items() if p}
                extra = {(i['id'], i['type']) for p in plans.values() for i in p['ingredients'] if i['buy']} - set(need)
                if extra:
                    with ThreadPoolExecutor(max_workers=10) as pool:
                        add_markets(market(pool, extra))
                    src.add_stalls(extra)
                for k, p in plans.items():
                    for ing in p['ingredients']:
                        ing.update(src.in_region((ing['id'], ing['type']), ing['buy']) if ing['buy']
                                   else {'cost': 0, 'short': 0, 'picks': []})
                    items[k[0]]['craft'] = p

            route_fields = ('claim', 'region', 'x', 'z', 'price', 'bundle', 'units', 'source', 'seller')
            self._send(200, {
                'items':    items,
                'offers':   {k[0]: [{f: s[f] for f in route_fields} for s in src.by_key.get(k, [])
                                    if s['dist'] is not None and s['dist'] <= ROUTE_RADIUS] for k in need},
                'region':   src.region,
                'warnings': warnings,
            })

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
