"""
Read-only snapshots of the game's tables from BitJita's relay, a live SpacetimeDB replica (one database
per region, idc-<region>). Used instead of BitJita's per-item market endpoints: one relay read gives every
sell order in a region, where BitJita needs a call per item.

Standard library only (Vercel's Python runtime has no websocket client): a minimal WebSocket client that
subscribes, takes the InitialSubscription snapshot and hangs up.

BitJita's relay is tried first; relay.bitcraftsync.app only when it doesn't answer. Snapshots are kept
for SNAPSHOT_TTL seconds per warm function instance.
"""

import base64
import json
import os
import socket
import ssl
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

REGIONS      = {7: 'Talora', 8: 'Ossura', 9: 'Serek', 12: 'Dalen', 13: 'Hexalis', 14: 'Evara',
                17: 'Morven', 18: 'Keldan', 19: 'Veska'}
RELAYS       = [('relay.bitjita.com', None), ('relay.bitcraftsync.app', 3000)]   # (host, port base)
TIMEOUT_S    = 12
SNAPSHOT_TTL = 60

# Column order of each table we read. BitJita's relay sends rows as arrays in this order; the backup sends
# objects keyed by column name. Rows come back as dicts either way.
COLUMNS = {
    'sell_order_state':      ['entity_id', 'owner_entity_id', 'claim_entity_id', 'item_id', 'item_type',
                              'price_threshold', 'quantity', 'timestamp', 'stored_coins'],
    'claim_state':           ['entity_id', 'owner_player_entity_id', 'owner_building_entity_id', 'name', 'neutral'],
    'claim_local_state':     ['entity_id', 'supplies', 'building_maintenance', 'num_tiles', 'num_tile_neighbors',
                              'location', 'treasury', 'xp_gained_since_last_coin_minting',
                              'supplies_purchase_threshold', 'supplies_purchase_price', 'building_description_id'],
    'player_username_state': ['entity_id', 'username'],
}


class RelayError(Exception):
    pass


# ── Minimal WebSocket client ──────────────────────────────────────────────────

class _Socket:
    def __init__(self, url, protocol, timeout):
        u    = urlparse(url)
        host = u.hostname
        port = u.port or 443
        raw  = socket.create_connection((host, port), timeout=timeout)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        self.sock.settimeout(timeout)
        key  = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (f'?{u.query}' if u.query else '')
        self.sock.sendall((
            f'GET {path} HTTP/1.1\r\nHost: {u.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: {protocol}\r\n\r\n'
        ).encode())
        self.buf = b''
        while b'\r\n\r\n' not in self.buf:
            self._fill()
        head, self.buf = self.buf.split(b'\r\n\r\n', 1)
        status = head.split(b'\r\n', 1)[0]
        if b' 101 ' not in status + b' ':
            raise RelayError(f'handshake refused: {status.decode(errors="replace")}')

    def _fill(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise RelayError('connection closed')
        self.buf += chunk

    def _take(self, n):
        while len(self.buf) < n:
            self._fill()
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode, data):
        head = bytes([0x80 | opcode])
        n    = len(data)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        mask = os.urandom(4)
        self.sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send_text(self, text):
        self._send_frame(0x1, text.encode())

    def recv_text(self):
        parts = []
        while True:
            b0, b1 = self._take(2)
            opcode, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._take(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._take(8))[0]
            mask = self._take(4) if b1 & 0x80 else None
            data = self._take(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                raise RelayError('closed by relay')
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            parts.append(data)
            if b0 & 0x80:
                return b''.join(parts).decode()

    def close(self):
        try:
            self._send_frame(0x8, b'')
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


# ── Snapshots ─────────────────────────────────────────────────────────────────

def _url(host, port_base, region):
    port = f':{port_base + max(region, 0)}' if port_base else ''
    db   = 'idc-global' if region < 0 else f'idc-{region}'
    return f'wss://{host}{port}/v1/database/{db}/subscribe?compression=None&light=true'


def _row(table, raw):
    v = json.loads(raw) if isinstance(raw, str) else raw
    if isinstance(v, dict):
        return v
    return dict(zip(COLUMNS.get(table, []), v))


def _subscribe(url, queries):
    ws = _Socket(url, 'v1.json.spacetimedb', TIMEOUT_S)
    try:
        ws.send_text(json.dumps({'Subscribe': {'query_strings': queries, 'request_id': 1}}))
        while True:
            msg = json.loads(ws.recv_text())
            if 'SubscriptionError' in msg:
                raise RelayError(msg['SubscriptionError'].get('error') or 'subscription refused')
            init = msg.get('InitialSubscription')
            if init:
                out = {}
                for t in init['database_update']['tables']:
                    rows = out.setdefault(t['table_name'], [])
                    for u in t.get('updates') or []:
                        rows.extend(_row(t['table_name'], r) for r in u.get('inserts') or [])
                return out
    finally:
        ws.close()


def snapshot(region, queries):
    """{table: [row dict]} for the queries on one region's database. Raises RelayError if no relay answers."""
    last = None
    for host, port_base in RELAYS:
        try:
            return _subscribe(_url(host, port_base, region), queries)
        except Exception as e:   # refused, timed out, or dropped: try the next relay
            last = e
    raise RelayError(f'region {region}: {last}')


_cache, _cache_lock = {}, threading.Lock()


def _cached(key, fetch):
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < SNAPSHOT_TTL:
            return hit[1]
    value = fetch()
    with _cache_lock:
        _cache[key] = (now, value)
    return value


def _option(v):
    """SpacetimeDB option: [0, value] is some, [1, []] is none."""
    return v[1] if isinstance(v, list) and len(v) == 2 and v[0] == 0 else None


def region_market(region):
    """
    One region's sell orders in BitJita's /api/market shape, by (item_id_str, 'item'|'cargo'), plus its
    claims: ({key: [order]}, {claim_id: {id, name, x, z, neutral}}).
    """
    def fetch():
        t = snapshot(region, [
            'SELECT * FROM sell_order_state',
            'SELECT * FROM claim_state',
            'SELECT * FROM claim_local_state',
            'SELECT * FROM player_username_state',
        ])
        names = {str(p['entity_id']): p.get('username') or '' for p in t.get('player_username_state', [])}
        where = {}
        for c in t.get('claim_local_state', []):
            loc = _option(c.get('location'))
            if isinstance(loc, list):
                loc = {'x': loc[0], 'z': loc[1]}
            if isinstance(loc, dict) and loc.get('x') is not None:
                where[str(c['entity_id'])] = (float(loc['x']), float(loc['z']))
        claims = {}
        for c in t.get('claim_state', []):
            cid = str(c['entity_id'])
            x, z = where.get(cid, (None, None))
            claims[cid] = {'id': cid, 'name': c.get('name') or '', 'x': x, 'z': z, 'neutral': bool(c.get('neutral'))}
        orders = {}
        for o in t.get('sell_order_state', []):
            cid   = str(o['claim_entity_id'])
            claim = claims.get(cid) or {}
            kind  = 'cargo' if o.get('item_type') == 1 else 'item'
            orders.setdefault((str(o['item_id']), kind), []).append({
                'claimEntityId':  cid,
                'claimName':      claim.get('name', ''),
                'claimLocationX': claim.get('x'),
                'claimLocationZ': claim.get('z'),
                'regionId':       region,
                'regionName':     REGIONS.get(region, ''),
                'ownerEntityId':  str(o['owner_entity_id']),
                'ownerUsername':  names.get(str(o['owner_entity_id']), ''),
                'priceThreshold': o.get('price_threshold'),
                'quantity':       o.get('quantity'),
            })
        return orders, claims
    return _cached(('market', region), fetch)


def markets(regions=None):
    """
    region_market for several regions (all by default), read in parallel.
    Returns ({region: (orders, claims)}, [regions that failed]).
    """
    regions = list(regions or REGIONS)
    out, failed = {}, []
    with ThreadPoolExecutor(max_workers=len(regions) or 1) as pool:
        futures = {r: pool.submit(region_market, r) for r in regions}
        for r, f in futures.items():
            try:
                out[r] = f.result()
            except Exception:
                failed.append(r)
    return out, failed
