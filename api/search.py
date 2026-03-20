"""
GET /api/search?username=X

Returns player ID, username, and position (N/E coords).
"""

import json
import sys
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(__file__))
from _lib import get_player, cors_headers


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params   = parse_qs(urlparse(self.path).query)
        username = params.get('username', [''])[0].strip()

        if not username:
            self._send(400, {'error': 'username parameter is required'})
            return

        try:
            player = get_player(username)
            if not player:
                self._send(404, {'error': f'Player "{username}" not found'})
                return
            self._send(200, player)
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
