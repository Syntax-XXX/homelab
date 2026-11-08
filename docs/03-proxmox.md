# 3 · Proxmox-Aufbau

## Cluster

Zwei Knoten im Cluster (`pve1`, `pve2`). Weil pve1 nachts aus ist, verliert der Cluster dann sein Quorum – laufende Gäste stört das nicht, nur Änderungen sind solange gesperrt.

> Willst du einen dauerhaft halb-ausgeschalteten Knoten, gib pve2 zwei Stimmen (`quorum_votes: 2` in `/etc/pve/corosync.conf`) oder nutze ein QDevice auf einem Raspberry Pi.

## Gäste

| ID | Typ | Name | Knoten | CPU | RAM | Zweck |
|---|---|---|---|---|---|---|
| 200 | VM | selfhost | pve2 | 4 | 7 GB fest | Media, Streaming, Dashboard, Dev |
| 201 | VM | cloud | pve2 | 2 | 3 GB fest | Nextcloud, Paperless, CouchDB, Guacamole |
| 103 | LXC | pelican-panel | pve2 | 2 | 1 GB | Gameserver-Panel |
| 105 | LXC | homelable | pve2 | 2 | 2 GB | Netzwerk-Doku |
| 102 | LXC | pelican-wings | pve1 | 12 | 120 GB | Gameserver |
| 104 | LXC | immich | pve1 | 10 | 6 GB | Fotos |
| 106 | LXC | build-runner | pve1 | 16 | 32 GB | Forgejo Actions + Docker |
| 100 | VM | win10-workstation | pve1 | 24 | 32 GB | bei Bedarf |

### Lektionen

- **Ballooning aus** für Docker-VMs: Proxmox nimmt VMs sonst RAM weg, sobald der Host über 80 % liegt → Swap, Ruckeln. Feste Größe: `qm set 200 --memory 7168 --balloon 0`.
- **Docker in VMs auf Netzwerk + Platten warten lassen**, sonst starten Container ohne DNS bzw. ohne Datenplatte:

  ```ini
  # /etc/systemd/system/docker.service.d/wait-network.conf
  [Unit]
  Wants=network-online.target
  After=network-online.target remote-fs.target
  RequiresMountsFor=/srv/media
  ```

  und feste DNS-Server in `/etc/docker/daemon.json`: `{"dns": ["192.168.1.1", "1.1.1.1"]}`
- **Docker in LXC** (z. B. Build-Runner): unprivilegiert, Features `nesting=1,keyctl=1`.

## NAS als Speicher

In `/etc/pve/storage.cfg` sind zwei NFS-Freigaben eingebunden (Inhalt: images, iso, backup, rootdir). Ein separates Storage-Netz (zweite NIC bzw. USB-NIC) hält NFS-Last vom LAN fern.

Bind-Mount eines NAS-Ordners in einen LXC:

```bash
pct set 106 --mp0 /mnt/pve/NAS-Volume1/builds,mp=/mnt/builds
```

## Hardware-Wächter

- **Stats-Agent** (`host/agent/agent.py`) auf jedem Knoten: CPU, RAM, Disks/SMART, NICs, Gäste – fürs Dashboard. `deploy-peer.sh` verteilt ihn automatisch auf neue Knoten.
- **Kiosk** (`host/kiosk`): Monitor am Server zeigt den TV-Modus; Timer schaltet ihn um 8 Uhr ein (DDC/CI per `ddcutil`).
