"""
GET /api/stalls?x=X&z=Z&range=N&regionId=R

Returns:
  - nearby: stalls within `range` units of player, with sell-side orders
  - nearestMarket: the closest claim that has stalls, with a price map
    {item_id: {name, minPrice, totalQty}} for all items sold there
"""

import json
import sys
import os
import math
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))
from _lib import api_get, distance, cors_headers

DEFAULT_RANGE  = 1000
INFINITE_STOCK = 2_000_000_000


def parse_sell_items(stall, dist):
    """Extract sell-side orders from a stall into a flat item list."""
    items = []
    for order in stall.get('orders', []):
        stock = order.get('remainingStock', 0)
        req   = order.get('requiredItems', [])
        req_c = order.get('requiredCargo', [])

        # Build full price parts list — requiredCargo uses itemId/itemName (not cargoId/cargoName)
        raw_price_parts = [
            {'qty': r.get('quantity', 1), 'name': r.get('itemName', '') or r.get('cargoName', '')}
            for r in (req + req_c)
            if r.get('itemName') or r.get('cargoName')
        ]

        for offer in order.get('offerItems', []):
            item_id   = str(offer.get('itemId', ''))
            offer_qty = max(offer.get('quantity', 1), 1)
            if not item_id:
                continue
            # Normalise price to per-unit (e.g. 60 hex for 5 items → 12 hex each)
            price_parts = [
                {'qty': round(p['qty'] / offer_qty), 'name': p['name']}
                for p in raw_price_parts
            ]
            items.append({
                'id':          item_id,
                'name':        offer.get('itemName', ''),
                'qty':         offer_qty,
                'stock':       None if stock >= INFINITE_STOCK else stock,
                'price_parts': price_parts,
            })

        for offer in order.get('offerCargo', []):
            cargo_id  = str(offer.get('itemId', '') or offer.get('cargoId', ''))
            offer_qty = max(offer.get('quantity', 1), 1)
            if not cargo_id:
                continue
            price_parts = [
                {'qty': round(p['qty'] / offer_qty), 'name': p['name']}
                for p in raw_price_parts
            ]
            items.append({
                'id':          cargo_id,
                'name':        offer.get('itemName', '') or offer.get('cargoName', ''),
                'qty':         offer_qty,
                'stock':       None if stock >= INFINITE_STOCK else stock,
                'price_parts': price_parts,
            })

    return items


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)

        try:
            px = float(params.get('x', [None])[0])
            pz = float(params.get('z', [None])[0])
        except (TypeError, ValueError):
            self._send(400, {'error': 'x and z (player coordinates) are required'})
            return

        try:
            search_range = float(params.get('range', [DEFAULT_RANGE])[0])
        except (TypeError, ValueError):
            search_range = DEFAULT_RANGE

        region_id = params.get('regionId', [None])[0]

        # Watched trader names — always included regardless of range
        watch_raw  = params.get('watch', [''])[0]
        watch_names = {n.strip().lower() for n in watch_raw.split(',') if n.strip()}

        try:
            PAGE_SIZE = 100
            first     = api_get('/api/stalls', {'limit': PAGE_SIZE, 'page': 1})
            stalls_raw = list(first.get('stalls', []))
            total_pages = first.get('totalPages', 1)

            # Fetch remaining pages in parallel
            if total_pages > 1:
                with ThreadPoolExecutor(max_workers=8) as pool:
                    futures = {
                        pool.submit(api_get, '/api/stalls', {'limit': PAGE_SIZE, 'page': p}): p
                        for p in range(2, total_pages + 1)
                    }
                    for f in as_completed(futures):
                        try:
                            stalls_raw.extend(f.result().get('stalls', []))
                        except Exception:
                            pass

            # Optionally pre-filter by region to reduce work
            if region_id:
                stalls_raw = [s for s in stalls_raw if str(s.get('regionId', '')) == str(region_id)]

            # Build claim → coords map from stalls that have coordinates.
            # Used to assign a fallback position to null-coord barter stalls.
            claim_coords = {}
            for s in stalls_raw:
                cx, cz, cn = s.get('locationX'), s.get('locationZ'), s.get('claimName')
                if cx is not None and cz is not None and cn and cn not in claim_coords:
                    claim_coords[cn] = (float(cx), float(cz))

            # Nearest claim to player (from coord stalls)
            fallback_x, fallback_z, fallback_name = px, pz, None
            fallback_dist = float('inf')
            for cname, (cx, cz) in claim_coords.items():
                d = distance(px, pz, cx, cz)
                if d < fallback_dist:
                    fallback_dist, fallback_x, fallback_z, fallback_name = d, cx, cz, cname

            nearby         = []   # all stalls within range (for minimap)
            all_with_dist  = []   # all stalls globally with distance, for nearest market

            for stall in stalls_raw:
                sx = stall.get('locationX')
                sz = stall.get('locationZ')
                if sx is None or sz is None:
                    # Barter stall with no coordinates — pin to nearest claim if in player's region
                    if region_id and str(stall.get('regionId', '')) == str(region_id) and fallback_name:
                        sx, sz = fallback_x, fallback_z
                    else:
                        continue

                dist  = distance(px, pz, float(sx), float(sz))
                items = parse_sell_items(stall, dist)
                owner = stall.get('ownerName', '')

                entry = {
                    'name':      stall.get('nickname') or owner or 'Stall',
                    'owner':     owner,
                    'claimName': stall.get('claimName') or fallback_name or '',
                    'distance':  round(dist),
                    'x':         float(sx),
                    'z':         float(sz),
                    'items':     items,
                    'watched':   owner.lower() in watch_names,
                }

                if items:
                    all_with_dist.append(entry)

                if dist <= search_range or entry['watched']:
                    nearby.append(entry)

            nearby.sort(key=lambda s: s['distance'])
            all_with_dist.sort(key=lambda s: s['distance'])

            # Build nearest market: the closest claim with stalls
            nearest_market = None
            if all_with_dist:
                nearest_claim_name = all_with_dist[0]['claimName']
                # Collect all stalls at that claim
                claim_stalls = [s for s in all_with_dist if s['claimName'] == nearest_claim_name]
                # Build item price map: item_id → {name, minPrice, totalQty}
                price_map = {}
                for cs in claim_stalls:
                    for it in cs['items']:
                        k = it['id']
                        if k not in price_map:
                            price_map[k] = {'name': it['name'], 'listings': []}
                        # Find coin price (Hex Coin = itemId 1) for sorting; fall back to first part qty
                        parts = it.get('price_parts', [])
                        price_map[k]['listings'].append({
                            'price_parts': parts,
                            'qty':         it['qty'],
                            'stock':       it['stock'],
                            'owner':       cs['owner'],
                        })

                nearest_market = {
                    'claimName':  nearest_claim_name,
                    'distance':   all_with_dist[0]['distance'],
                    'stallCount': len(claim_stalls),
                    'items':      price_map,
                }

            # Collect all owner names for autocomplete
            owner_names = sorted({
                s.get('ownerName') or s.get('nickname', '')
                for s in stalls_raw
                if s.get('ownerName') or s.get('nickname')
            })

            self._send(200, {
                'stalls':        nearby,
                'count':         len(nearby),
                'range':         search_range,
                'nearestMarket': nearest_market,
                'ownerNames':    owner_names,
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
