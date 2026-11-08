# 8 · Monitoring, Dashboard & TV-Modus

## Das Dashboard (`stacks/dashboard`)

Eigenes Node.js-Dashboard, **ohne Abhängigkeiten** (nur Node-Bordmittel):

- **Startseite** `http://selfhost.local` – alle Dienste automatisch aus Docker erkannt (Labels > `overrides.json` > veröffentlichte Ports), mit Status aus Uptime Kuma, Container-Logs live (wie Dozzle), Start/Stop/Neustart von Containern und Proxmox-Gästen
- **TV-Modus** `/tv` – Playlist aus 3 Seiten (alle 20 s): *Ressourcen* (CPU/RAM/Disk/Netz pro Knoten, jede NIC, Speicher, SMART, NAS), *Uptime & Fehler*, *VMs & Container*. Optionen: `?interval=30`, `?page=2`, Pfeiltasten, Leertaste = Pause
- **Stromzähler** `/strom` – liest die Netzteil-Watt per IPMI alle 10 s, Graph, kWh pro Tag, Kosten
- **Hardware-Karte** – Server per IPMI ein/aus/neu starten (doppelte Bestätigung)
- **NAS-Karte** – Synology über die DSM-API (CPU, RAM, Temperatur, Platten, Update-Hinweis)
- **Telegram-Bot** – Ausfälle melden, `/status`, `/server` (Ein/Aus per IPMI), Logs, Neustarts

### Dienste ins Dashboard bringen

Am einfachsten per Labels im Compose-File:

```yaml
labels:
  dashboard.name: Forgejo
  dashboard.group: Development
  dashboard.description: Git-Server
  dashboard.url: http://git.local
  # dashboard.hide: "true"   # ausblenden
```

### Agents

| Agent | Läuft auf | Port | Aufgabe |
|---|---|---|---|
| `host/agent/agent.py` | jedem Proxmox-/Linux-Host | 9101 | CPU, RAM, Disks, SMART, NICs, Gäste, Gast-Aktionen |
| `host/agent/docker-agent.py` | weiteren Docker-Hosts | 9102 | Container-Liste + Start/Stop (Allow-List) |

Installation (als root):

```bash
mkdir -p /opt/selfhost-dash-agent /etc/selfhost-dash
cp host/agent/agent.py /opt/selfhost-dash-agent/
echo '<AGENT_TOKEN aus dashboard.env>'  > /etc/selfhost-dash/token
echo '<ACTION_TOKEN aus dashboard.env>' > /etc/selfhost-dash/action_token
chmod 600 /etc/selfhost-dash/*
cp host/agent/selfhost-dash-agent.service /etc/systemd/system/
systemctl enable --now selfhost-dash-agent
```

Die Agents sind **read-only + Token-geschützt**; Aktionen brauchen zusätzlich den Action-Token.

## TV-Kiosk (`host/kiosk`)

Ein Monitor am Server zeigt den TV-Modus:

```bash
apt install -y xserver-xorg xinit chromium unclutter ddcutil
useradd -m kiosk
install -m 755 host/kiosk/xinitrc /home/kiosk/.xinitrc
echo 'DASHBOARD_URL=http://192.168.1.21/tv' > /etc/default/kiosk
cp host/kiosk/kiosk.service host/kiosk/kiosk-display-on.* /etc/systemd/system/
install -m 755 host/kiosk/kiosk-display /usr/local/bin/
systemctl enable --now kiosk.service kiosk-display-on.timer
```

- `kiosk-display off` / `on` schaltet den Monitor per DDC/CI (Helligkeit: `ddcutil setvcp 10 0`)
- Timer schaltet morgens um 8 Uhr ein
- Auf Proxmox-Hosts: den GPU-Treiber (z. B. `amdgpu`) aus `/etc/modprobe.d/pve-blacklist.conf` entfernen

## Uptime Kuma

`http://uptime.local` – HTTP-Checks für jeden Dienst. `host/kuma/tv-statuspage.py` hält eine interne Statusseite „tv“ synchron, aus der das Dashboard die 24-h-Uptime liest (Cron stündlich, braucht `pip install uptime-kuma-api`).
