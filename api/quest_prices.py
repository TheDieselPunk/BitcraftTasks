"""
GET /api/quest_prices?items=ID:TYPE:QTY,...&regionId=R&x=X&z=Z&username=Name

Cheapest way to buy QTY of each quest item in the player's region, from claim markets and
from stalls that sell for Hex Coin. Stall stock is checked against what the stall actually holds.

Returns:
  - items: {id: {buy, cost, short, picks: [{units, cost, unit, claim, source, seller, dist}]}}
    short = units that can't be bought in the region; dist is in display units (raw / 3)
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
from _lib import api_get, distance, cors_headers, get_claims

INFINITE_STOCK = 2_000_000_000
HEX_COIN_ID    = '1'


def dist_h(px, pz, x, z):
    if None in (px, pz, x, z):
        return None
    return round(distance(px, pz, float(x), float(z)) / 3)


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


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params    = parse_qs(urlparse(self.path).query)
        region_id = params.get('regionId', [''])[0].strip()
        me        = params.get('username', [''])[0].strip().lower()
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
            region   = ''
            sources  = {k: [] for k in need}

            with ThreadPoolExecutor(max_workers=10) as pool:
                markets = {k: pool.submit(api_get, f'/api/market/{k[1]}/{k[0]}') for k in need}
                stalls_f = pool.submit(get_all_stalls)
                claims_f = pool.submit(get_claims, px, pz, region_id) if px is not None else None

                for k, f in markets.items():
                    try:
                        orders = f.result().get('sellOrders', [])
                    except Exception:
                        warnings.append(f'Could not load market orders for item {k[0]}')
                        continue
                    for o in orders:
                        if region_id and str(o.get('regionId')) != region_id:
                            continue
                        if (o.get('ownerUsername') or '').lower() == me:
                            continue
                        try:
                            price, units = int(o['priceThreshold']), int(o['quantity'])
                        except (KeyError, TypeError, ValueError):
                            continue
                        region = region or o.get('regionName') or ''
                        sources[k].append({'bundle': 1, 'price': price, 'units': units, 'claim': o.get('claimName', ''),
                                           'source': 'market', 'seller': o.get('ownerUsername') or '',
                                           'dist': dist_h(px, pz, o.get('claimLocationX'), o.get('claimLocationZ'))})

                try:
                    stalls, failed = stalls_f.result()
                    if failed:
                        warnings.append(f'Quest prices may miss some stalls — {failed} page(s) failed to load')
                except Exception:
                    stalls = []
                    warnings.append('Could not load stalls for quest prices')
                if region_id:
                    stalls = [s for s in stalls if str(s.get('regionId', '')) == region_id]
                claims = claims_f.result()[1] if claims_f else []

            # Check each candidate stall's real stock: building stalls sit in the claim's buildings,
            # deployable stands in their owner's inventories
            offers    = stall_offers(stalls, set(need), me)
            claim_ids = {c['name']: c['id'] for c in claims}
            cids      = {claim_ids.get(o['stall']['claimName']) for o in offers} - {None}
            owners    = {str(o['stall'].get('ownerEntityId')) for o in offers if o['stall'].get('ownerEntityId')}

            def fetch(path):
                try:
                    return api_get(path)
                except Exception:
                    return None

            with ThreadPoolExecutor(max_workers=8) as pool:
                claim_inv = dict(zip(cids, pool.map(lambda c: fetch(f'/api/claims/{c}/inventories'), cids)))
                owner_inv = dict(zip(owners, pool.map(lambda e: fetch(f'/api/players/{e}/inventories'), owners)))

            for o in offers:
                st    = o['stall']
                held  = stall_stock(o, claim_inv.get(claim_ids.get(st['claimName'])), owner_inv.get(str(st.get('ownerEntityId'))))
                caps  = [u for u in (held, None if o['trades'] is None else o['trades'] * o['bundle']) if u is not None]
                if not caps or min(caps) <= 0:
                    continue
                region = region or st.get('regionName') or ''
                sources[o['key']].append({'bundle': o['bundle'], 'price': o['price'], 'units': min(caps),
                                          'claim': st['claimName'], 'source': 'stall',
                                          'seller': st.get('nickname') or st.get('ownerName') or '',
                                          'dist': dist_h(px, pz, st.get('locationX'), st.get('locationZ'))})

            self._send(200, {
                'items':    {k[0]: cheapest(n, sources[k]) for k, n in need.items()},
                'region':   region,
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
