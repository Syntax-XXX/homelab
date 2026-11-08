#!/usr/bin/env python3
"""Minimal authenticated Docker API gateway for the selfhost dashboard.
Only an allow-list of read endpoints (Bearer token) and start/stop/restart (+ X-Action-Token) are passed through."""
import hmac, http.client, os, re, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = open("/etc/selfhost-dash/token").read().strip()
ATOKEN = open("/etc/selfhost-dash/action_token").read().strip()
BIND, PORT = os.environ.get("BIND", "127.0.0.1"), int(os.environ.get("PORT", "9102"))  # LAN-IP per BIND setzen
ID = r"[0-9a-f]{12,64}"
READ = [re.compile(p) for p in (r"^/containers/json(\?[\w=&%.-]*)?$", rf"^/containers/{ID}/(json|stats)(\?[\w=&%.-]*)?$",
                                rf"^/containers/{ID}/logs\?[\w=&%.-]*$", r"^/_ping$")]
WRITE = [re.compile(rf"^/containers/{ID}/(start|stop|restart)(\?t=\d{{1,3}})?$")]

class UnixConn(http.client.HTTPConnection):
    def __init__(self): super().__init__("localhost", timeout=300)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); self.sock.settimeout(300)
        self.sock.connect("/var/run/docker.sock")

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _auth(self, write):
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN): return False
        return not write or hmac.compare_digest(self.headers.get("X-Action-Token", ""), ATOKEN)
    def _proxy(self, method, rules, write):
        if not self._auth(write): self.send_response(401); self.end_headers(); return
        if not any(r.match(self.path) for r in rules): self.send_response(403); self.end_headers(); return
        c = UnixConn(); c.request(method, self.path); r = c.getresponse()
        self.send_response(r.status)
        ct = r.getheader("Content-Type")
        if ct: self.send_header("Content-Type", ct)
        self.end_headers()
        try:
            while True:
                chunk = r.read1(65536)
                if not chunk: break
                self.wfile.write(chunk); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError): pass
        finally: c.close()
    def do_GET(self): self._proxy("GET", READ, False)
    def do_POST(self): self._proxy("POST", WRITE, True)

ThreadingHTTPServer((BIND, PORT), H).serve_forever()
