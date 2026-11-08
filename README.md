# 🏠 Homelab

Mein komplettes Homelab als Code: Medienserver mit Streaming, eigene Cloud, Monitoring mit TV-Wand, Git-Server mit Build-Pipeline und KI-Review – alles mit Docker Compose, dokumentiert und so vorbereitet, dass du es **bei dir nachbauen** kannst.

> Läuft bei mir auf zwei Proxmox-Servern und einer Synology-NAS – funktioniert aber genauso auf **einem einzigen Debian-Server** ohne Proxmox. Siehe [Schnellstart](docs/02-schnellstart-debian.md).

## Was ist drin?

| Bereich | Dienste | Doku |
|---|---|---|
| 🎬 **Media** | Jellyfin, Seerr, Sonarr, Radarr, Prowlarr, Bazarr, qBittorrent, MediathekArr | [Media-Stack](docs/04-media-stack.md) |
| ⚡ **Streaming (Debrid)** | AIOStreams, Comet, StremThru, Streamfilter, Jellyfin-Plugin Gelato | [Streaming](docs/05-streaming-debrid.md) |
| ☁️ **Cloud** | Nextcloud, Paperless-ngx, Obsidian LiveSync (CouchDB), Guacamole | [Cloud](docs/06-cloud.md) |
| 📊 **Monitoring** | Eigenes Dashboard + TV-Modus, Uptime Kuma, Dozzle, Telegram-Bot, Stromzähler | [Monitoring](docs/08-monitoring-dashboard.md) |
| 🛠️ **Development** | Forgejo (Git + Actions), Build-Runner, Code-Server, Release-Center (KI-Review → GitHub) | [Dev-Pipeline](docs/09-dev-pipeline.md) |
| 🔐 **Zugriff** | Caddy (Reverse-Proxy), mDNS `*.local`, Tailscale (VPN, Subnet-Router, Exit-Node) | [Fernzugriff](docs/07-remote-vpn.md) |

## Architektur

```mermaid
flowchart TB
  subgraph Internet
    AD[(AllDebrid)]
    GH[(GitHub)]
    GQ[(Groq KI)]
    TG[(Telegram)]
  end

  subgraph LAN["Heimnetz 10.40.32.0/24"]
    R[FritzBox<br/>Router/DHCP]
    SW[Cisco Catalyst 2960-S<br/>PoE-Switch]

    subgraph PVE2["pve2 · Ryzen 5 2400G · 16 GB · 24/7"]
      direction TB
      K[Kiosk · TV-Modus<br/>DisplayPort]
      TS[Tailscale<br/>Subnet-Router + Exit-Node]
      subgraph VM200["VM 200 selfhost · Docker"]
        CADDY[Caddy :80]
        JF[Jellyfin :8096]
        ARR[Sonarr · Radarr · Prowlarr<br/>Bazarr · qBittorrent]
        STR[AIOStreams · Comet<br/>StremThru · Streamfilter]
        DASH[Dashboard :3000<br/>+ Telegram-Bot]
        KUMA[Uptime Kuma · Dozzle]
        FJ[Forgejo :3300]
        CS[Code-Server :8443]
        RC[Release-Center :3200]
      end
      subgraph VM201["VM 201 cloud · Docker"]
        NC[Nextcloud]
        PL[Paperless-ngx]
        CDB[CouchDB<br/>Obsidian]
        GUA[Guacamole]
        PG[(Postgres · Redis)]
      end
      LXC103[LXC Pelican-Panel]
    end

    subgraph PVE1["pve1 · Fujitsu RX300 S6 · 2× Xeon · 283 GB · nur bei Bedarf"]
      IRMC[iRMC S2<br/>IPMI · Power · Watt]
      RUN[LXC build-runner<br/>Forgejo Actions + Docker]
      IMM[LXC Immich]
      PEL[LXC Pelican Wings<br/>Gameserver]
    end

    NAS[(Synology RS812<br/>NFS: VM-Disks · Builds · Git)]
  end

  R --- SW
  SW --- PVE1 & PVE2 & NAS
  PVE1 & PVE2 -. Storage-Netz 192.168.50.0/24 .- NAS
  CADDY --> JF & ARR & STR & DASH & FJ & CS & RC
  JF -- Gelato --> STR -- Streams --> AD
  FJ -- Jobs --> RUN -- Artefakte --> NAS
  FJ -- Repos --> NAS
  RC -- Review --> GQ
  RC -- Push --> GH
  DASH -- Agents :9101 --> PVE1 & PVE2
  DASH -- IPMI --> IRMC
  DASH -- DSM-API --> NAS
  DASH --> TG
  K --> DASH
```

## Dienste & Ports

| Dienst | Host | Port | Name | Zweck |
|---|---|---|---|---|
| Dashboard | selfhost | 3000 | `selfhost.local` | Übersicht, TV-Modus `/tv`, Stromzähler `/strom` |
| Jellyfin | selfhost | 8096 | `jellyfin.local` | Medienserver (lokal + Streams) |
| Seerr | selfhost | 5055 | `seerr.local` | Film-/Serienwünsche |
| Sonarr / Radarr | selfhost | 8989 / 7878 | `sonarr.local` / `radarr.local` | Serien / Filme verwalten |
| Prowlarr | selfhost | 9696 | `prowlarr.local` | Indexer |
| Bazarr | selfhost | 6767 | `bazarr.local` | Untertitel |
| qBittorrent | selfhost | 8080 | `qbittorrent.local` | Downloads |
| MediathekArr | selfhost | 5007 | `mediathekarr.local` | ARD/ZDF-Mediathek in Sonarr |
| AIOStreams | selfhost | 3100 | `aiostreams.local` | Stremio-Addons bündeln |
| Streamfilter | selfhost | 3101 | – | nur gecachte (⚡) Streams an Jellyfin |
| Comet | selfhost | 8000 | `comet.local` | Debrid-Scraper |
| Uptime Kuma | selfhost | 3001 | `uptime.local` | Verfügbarkeit |
| Dozzle | selfhost | 8888 | `dozzle.local` | Container-Logs |
| Forgejo | selfhost | 3300 / 2222 (SSH) | `git.local` | Git + Actions |
| Code-Server | selfhost | 8443 | `code.local` | VS Code im Browser |
| Release-Center | selfhost | 3200 | `release.local` | Build-Review & GitHub-Push |
| Nextcloud | cloud | 80 | `nextcloud.local` | Dateien |
| Paperless-ngx | cloud | 80 | `paperless.local` | Dokumente mit OCR |
| CouchDB | cloud | 80 | `obsidian.local` | Obsidian LiveSync |
| Guacamole | cloud | 80 | `guacamole.local` | Remote-Desktop/SSH im Browser (TOTP) |
| Stats-Agent | Proxmox-Hosts | 9101 | – | CPU/RAM/Disk/Netz für das Dashboard |
| Docker-Agent | cloud | 9102 | – | Container der Cloud-VM fürs Dashboard |
| Proxmox | pve1/pve2 | 8006 | – | Virtualisierung |
| iRMC | pve1 | 80/443, IPMI 623 | – | Fernwartung pve1 |

## Schnellstart (ein Server)

```bash
git clone https://github.com/<dein-user>/homelab.git && cd homelab
./setup.sh
```

Das Skript installiert bei Bedarf Docker, erzeugt alle `.env`-Dateien mit **zufälligen Passwörtern**, legt die Ordnerstruktur an und startet die Stacks, die du auswählst. Danach: [docs/02-schnellstart-debian.md](docs/02-schnellstart-debian.md).

## Aufbau des Repos

```
.env.example          globale Einstellungen (IP, Pfade, Passwörter)
setup.sh              interaktives Setup
stacks/<name>/        je ein Docker-Compose-Stack (+ *.env.example)
host/agent/           Stats-/Docker-Agents fürs Dashboard (systemd)
host/kiosk/           TV-Kiosk (X11 + Chromium) mit Zeitplan
host/runner/          Forgejo-Actions-Runner einrichten
host/avahi/           *.local-Namen per mDNS
presets/              Automatische Einrichtung (Sonarr/Radarr/Prowlarr)
docs/                 Anleitungen
```

## Dokumentation

1. [Architektur & Netzwerk](docs/01-architektur.md)
2. [Schnellstart auf Debian (ohne Proxmox)](docs/02-schnellstart-debian.md)
3. [Proxmox-Aufbau](docs/03-proxmox.md)
4. [Media-Stack einrichten](docs/04-media-stack.md)
5. [Streaming mit Debrid](docs/05-streaming-debrid.md)
6. [Cloud-Dienste](docs/06-cloud.md)
7. [Fernzugriff & VPN](docs/07-remote-vpn.md)
8. [Monitoring, Dashboard & TV-Modus](docs/08-monitoring-dashboard.md)
9. [Dev-Pipeline: Forgejo → Runner → KI-Review → GitHub](docs/09-dev-pipeline.md)
10. [Hardware-Tipps (Fujitsu iRMC, Synology, Strom)](docs/10-hardware.md)

## Sicherheit

- Alle Passwörter/Tokens stehen ausschließlich in `.env`-Dateien (in `.gitignore`), nie in Compose-Dateien.
- Dienste sind nur im LAN bzw. über Tailscale erreichbar – **keine Portfreigaben im Router**.
- Jeder Push durchläuft gitleaks + KI-Review, bevor er auf GitHub landet.

## Lizenz

MIT – nimm dir, was du brauchst. Ein ⭐ freut mich.
