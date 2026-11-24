"""
Traveler trades (the game's traveler_trade_order_desc: Brico's house deeds, Rumbagh's sandpaper...) and the
player's secondary knowledge (what unlocks or hides a trade), read off the relay.

A trade is open to a player when they have every required knowledge, none of the blocking ones, and the
skill levels. Travelers are everywhere, and every copy of a traveler sells the same trades.
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import _relay

TRADES_TTL = 6 * 3600   # static game data: changes with game patches only
UNLIMITED  = 2147483647
HEX_COIN   = 1

TRAVELER_NAMES = ['', 'Rumbagh', 'Svim', 'Heimlich', 'The Twins', 'Brico', 'Alesi', 'Ramparte']
SKILL_NAMES    = {13: 'Cooking', 15: 'Construction', 17: 'Taming', 18: 'Slayer', 19: 'Merchanting', 21: 'Sailing'}

_relay.COLUMNS.update({
    'traveler_trade_order_desc': ['id', 'starting_stock', 'always_offered', 'traveler', 'offer_items', 'offer_cargo_id',
                                  'required_items', 'required_cargo_id', 'level_requirements', 'achievement_requirements',
                                  'hide_if_requirements_are_not_met', 'required_knowledges', 'hide_without_required_knowledge',
                                  'blocking_knowledges', 'hide_with_blocking_knowledges'],
    'secondary_knowledge_desc':  ['id', 'name'],
    'knowledge_secondary_state': ['entity_id', 'entries'],
})

_lock  = threading.Lock()
_cache = {}


def _cached(key, ttl, fetch):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = fetch()
    with _lock:
        _cache[key] = (now, value)
    return value


def _tag(v):
    """A SpacetimeDB enum value, [tag, payload], as its tag."""
    return v[0] if isinstance(v, list) and v else v


def _stack(s):
    """An item stack [item_id, quantity, item_type, durability] as (id, type, qty)."""
    if isinstance(s, dict):
        return str(s.get('item_id')), 'cargo' if _tag(s.get('item_type')) == 1 else 'item', s.get('quantity') or 1
    return str(s[0]), 'cargo' if _tag(s[2]) == 1 else 'item', s[1] or 1


def _levels(reqs):
    out = []
    for r in reqs or []:
        sid, lvl = (r.get('skill_id'), r.get('level')) if isinstance(r, dict) else (r[0], r[1])
        out.append({'skill_id': sid, 'skill': SKILL_NAMES.get(sid, f'Skill {sid}'), 'level': lvl})
    return out


def _any_region(queries, prefer=None):
    """A snapshot of static tables from whichever region answers first (every region holds the same data)."""
    regions = ([int(prefer)] if prefer else []) + [r for r in _relay.REGIONS if str(r) != str(prefer)]
    last = None
    for r in regions:
        try:
            return _relay.snapshot(r, queries)
        except Exception as e:
            last = e
    raise _relay.RelayError(f'no region answered: {last}')


def static_data(prefer_region=None):
    """
    ({trade id: trade}, {knowledge id: name}). trade = {id, traveler, stock, offers: [(id, type, qty)],
    costs: [(id, type, qty)], levels: [{skill_id, skill, level}], achievements, requires, blocks}.
    """
    def fetch():
        t = _any_region(['SELECT * FROM traveler_trade_order_desc', 'SELECT * FROM secondary_knowledge_desc'], prefer_region)
        trades = {}
        for r in t.get('traveler_trade_order_desc', []):
            npc = _tag(r.get('traveler'))
            trades[r['id']] = {
                'id':           r['id'],
                'traveler':     TRAVELER_NAMES[npc] if isinstance(npc, int) and 0 <= npc < len(TRAVELER_NAMES) else str(npc),
                'stock':        r.get('starting_stock'),
                'offers':       [_stack(s) for s in r.get('offer_items') or []] +
                                [(str(c), 'cargo', 1) for c in r.get('offer_cargo_id') or []],
                'costs':        [_stack(s) for s in r.get('required_items') or []] +
                                [(str(c), 'cargo', 1) for c in r.get('required_cargo_id') or []],
                'levels':       _levels(r.get('level_requirements')),
                'achievements': list(r.get('achievement_requirements') or []),
                'requires':     list(r.get('required_knowledges') or []),
                'blocks':       list(r.get('blocking_knowledges') or []),
            }
        names = {k['id']: k['name'] for k in t.get('secondary_knowledge_desc', [])}
        return trades, names
    return _cached(('static',), TRADES_TTL, fetch)


def player_knowledge(player_id, region=None):
    """The secondary knowledge ids the player has acquired, read from their region's database (every region
    is tried, in parallel, when that one doesn't hold them). None if no region has the player."""
    pid = str(player_id or '').strip()
    if not pid.isdigit():
        return None
    query = [f'SELECT * FROM knowledge_secondary_state WHERE entity_id = {pid}']

    def read(r):
        rows = _relay.snapshot(r, query).get('knowledge_secondary_state') or []
        if not rows:
            return None
        return {e[0] if isinstance(e, list) else e.get('id') for e in rows[0].get('entries') or []
                if _tag(e[1] if isinstance(e, list) else e.get('state')) == 2}   # 2 = acquired

    def fetch():
        if region and str(region).isdigit() and int(region) in _relay.REGIONS:
            try:
                got = read(int(region))
                if got is not None:
                    return got
            except Exception:
                pass
        with ThreadPoolExecutor(max_workers=len(_relay.REGIONS)) as pool:
            futures = [pool.submit(read, r) for r in _relay.REGIONS if str(r) != str(region)]
            for f in futures:
                try:
                    got = f.result()
                except Exception:
                    continue
                if got is not None:
                    return got
        return None
    return _cached(('knowledge', pid), 60, fetch)


def is_open(trade, knowledge, levels):
    """(open, why not): can this player take the trade? Unknown knowledge (None) only passes trades that
    don't depend on knowledge; unknown levels pass."""
    if trade['achievements']:
        return False, ['an achievement']
    if trade['requires'] or trade['blocks']:
        if knowledge is None:
            return False, ['unknown knowledge']
        if any(k in knowledge for k in trade['blocks']):
            return False, ['already done']
        if not all(k in knowledge for k in trade['requires']):
            return False, ['knowledge']
    low = [f"{l['skill']} {l['level']}" for l in trade['levels']
           if levels and int(levels.get(str(l['skill_id']), 0)) < l['level']]
    return (not low), low


def coin_trades(knowledge=None, levels=None, prefer_region=None):
    """{(item id, type): [{trade, traveler, bundle, price, units}]} for the trades that give one item
    for Hex Coin alone and that the player can take."""
    trades, _ = static_data(prefer_region)
    out = {}
    for t in trades.values():
        if len(t['offers']) != 1 or len(t['costs']) != 1 or t['costs'][0][:2] != (str(HEX_COIN), 'item'):
            continue
        if not is_open(t, knowledge, levels)[0]:
            continue
        iid, typ, qty = t['offers'][0]
        stock = t['stock'] if t['stock'] is not None else UNLIMITED
        out.setdefault((iid, typ), []).append({
            'trade': t['id'], 'traveler': t['traveler'], 'bundle': max(qty, 1),
            'price': t['costs'][0][2], 'units': 10 ** 9 if stock >= UNLIMITED else max(stock, 0) * max(qty, 1),
        })
    return out
