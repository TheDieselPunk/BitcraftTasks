"""
GET /api/stalls?x=X&z=Z&range=N

Fetches all stalls from BitJita, filters to those within `range` game units
of the given X/Z coordinates, and returns sell-side orders sorted by distance.
"""

import json
import sys
import os
import math
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(__file__))
from _lib import api_get, distance, cors_headers

DEFAULT_RANGE = 500
INFINITE_STOCK = 2_000_000_000  # remainingStock sentinel for unlimited


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

        try:
            data       = api_get('/api/stalls')
            stalls_raw = data.get('stalls') or (data if isinstance(data, list) else [])

            nearby = []
            for stall in stalls_raw:
                sx = stall.get('locationX')
                sz = stall.get('locationZ')
                if sx is None or sz is None:
                    continue

                dist = distance(px, pz, float(sx), float(sz))
                if dist > search_range:
                    continue

                # Parse sell-side orders (offerItems / offerCargo)
                items = []
                for order in stall.get('orders', []):
                    stock    = order.get('remainingStock', 0)
                    req      = order.get('requiredItems', [])
                    req_c    = order.get('requiredCargo', [])

                    # Price: first required item's quantity (usually Hexite Energy = coins)
                    price      = req[0].get('quantity') if req else None
                    price_item = req[0].get('itemName', '') if req else (req_c[0].get('cargoName', '') if req_c else '')

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

                if not items:
                    continue

                nearby.append({
                    'name':      stall.get('nickname') or stall.get('ownerName', 'Stall'),
                    'owner':     stall.get('ownerName', ''),
                    'claimName': stall.get('claimName', ''),
                    'distance':  round(dist),
                    'items':     items,
                })

            nearby.sort(key=lambda s: s['distance'])
            self._send(200, {'stalls': nearby, 'count': len(nearby), 'range': search_range})

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
