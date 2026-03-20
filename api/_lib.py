"""
Shared utilities for Traveler Tasks Assistant API functions.
"""

import json
import math
import urllib.request
import urllib.parse

API_BASE = 'https://bitjita.com'
HEADERS = {
    'User-Agent':        'BitJita (Billard)',
    'x-app-identifier': 'BitcraftTasks',
    'Accept':            'application/json',
}


def api_get(path, params=None):
    url = f'{API_BASE}{path}'
    if params:
        url += '?' + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def cors_headers():
    return {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type':                 'application/json',
    }


def get_player(username):
    """
    Two-step lookup: search by username → full profile for position.
    Returns {id, username, locationX, locationZ, regionId, claimName, claimId} or None.
    """
    data    = api_get('/api/players', {'q': username, 'limit': 5})
    players = data.get('players', [])
    match   = next((p for p in players if p.get('username', '').lower() == username.lower()), None)
    if not match and players:
        match = players[0]
    if not match:
        return None

    player_id = str(match['entityId'])

    profile = api_get(f'/api/players/{player_id}')
    p       = profile.get('player', {})
    loc     = p.get('location') or {}

    return {
        'id':        player_id,
        'username':  p.get('username', username),
        'locationX': p.get('locationX'),
        'locationZ': p.get('locationZ'),
        'regionId':  p.get('regionId'),
        'claimName': loc.get('name'),
        'claimId':   str(loc['entityId']) if loc.get('entityId') else None,
    }


def build_inv_map(inv_data):
    """
    Build {item_id_str: total_qty} from a player inventories response.
    Counts across all inventory bags/pockets.
    """
    totals = {}
    for bag in inv_data.get('inventories', []):
        for pocket in bag.get('pockets', []):
            c = pocket.get('contents')
            if not c:
                continue
            k = str(c['itemId'])
            totals[k] = totals.get(k, 0) + c.get('quantity', 0)
    return totals


def build_name_maps(items_data, cargo_data):
    """
    Build {id_str: name_str} maps from /api/items and /api/cargo responses.
    Handles both array [{id, name}] and dict {id: {name}} formats.
    Also handles the tasks-embedded catalog format {id: {name, ...}}.
    """
    def _parse(data):
        m = {}
        if not data:
            return m
        if isinstance(data, list):
            for it in data:
                if it and it.get('id') is not None:
                    m[str(it['id'])] = it.get('name', '')
        elif isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, dict) and v.get('name'):
                    m[str(k)] = v['name']
                elif isinstance(v, str):
                    m[str(k)] = v
        return m

    return _parse(items_data), _parse(cargo_data)


def get_craft_info(item_id, item_type, needed_qty, inv_map, items_map, cargo_map):
    """
    Fetch crafting recipe and check inventory against ingredients.
    Returns {status: 'yes'|'partial'|'no'|'none', details: [...], building: str}.
    """
    endpoint = f'/api/cargo/{item_id}' if item_type == 'cargo' else f'/api/items/{item_id}'
    try:
        d = api_get(endpoint)
    except Exception:
        return {'status': 'none', 'details': [], 'building': ''}

    recipes = d.get('craftingRecipes', [])
    if not recipes:
        return {'status': 'none', 'details': [], 'building': ''}

    recipe = next(
        (r for r in recipes if any(str(o.get('item_id')) == item_id for o in r.get('craftedItemStacks', []))),
        recipes[0]
    )
    inputs = recipe.get('consumedItemStacks', [])
    if not inputs:
        return {'status': 'none', 'details': [], 'building': ''}

    out_qty = next(
        (o.get('quantity', 1) for o in recipe.get('craftedItemStacks', []) if str(o.get('item_id')) == item_id),
        recipe.get('outputQuantity', 1)
    ) or 1
    runs = math.ceil(needed_qty / out_qty)

    all_ok = True
    any_ok = False
    details = []
    for inp in inputs:
        ing_id  = str(inp.get('item_id', ''))
        ing_qty = (inp.get('quantity') or 1) * runs
        have    = inv_map.get(ing_id, 0)
        name    = items_map.get(ing_id) or cargo_map.get(ing_id) or inp.get('name') or ing_id
        if have >= ing_qty:
            any_ok = True
        else:
            all_ok = False
        details.append({'id': ing_id, 'name': name, 'need': ing_qty, 'have': have})

    status = 'yes' if all_ok else ('partial' if any_ok else 'no')
    return {'status': status, 'details': details, 'building': recipe.get('buildingName', '')}


def distance(x1, z1, x2, z2):
    return math.sqrt((x2 - x1) ** 2 + (z2 - z1) ** 2)
