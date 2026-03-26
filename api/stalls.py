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
from _lib import api_get, distance, cors_headers, build_inv_map

INFINITE_STOCK = 2_000_000_000


def parse_sell_items(stall, dist):
    """Extract sell-side orders from a stall into a flat item list, one entry per item (cheapest)."""
    # item_id → best entry (lowest Hex Coin price, or first if no coin price)
    best = {}

    def _coin_price(parts):
        for p in parts:
            if p['name'] == 'Hex Coin':
                return p['qty']
        return float('inf')

    def _upsert(item_id, name, offer_qty, stock, price_parts):
        entry = {
            'id':          item_id,
            'name':        name,
            'qty':         offer_qty,
            'stock':       stock,
            'price_parts': price_parts,
        }
        if item_id not in best or _coin_price(price_parts) < _coin_price(best[item_id]['price_parts']):
            best[item_id] = entry

    for order in stall.get('orders', []):
        stock = order.get('remainingStock', 0)
        # Skip orders with no stock (but keep infinite-stock orders)
        if stock == 0:
            continue
        req   = order.get('requiredItems', [])
        req_c = order.get('requiredCargo', [])

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
            price_parts = [
                {'qty': round(p['qty'] / offer_qty), 'name': p['name']}
                for p in raw_price_parts
            ]
            _upsert(item_id, offer.get('itemName', ''), offer_qty,
                    None if stock >= INFINITE_STOCK else stock, price_parts)

        for offer in order.get('offerCargo', []):
            cargo_id  = str(offer.get('itemId', '') or offer.get('cargoId', ''))
            offer_qty = max(offer.get('quantity', 1), 1)
            if not cargo_id:
                continue
            price_parts = [
                {'qty': round(p['qty'] / offer_qty), 'name': p['name']}
                for p in raw_price_parts
            ]
            _upsert(cargo_id, offer.get('itemName', '') or offer.get('cargoName', ''),
                    offer_qty, None if stock >= INFINITE_STOCK else stock, price_parts)

    return list(best.values())


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
            claim_coords = {}
            for s in stalls_raw:
                cx, cz, cn = s.get('locationX'), s.get('locationZ'), s.get('claimName')
                if cx is not None and cz is not None and cn and cn not in claim_coords:
                    claim_coords[cn] = (float(cx), float(cz))

            nearby        = []   # watched trader stands only
            all_with_dist = []   # all coord stalls with sell orders, for nearest market

            for stall in stalls_raw:
                owner = stall.get('ownerName', '') or ''
                if not owner:
                    continue   # skip barter stalls — covered by claim inventory API

                nickname   = stall.get('nickname', '') or ''
                is_watched = bool(watch_names and (
                    owner.lower()    in watch_names or
                    nickname.lower() in watch_names
                ))

                sx = stall.get('locationX')
                sz = stall.get('locationZ')
                has_coords = sx is not None and sz is not None
                dist = distance(px, pz, float(sx), float(sz)) if has_coords else None

                items = parse_sell_items(stall, dist or 0)

                entry = {
                    'name':          nickname or owner or 'Stall',
                    'owner':         owner,
                    'ownerEntityId': stall.get('ownerEntityId', '') or '',
                    'stallEntityId': stall.get('entityId', '') or '',
                    'claimName':     stall.get('claimName', ''),
                    'distance':      round(dist) if dist is not None else None,
                    'x':             float(sx) if has_coords else None,
                    'z':             float(sz) if has_coords else None,
                    'items':         items,
                    'watched':       is_watched,
                }

                if items and has_coords:
                    all_with_dist.append(entry)

                if is_watched:
                    nearby.append(entry)

            nearby.sort(key=lambda s: (s['distance'] is None, s['distance'] or 0))
            all_with_dist.sort(key=lambda s: s['distance'])

            # Cross-check watched stall items against owner's live inventory.
            # Removes listings where the owner has 0 of the item anywhere (stale remainingStock).
            watched_eids = {s['ownerEntityId'] for s in nearby if s.get('ownerEntityId')}
            if watched_eids:
                def _fetch_inv(eid):
                    try:
                        return eid, api_get(f'/api/players/{eid}/inventories')
                    except Exception:
                        return eid, {}

                with ThreadPoolExecutor(max_workers=5) as pool:
                    raw_inv_maps = dict(pool.map(_fetch_inv, watched_eids))

                for s in nearby:
                    eid = s.get('ownerEntityId', '')
                    if eid and eid in raw_inv_maps:
                        # Check only the specific stall container; fall back to all bags
                        inv = build_inv_map(raw_inv_maps[eid], s.get('stallEntityId'))
                        s['items'] = [it for it in s['items'] if inv.get(str(it['id']), 0) > 0]

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

            # Fetch barter stall inventory from the specified claim
            claim_id         = params.get('claimId',    [None])[0]
            claim_name_param = params.get('claimName',  [''])[0]
            barter_sources   = []
            if claim_id:
                try:
                    inv = api_get(f'/api/claims/{claim_id}/inventories')
                    def _lut(lst):
                        out = {}
                        for it in (lst or []):
                            iid = str(it.get('id') or it.get('itemId') or it.get('cargoId') or '')
                            nm  = it.get('name') or it.get('itemName') or it.get('cargoName') or ''
                            if iid:
                                out[iid] = nm
                        return out
                    items_lut  = _lut(inv.get('items',  []))
                    cargos_lut = _lut(inv.get('cargos', []))
                    barter_claim_name = claim_name_param or (nearest_market['claimName'] if nearest_market else '')

                    for bldg in inv.get('buildings', []):
                        bname = bldg.get('buildingName', '') or ''
                        if 'barter' not in bname.lower() and 'counter' not in bname.lower():
                            continue
                        nickname = bldg.get('buildingNickname') or bname
                        stall_items = {}
                        for slot in bldg.get('inventory', []):
                            # API may wrap in 'contents' or expose fields directly
                            c = slot.get('contents') or slot
                            item_id = str(c.get('itemId') or c.get('item_id') or '')
                            qty     = c.get('quantity') or c.get('qty') or 0
                            itype   = c.get('type') or c.get('itemType') or c.get('item_type') or 'item'
                            iname   = c.get('itemName') or c.get('cargoName') or c.get('name') or ''
                            if item_id and qty > 0:
                                lut = cargos_lut if itype == 'cargo' else items_lut
                                if item_id not in stall_items:
                                    stall_items[item_id] = {'name': iname or lut.get(item_id, ''), 'qty': 0, 'type': itype}
                                stall_items[item_id]['qty'] += qty

                        if stall_items:
                            # Distance to selected claim (raw units; frontend divides by 3)
                            if barter_claim_name and barter_claim_name in claim_coords:
                                cx, cz = claim_coords[barter_claim_name]
                                dist_to_claim = round(distance(px, pz, cx, cz))
                            elif nearest_market:
                                dist_to_claim = nearest_market['distance']
                            else:
                                dist_to_claim = 0
                            barter_sources.append({
                                'nickname':  nickname,
                                'claimName': barter_claim_name,
                                'distance':  dist_to_claim,
                                'items':     stall_items,
                            })
                except Exception:
                    pass

            # Collect all owner names for autocomplete
            owner_names = sorted({
                s.get('ownerName') or s.get('nickname', '')
                for s in stalls_raw
                if s.get('ownerName') or s.get('nickname')
            })

            self._send(200, {
                'stalls':        nearby,
                'count':         len(nearby),
                'nearestMarket': nearest_market,
                'ownerNames':    owner_names,
                'barterSources': barter_sources,
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
