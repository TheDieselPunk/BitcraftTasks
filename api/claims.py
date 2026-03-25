"""
GET /api/claims?regionId=R

Proxies the BitJita claims endpoint so the frontend can inspect the raw response.
"""

import json
import sys
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(__file__))
from _lib import api_get, cors_headers


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._send(200, {})

    def do_GET(self):
        params    = parse_qs(urlparse(self.path).query)
        region_id = params.get('regionId', [None])[0]
        try:
            api_params = {'regionId': region_id} if region_id else {}
            data = api_get('/api/claims', api_params)
            self._send(200, data)
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
