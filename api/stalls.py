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

sys.path.insert(0, os.path.dirname(__file__))
from _lib import api_get, distance, cors_headers

DEFAULT_RANGE  = 1000
INFINITE_STOCK = 2_000_000_000


def parse_sell_items(stall, dist):
    """Extract sell-side orders from a stall into a flat item list."""
    items = []
    for order in stall.get('orders', []):
        stock    = order.get('remainingStock', 0)
        req      = order.get('requiredItems', [])
        req_c    = order.get('requiredCargo', [])
        price      = req[0].get('quantity')   if req   else None
        price_item = req[0].get('itemName','') if req   else (req_c[0].get('cargoName','') if req_c else '')

        for offer in order.get('offerItems', []):
            item_id = str(offer.get('itemId', ''))
            if not item_id:
                continue
            items.append({
                'id':         item_id,
                'name':       offer.get('itemName', ''),
                'qty':        offer.get('quantity', 1),
                'stock':      None if stock >= INFINITE_STOCK else stock,
                'price':      price,
                'price_item': price_item,
            })

        for offer in order.get('offerCargo', []):
            cargo_id = str(offer.get('cargoId', '') or offer.get('itemId', ''))
            if not cargo_id:
                continue
            items.append({
                'id':         cargo_id,
                'name':       offer.get('cargoName', '') or offer.get('itemName', ''),
                'qty':        offer.get('quantity', 1),
                'stock':      None if stock >= INFINITE_STOCK else stock,
                'price':      price,
                'price_item': price_item,
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

        try:
            data       = api_get('/api/stalls')
            stalls_raw = data.get('stalls') or (data if isinstance(data, list) else [])

            # Optionally pre-filter by region to reduce work
            if region_id:
                stalls_raw = [s for s in stalls_raw if str(s.get('regionId', '')) == str(region_id)]

            nearby         = []   # stalls within configured range
            all_with_dist  = []   # all stalls with distance, for nearest market

            for stall in stalls_raw:
                sx = stall.get('locationX')
                sz = stall.get('locationZ')
                if sx is None or sz is None:
                    continue

                dist  = distance(px, pz, float(sx), float(sz))
                items = parse_sell_items(stall, dist)
                if not items:
                    continue

                entry = {
                    'name':      stall.get('nickname') or stall.get('ownerName', 'Stall'),
                    'owner':     stall.get('ownerName', ''),
                    'claimName': stall.get('claimName', ''),
                    'distance':  round(dist),
                    'items':     items,
                }

                all_with_dist.append(entry)

                if dist <= search_range:
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
                            price_map[k] = {'name': it['name'], 'minPrice': None, 'totalQty': 0}
                        e = price_map[k]
                        if it['price'] is not None:
                            if e['minPrice'] is None or it['price'] < e['minPrice']:
                                e['minPrice'] = it['price']
                        if it['stock'] is not None:
                            e['totalQty'] += it['stock']
                        elif it['qty']:
                            e['totalQty'] += it['qty']

                nearest_market = {
                    'claimName':  nearest_claim_name,
                    'distance':   all_with_dist[0]['distance'],
                    'stallCount': len(claim_stalls),
                    'items':      price_map,
                }

            self._send(200, {
                'stalls':        nearby,
                'count':         len(nearby),
                'range':         search_range,
                'nearestMarket': nearest_market,
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
