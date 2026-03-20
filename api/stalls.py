"""
GET /api/stalls?n=X&e=Y&range=N

Fetches all stalls from BitJita, filters to those within `range` game units
of the given N/E coordinates, and returns them sorted by distance with their
item listings.
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


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)

        try:
            n      = float(params.get('n', [None])[0])
            e      = float(params.get('e', [None])[0])
        except (TypeError, ValueError):
            self._send(400, {'error': 'n and e (player coordinates) are required'})
            return

        try:
            search_range = float(params.get('range', [DEFAULT_RANGE])[0])
        except (TypeError, ValueError):
            search_range = DEFAULT_RANGE

        try:
            data  = api_get('/api/stalls')
            stalls_raw = data.get('stalls') or data.get('data') or (data if isinstance(data, list) else [])

            nearby = []
            for stall in stalls_raw:
                # Normalise position — field names may vary
                pos = stall.get('position') or stall.get('location') or stall.get('coords') or {}
                sn  = pos.get('n') or pos.get('northing') or stall.get('n') or stall.get('northing')
                se  = pos.get('e') or pos.get('easting')  or stall.get('e') or stall.get('easting')

                if sn is None or se is None:
                    continue

                dist = distance(n, e, float(sn), float(se))
                if dist > search_range:
                    continue

                # Normalise items list
                items_raw = stall.get('items') or stall.get('inventory') or stall.get('contents') or []
                items = []
                for it in items_raw:
                    item_id = str(it.get('itemId') or it.get('item_id') or it.get('id') or '')
                    qty     = it.get('quantity') or it.get('qty') or 0
                    price   = it.get('price') or it.get('unitPrice') or it.get('sell_price') or None
                    if item_id:
                        items.append({'id': item_id, 'qty': qty, 'price': price})

                nearby.append({
                    'name':     stall.get('name') or stall.get('stallName') or 'Stall',
                    'owner':    stall.get('owner') or stall.get('ownerName') or stall.get('username') or '',
                    'distance': round(dist),
                    'position': {'n': sn, 'e': se},
                    'items':    items,
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
