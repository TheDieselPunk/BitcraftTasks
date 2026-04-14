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
import urllib.parse
from _lib import api_get, build_inv_map, build_inv_detail_map, build_name_maps, get_craft_info, get_market_price, get_market_prices_for_claims, get_player_housing_items, cors_headers


TRAVELER_SKILL = {
    'Svim':     'Sailing',
    'Rumbagh':  'Merchanting',
    'Ramparte': 'Slayer',
    'Heimlich': 'Cooking',
    'Brico':    'Building',
    'Alesi':    'Taming',
}


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

        exp      = task.get('rewardedExperience') or {}
        tasks.append({
            'traveler':    traveler,
            'description': task.get('description', ''),
            'reward':      reward,
            'exp_qty':     exp.get('quantity', 0),
            'exp_skill_id': str(exp.get('skill_id', '')),
            'skill_name':  TRAVELER_SKILL.get(traveler, traveler),
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
            with ThreadPoolExecutor(max_workers=6) as pool:
                futures = {
                    pool.submit(api_get, f'/api/players/{player_id}/traveler-tasks'): 'tasks',
                    pool.submit(api_get, f'/api/players/{player_id}/inventories'):    'inv',
                    pool.submit(api_get, '/api/items'):                               'items',
                    pool.submit(api_get, '/api/cargo'):                               'cargo',
                    pool.submit(get_player_housing_items, player_id):                 'housing',
                }
                for f in as_completed(futures):
                    key = futures[f]
                    try:
                        results[key] = f.result()
                    except Exception:
                        results[key] = {} if key in ('tasks', 'inv') else []

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
