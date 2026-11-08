# 2 · Schnellstart auf einem Debian-Server (ohne Proxmox)

Du brauchst **nur einen Rechner** mit Debian 12/13 (oder Ubuntu 22.04+). Proxmox ist optional – alles hier läuft auch direkt auf dem Blech.

**Empfehlung Hardware:** 4 Kerne, 8 GB RAM (16 GB, wenn du Cloud + Media + Dev gleichzeitig willst), SSD für das System + `APPDATA`, große Platte für Medien.

## 1. Repo holen und Setup starten

```bash
sudo apt install -y git curl openssl
git clone https://github.com/<dein-user>/homelab.git ~/homelab
cd ~/homelab
./setup.sh
```

`setup.sh` macht:

1. installiert Docker (falls nötig, über get.docker.com)
2. fragt IP + Zeitzone, schreibt `.env` mit **zufälligen Passwörtern**
3. legt pro Stack die passende `*.env` an (aus `*.env.example`)
4. erstellt die Ordner (`/opt/appdata`, `/srv/media/data/...`, `/srv/data`, `/srv/git`)
5. erstellt das Docker-Netz `media`
6. startet die Stacks, die du auswählst

> Nach dem ersten Docker-Install einmal ab- und wieder anmelden (Gruppe `docker`).

## 2. Ordnerstruktur für Medien

```
/srv/media/data
├── downloads/{complete,incomplete}
└── library/{movies,tv,anime,docs}
```

Downloads und Bibliothek liegen **auf demselben Dateisystem** → Sonarr/Radarr können Hardlinks benutzen (sofort, kein doppelter Platz). Alle Container sehen den Ordner als `/data`.

## 3. Namen (*.local) einrichten

```bash
sudo ./host/avahi/install.sh        # veröffentlicht jellyfin.local, git.local, …
```

Danach erreichst du alles über `http://<name>.local` – der `proxy`-Stack (Caddy) verteilt die Anfragen.

## 4. Reihenfolge der Einrichtung

| Schritt | Was | Anleitung |
|---|---|---|
| 1 | Dashboard öffnen: `http://<server-ip>` | [08](08-monitoring-dashboard.md) |
| 2 | Media: Jellyfin, *arr, qBittorrent | [04](04-media-stack.md) + `presets/arr-bootstrap.sh` |
| 3 | Streaming mit Debrid (optional) | [05](05-streaming-debrid.md) |
| 4 | Cloud (Nextcloud, Paperless, Obsidian) | [06](06-cloud.md) |
| 5 | VPN für unterwegs | [07](07-remote-vpn.md) |
| 6 | Git + Build-Pipeline | [09](09-dev-pipeline.md) |

## 5. Ein Server statt drei – was ändert sich?

| Bei mir | Bei dir auf einem Server |
|---|---|
| VM `selfhost` + VM `cloud` | alles auf einem Docker-Host – `CLOUD_HTTP_PORT=8081` (Standard in `.env.example`), der `proxy`-Stack leitet `nextcloud.local` & Co. weiter |
| Build-Runner auf pve1 | Runner auf demselben Server: `sudo FORGEJO_URL=http://127.0.0.1:3300 RUNNER_TOKEN=… host/runner/setup-runner.sh` |
| NAS per NFS | lokale Platte; `GIT_STORAGE`/`MEDIA_DATA` einfach auf die große Platte zeigen lassen |
| Stats-Agent auf Proxmox | Agent läuft auch auf jedem normalen Linux (siehe [08](08-monitoring-dashboard.md)) |
| Tailscale auf pve2 | Tailscale auf dem Server installieren, gleiches Vorgehen |

## 6. Updates

```bash
cd ~/homelab/stacks/media-server && docker compose pull && docker compose up -d
docker image prune -f
```

Images mit fester Version (z. B. `jellyfin:version-12.1…`) aktualisierst du, indem du die Version in `compose.yaml` hochsetzt – so gibt es keine Überraschungen.

## 7. Backups

- **Konfiguration:** `/opt/appdata` (klein, wichtig!) – z. B. per `restic` oder Proxmox-Backup
- **Datenbanken:** `docker exec postgres pg_dumpall -U postgres > backup.sql`
- **Medien:** optional (lassen sich neu laden)
