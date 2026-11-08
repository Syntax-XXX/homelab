#!/usr/bin/env python3
"""Keeps Guacamole connections in sync with the Proxmox cluster.

Runs on a Proxmox node (timer, every 5 min). Builds SQL and pipes it into the Postgres
container on the cloud VM. Connections are grouped and upserted by name, so
manual connections in other groups are never touched.
"""
import json, subprocess, sys

import os
CLOUD = os.environ.get("GUAC_SSH", "user@192.168.1.22")  # VM mit dem Guacamole-Postgres
KEY = open("/root/.ssh/guacamole_rsa").read()
ADMIN = os.environ.get("GUAC_ADMIN", "admin")

STATIC = [  # (group, name, params)
    # Beispiele – an dein Netz anpassen
    ("Proxmox", "pve1 (root)", {"hostname": "192.168.1.10", "username": "root"}),
    ("Proxmox", "pve2 (root)", {"hostname": "192.168.1.11", "username": "root"}),
    ("Servers", "selfhost (media stack)", {"hostname": "192.168.1.21", "username": "user"}),
    ("Servers", "cloud (Nextcloud/Paperless)", {"hostname": "192.168.1.22", "username": "user"}),
]
SSH_DEFAULTS = {"port": "22", "color-scheme": "gray-black", "font-size": "12", "scrollback": "5000",
                "enable-sftp": "true", "server-alive-interval": "30"}


def pvesh(path, *args):
    return json.loads(subprocess.check_output(["pvesh", "get", path, "--output-format", "json", *args], timeout=30))


def agent_ipv4(node, vmid):
    try:
        for iface in pvesh(f"/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces")["result"]:
            for a in iface.get("ip-addresses", []):
                ip = a["ip-address"]
                if a["ip-address-type"] == "ipv4" and not ip.startswith(("127.", "169.254.", "172.")):
                    return ip
    except Exception:
        pass
    return None


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def main():
    nodes = {n["name"]: n.get("ip") for n in pvesh("/cluster/status") if n["type"] == "node"}
    conns = []  # (group, name, protocol, params)
    for g, name, p in STATIC:
        conns.append((g, name, "ssh", {**SSH_DEFAULTS, **p, "private-key": KEY}))

    for r in sorted(pvesh("/cluster/resources", "--type", "vm"), key=lambda x: x["vmid"]):
        vmid, node, name = r["vmid"], r["node"], r.get("name") or f"guest-{r['vmid']}"
        if r.get("template"):
            continue
        if r["type"] == "lxc" and nodes.get(node):
            # terminal inside the container through its Proxmox host – no IP or password needed
            conns.append(("LXC containers", f"{name} (CT {vmid})", "ssh", {
                **SSH_DEFAULTS, "hostname": nodes[node], "username": "root", "private-key": KEY,
                "command": f"pct enter {vmid}", "enable-sftp": "false"}))
        elif r["type"] == "qemu" and vmid not in (200, 201):  # selfhost/cloud are in "Servers"
            cfg = pvesh(f"/nodes/{node}/qemu/{vmid}/config") if r.get("status") != "unknown" else {}
            ip = agent_ipv4(node, vmid) if r.get("status") == "running" else None
            if str(cfg.get("ostype", "")).startswith("win"):
                p = {"port": "3389", "security": "any", "ignore-cert": "true", "resize-method": "display-update",
                     "enable-wallpaper": "true", "enable-font-smoothing": "true", "server-layout": "de-de-qwertz",
                     "enable-drive": "true", "drive-name": "Guacamole", "drive-path": f"/drive/{vmid}", "create-drive-path": "true"}
                if ip: p["hostname"] = ip
                conns.append(("Windows (RDP)", f"{name} (VM {vmid})", "rdp", p))
            else:
                p = {**SSH_DEFAULTS}
                if ip: p["hostname"] = ip
                conns.append(("VMs (SSH)", f"{name} (VM {vmid})", "ssh", p))

    sql = ["BEGIN;"]
    # admin entity id
    sql.append(f"CREATE TEMP TABLE adm AS SELECT entity_id FROM guacamole_entity WHERE name={q(ADMIN)} AND type='USER';")
    for g in sorted({c[0] for c in conns}):
        sql.append(f"""INSERT INTO guacamole_connection_group (connection_group_name, type)
SELECT {q(g)}, 'ORGANIZATIONAL' WHERE NOT EXISTS (SELECT 1 FROM guacamole_connection_group WHERE connection_group_name={q(g)} AND parent_id IS NULL);
INSERT INTO guacamole_connection_group_permission (entity_id, connection_group_id, permission)
SELECT adm.entity_id, cg.connection_group_id, 'READ' FROM adm, guacamole_connection_group cg
WHERE cg.connection_group_name={q(g)} AND cg.parent_id IS NULL ON CONFLICT DO NOTHING;""")
    for g, name, proto, params in conns:
        grp = f"(SELECT connection_group_id FROM guacamole_connection_group WHERE connection_group_name={q(g)} AND parent_id IS NULL)"
        cid = f"(SELECT connection_id FROM guacamole_connection WHERE connection_name={q(name)} AND parent_id={grp})"
        sql.append(f"""INSERT INTO guacamole_connection (connection_name, parent_id, protocol)
SELECT {q(name)}, {grp}, {q(proto)} WHERE NOT EXISTS (SELECT 1 FROM guacamole_connection WHERE connection_name={q(name)} AND parent_id={grp});
UPDATE guacamole_connection SET protocol={q(proto)} WHERE connection_id={cid};""")
        # only overwrite parameters we manage; keep a previously known hostname if the VM is off now
        keys = list(params) + ([] if "hostname" in params else [])
        sql.append(f"DELETE FROM guacamole_connection_parameter WHERE connection_id={cid} AND parameter_name IN ({','.join(q(k) for k in keys)});")
        for k, v in params.items():
            sql.append(f"INSERT INTO guacamole_connection_parameter (connection_id, parameter_name, parameter_value) VALUES ({cid}, {q(k)}, {q(v)});")
        sql.append(f"""INSERT INTO guacamole_connection_permission (entity_id, connection_id, permission)
SELECT adm.entity_id, {cid}, 'READ' FROM adm ON CONFLICT DO NOTHING;""")
    sql.append("COMMIT;")

    out = subprocess.run(["ssh", "-o", "BatchMode=yes", CLOUD,
                          "sudo docker exec -i postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d guacamole"],
                         input="\n".join(sql), text=True, capture_output=True, timeout=60)
    if out.returncode:
        print(out.stderr.strip(), file=sys.stderr); sys.exit(1)
    if "-v" in sys.argv:
        for g, name, proto, p in conns:
            print(f"{g:16} {name:34} {proto:4} {p.get('hostname', '(IP unknown – VM off)')}")


if __name__ == "__main__":
    main()
