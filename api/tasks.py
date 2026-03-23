"""
GET /api/tasks?player_id=X&claim_id=Y

Returns all incomplete traveler tasks for a player, enriched with:
- Item names (from /api/items + /api/cargo catalogs)
- Player inventory counts per item
- Crafting status per item (yes/partial/no/none)
- Market price at the given claim (lowestSell from /api/market/item/{id})
"""

import json
import sys
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(__file__))
from _lib import api_get, build_inv_map, build_inv_detail_map, build_name_maps, get_craft_info, get_market_price, cors_headers


def build_tasks(tasks_data, inv_map, inv_detail, items_map, cargo_map):
    tasks = []
    for task in tasks_data.get('tasks', []):
        if task.get('completed'):
            continue

        traveler = (task.get('description') or '').split(' ')[0] or '?'
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

        tasks.append({
            'traveler':    traveler,
            'description': task.get('description', ''),
            'reward':      reward,
            'items':       items,
        })

    return tasks


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params    = parse_qs(urlparse(self.path).query)
        player_id = params.get('player_id', [''])[0].strip()
        try:
            px = float(params.get('x', [None])[0])
            pz = float(params.get('z', [None])[0])
        except (TypeError, ValueError):
            px = pz = None

        if not player_id:
            self._send(400, {'error': 'player_id parameter is required'})
            return

        try:
            # Fetch all data in parallel
            results = {}
            with ThreadPoolExecutor(max_workers=5) as pool:
                futures = {
                    pool.submit(api_get, f'/api/players/{player_id}/traveler-tasks'): 'tasks',
                    pool.submit(api_get, f'/api/players/{player_id}/inventories'):    'inv',
                    pool.submit(api_get, '/api/items'):                               'items',
                    pool.submit(api_get, '/api/cargo'):                               'cargo',
                }
                for f in as_completed(futures):
                    key = futures[f]
                    try:
                        results[key] = f.result()
                    except Exception:
                        results[key] = {} if key in ('tasks', 'inv') else []

            tasks_data = results.get('tasks', {})
            inv_data   = results.get('inv', {})
            items_data = results.get('items', [])
            cargo_data = results.get('cargo', [])

            inv_map              = build_inv_map(inv_data)
            inv_detail           = build_inv_detail_map(inv_data)
            items_map, cargo_map = build_name_maps(items_data, cargo_data)

            tasks = build_tasks(tasks_data, inv_map, inv_detail, items_map, cargo_map)

            if not tasks:
                self._send(200, {'tasks': [], 'expiry': tasks_data.get('expirationTimestamp')})
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

            # Enrich market prices using nearest-claim sell orders
            if px is not None and pz is not None:
                unique_items = {(item['id'], item['type']) for t in tasks for item in t['items']}
                price_map = {}
                with ThreadPoolExecutor(max_workers=10) as pool:
                    futures = {
                        pool.submit(get_market_price, iid, itype, px, pz): iid
                        for iid, itype in unique_items
                    }
                    for f in as_completed(futures):
                        iid = futures[f]
                        try:
                            price_map[iid] = f.result()
                        except Exception:
                            price_map[iid] = None
                for t in tasks:
                    for item in t['items']:
                        item['market_price'] = price_map.get(item['id'])

            self._send(200, {
                'tasks':  tasks,
                'expiry': tasks_data.get('expirationTimestamp'),
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
