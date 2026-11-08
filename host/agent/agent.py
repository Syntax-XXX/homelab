#!/usr/bin/env python3
"""Read-only stats agent for the selfhost dashboard. Serves JSON on LAN, Bearer-token protected."""
import json, os, socket, subprocess, threading, time, hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "9101"))
def _read_secret(p):
    try:
        if os.stat(p).st_mode & 0o077: print(f"Warnung: {p} ist für andere lesbar – chmod 600 empfohlen", flush=True)
        return open(p).read().strip()
    except FileNotFoundError:
        raise SystemExit(f"{p} fehlt – siehe docs/08-monitoring-dashboard.md (Agents)")
TOKEN = _read_secret("/etc/selfhost-dash/token")
try: ACTION_TOKEN = open("/etc/selfhost-dash/action_token").read().strip()
except FileNotFoundError: ACTION_TOKEN = None
GUEST_OPS = {"start", "shutdown", "stop", "reboot"}

def _iface_ip(name):
    try:
        o = subprocess.run(["ip", "-4", "-o", "addr", "show", name], capture_output=True, text=True, timeout=3).stdout
        return o.split()[3] if o else None
    except Exception: return None

def detect_ifaces():
    """All physical NICs (also the ones without link, so the TV can show them as down), plus tailscale0."""
    out = []
    for n in sorted(os.listdir("/sys/class/net")):
        base = f"/sys/class/net/{n}"
        if os.path.exists(base + "/device") or n == "tailscale0": out.append(n)
    return out

def link_info(name):
    """operstate, speed in Mbit/s (None if unknown/down), MAC, driver."""
    base = f"/sys/class/net/{name}"
    def r(f):
        try: return open(f"{base}/{f}").read().strip()
        except Exception: return None
    state = r("operstate") or "unknown"
    try: speed = int(r("speed")); speed = speed if speed > 0 else None
    except Exception: speed = None
    try: driver = os.path.basename(os.path.realpath(f"{base}/device/driver")) if os.path.exists(f"{base}/device/driver") else None
    except Exception: driver = None
    carrier = r("carrier")
    return {"state": "up" if state == "up" or (state == "unknown" and carrier == "1") else state, "speed": speed, "mac": r("address"), "driver": driver,
            "usb": "/usb" in os.path.realpath(base)}

def detect_disks():
    out = []
    for b in sorted(os.listdir("/sys/block")):
        if b.startswith(("loop", "zram", "sr", "dm-", "rbd", "nbd", "md")): continue
        try:
            if os.path.exists(f"/sys/block/{b}/device") and int(open(f"/sys/block/{b}/size").read()) > 0: out.append(b)
        except Exception: pass
    return out

IFACES = detect_ifaces()
DISKS = detect_disks()
BIND = os.environ.get("BIND") or (_iface_ip("vmbr0") or "0.0.0.0/0").split("/")[0]
INTERVAL = 2
HIST = 1800  # 1h at 2s

lock = threading.Lock()
live, slow, history = {}, {}, []

def read(p): 
    with open(p) as f: return f.read()

def cpu_times():
    v = list(map(int, read("/proc/stat").splitlines()[0].split()[1:]))
    idle = v[3] + v[4]
    return sum(v[:8]), idle, v[4]

def net_bytes():
    out = {}
    for line in read("/proc/net/dev").splitlines()[2:]:
        name, data = line.split(":", 1)
        name = name.strip()
        if name in IFACES and os.path.exists(f"/sys/class/net/{name}"):
            f = data.split(); out[name] = (int(f[0]), int(f[8]))
    return out

def disk_bytes():
    out = {}
    for line in read("/proc/diskstats").splitlines():
        f = line.split()
        if f[2] in DISKS: out[f[2]] = (int(f[5]) * 512, int(f[9]) * 512)
    return out

def meminfo():
    m = {}
    for line in read("/proc/meminfo").splitlines():
        k, v = line.split(":"); m[k] = int(v.split()[0]) * 1024
    return m

def iface_addr(name):
    """IP of the interface, or of its bridge if it is enslaved (eno1 -> vmbr0)."""
    master = f"/sys/class/net/{name}/master"
    if os.path.exists(master): name = os.path.basename(os.path.realpath(master))
    return _iface_ip(name)

def sampler():
    global IFACES
    prev_c, prev_n, prev_d, prev_t = cpu_times(), net_bytes(), disk_bytes(), time.time()
    addrs = {i: iface_addr(i) for i in IFACES}
    n = 0
    while True:
        time.sleep(INTERVAL)
        if n and n % 30 == 0:  # pick up hot-plugged NICs (USB dock)
            IFACES = detect_ifaces()
        c, nb, db, t = cpu_times(), net_bytes(), disk_bytes(), time.time()
        dt = t - prev_t
        dtot = c[0] - prev_c[0] or 1
        cpu = 1 - (c[1] - prev_c[1]) / dtot
        iowait = (c[2] - prev_c[2]) / dtot
        net = {i: {"rx": max(0, (nb[i][0] - prev_n[i][0]) / dt), "tx": max(0, (nb[i][1] - prev_n[i][1]) / dt),
                   "rxTotal": nb[i][0], "txTotal": nb[i][1], "addr": addrs.get(i), **link_info(i)} for i in nb if i in prev_n}
        disk = {d: {"read": (db[d][0] - prev_d[d][0]) / dt, "write": (db[d][1] - prev_d[d][1]) / dt} for d in db if d in prev_d}
        m = meminfo()
        st = os.statvfs("/")
        la = read("/proc/loadavg").split()[:3]
        snap = {
            "ts": t, "cpu": cpu, "iowait": iowait, "cores": os.cpu_count(),
            "mem": {"total": m["MemTotal"], "used": m["MemTotal"] - m["MemAvailable"]},
            "swap": {"total": m["SwapTotal"], "used": m["SwapTotal"] - m["SwapFree"]},
            "rootfs": {"total": st.f_blocks * st.f_frsize, "used": (st.f_blocks - st.f_bfree) * st.f_frsize},
            "load": [float(x) for x in la], "uptime": float(read("/proc/uptime").split()[0]),
            "net": net, "disk": disk, "node": socket.gethostname(),
        }
        point = {"t": int(t), "cpu": round(cpu, 4), "mem": snap["mem"]["used"],
                 "rx": round(sum(v["rx"] for k, v in net.items() if k != "tailscale0")),
                 "tx": round(sum(v["tx"] for k, v in net.items() if k != "tailscale0")),
                 "dr": round(sum(v["read"] for v in disk.values())), "dw": round(sum(v["write"] for v in disk.values()))}
        with lock:
            live.clear(); live.update(snap)
            history.append(point); del history[:-HIST]
        prev_c, prev_n, prev_d, prev_t = c, nb, db, t
        n += 1
        if n % 150 == 0: addrs = {i: iface_addr(i) for i in IFACES}

def pvesh(path, *args):
    o = subprocess.run(["pvesh", "get", path, "--output-format", "json", *args], capture_output=True, text=True, timeout=20)
    if o.returncode: raise RuntimeError(o.stderr.strip()[:200])
    return json.loads(o.stdout)

def fill_guest_names(guests):
    """Guests on an offline node come back from /cluster/resources without name/maxmem – read them from the
    cluster filesystem (/etc/pve is readable even without quorum)."""
    for g in guests or []:
        if g.get("name") and g.get("maxmem"): continue
        sub = "qemu-server" if g.get("type") == "qemu" else "lxc"
        try:
            for line in open(f"/etc/pve/nodes/{g.get('node')}/{sub}/{g.get('vmid')}.conf"):
                if line.startswith("["): break  # snapshot sections follow
                k, _, v = line.partition(":"); v = v.strip()
                if k in ("name", "hostname") and not g.get("name"): g["name"] = v
                elif k == "memory" and not g.get("maxmem"):
                    try: g["maxmem"] = int(v) * 1024 * 1024
                    except ValueError: pass
        except OSError: pass
    return guests

def slow_loop():
    node = socket.gethostname()
    n = 0
    while True:
        data, errs = {}, {}
        for key, fn in [
            ("storage", lambda: pvesh(f"/nodes/{node}/storage")),
            ("guests", lambda: fill_guest_names(pvesh("/cluster/resources", "--type", "vm"))),
            ("nodes", lambda: pvesh("/nodes")),
            ("quorum", lambda: pvesh("/cluster/status")),
        ] + ([("disks", lambda: pvesh(f"/nodes/{node}/disks/list")),
              ("version", lambda: pvesh(f"/nodes/{node}/version")),
              ("cpuinfo", lambda: pvesh(f"/nodes/{node}/status")["cpuinfo"])] if n % 10 == 0 else []):
            try: data[key] = fn()
            except Exception as e: errs[key] = str(e)
        with lock:
            slow.update(data); slow["node"] = node; slow["errors"] = errs; slow["ts"] = time.time()
        n += 1
        time.sleep(30)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, code, obj):
        raw = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_POST(self):
        ok = hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN) and ACTION_TOKEN \
            and hmac.compare_digest(self.headers.get("X-Action-Token", ""), ACTION_TOKEN)
        if not ok: self.send_response(401); self.end_headers(); return
        if self.path != "/guest": self.send_response(404); self.end_headers(); return
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length", 0)), 4096)) or "{}")
            self._json(200, guest_action(body))
        except Exception as e:
            self._json(400, {"ok": False, "error": str(e)})
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        if not hmac.compare_digest(auth, "Bearer " + TOKEN):
            self.send_response(401); self.end_headers(); return
        with lock:
            if self.path == "/stats": body = {"live": live, "slow": slow}
            elif self.path == "/history": body = history
            else: self.send_response(404); self.end_headers(); return
            raw = json.dumps(body).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

def guest_action(body):
    """Start/stop/shutdown/reboot a VM or LXC via the Proxmox API (async task, returns UPID)."""
    vmid, typ, op = int(body["vmid"]), body["type"], body["op"]
    if typ not in ("qemu", "lxc") or op not in GUEST_OPS or not (100 <= vmid < 1000000000):
        raise ValueError("invalid action")
    node = body.get("node") or socket.gethostname()
    o = subprocess.run(["pvesh", "create", f"/nodes/{node}/{typ}/{vmid}/status/{op}", "--output-format", "json"],
                       capture_output=True, text=True, timeout=60)
    if o.returncode: raise RuntimeError(o.stderr.strip()[:300])
    return {"ok": True, "task": json.loads(o.stdout or "null")}

if __name__ == "__main__":
    threading.Thread(target=sampler, daemon=True).start()
    threading.Thread(target=slow_loop, daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
