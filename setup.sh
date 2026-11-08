#!/usr/bin/env bash
# Homelab-Setup für einen einzelnen Debian/Ubuntu-Server (mit oder ohne Proxmox).
#   ./setup.sh            -> interaktiv: Docker prüfen, .env erzeugen, Stacks auswählen und starten
#   ./setup.sh --env-only -> nur .env-Dateien anlegen (Passwörter zufällig)
set -euo pipefail
cd "$(dirname "$0")"
B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; N=$'\e[0m'
say() { echo "${B}==>${N} $*"; }
rand() { local s; s=$(openssl rand -base64 48); s=${s//[^A-Za-z0-9]/}; printf '%s' "${s:0:${1:-24}}"; }
fill() { # ersetzt __RANDOM__ / __HEX64__ / __HOST_IP__ in einer Datei
  local f=$1 tmp; tmp=$(mktemp)
  while IFS= read -r line || [ -n "$line" ]; do
    while [[ $line == *__RANDOM__* ]]; do line=${line/__RANDOM__/$(rand 24)}; done
    [[ $line == *__HEX64__* ]] && line=${line/__HEX64__/$(openssl rand -hex 32)}
    line=${line//__HOST_IP__/$HOST_IP}
    printf '%s\n' "$line"
  done <"$f" >"$tmp"; mv "$tmp" "$f"; chmod 600 "$f"
}

# ---------- 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Docker ist nicht installiert."
  read -rp "Jetzt über get.docker.com installieren? [J/n] " a
  [[ ${a:-j} =~ ^[JjYy]$ ]] || { echo "Abbruch."; exit 1; }
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi
docker compose version >/dev/null || { echo "docker compose (v2) fehlt"; exit 1; }

# ---------- 2. globale .env
if [ ! -f .env ]; then
  cp .env.example .env
  DEF_IP=$(hostname -I | awk '{print $1}')
  read -rp "IP dieses Servers im LAN [$DEF_IP]: " HOST_IP; HOST_IP=${HOST_IP:-$DEF_IP}
  read -rp "Zeitzone [Europe/Berlin]: " TZV; TZV=${TZV:-Europe/Berlin}
  sed -i "s#^HOST_IP=.*#HOST_IP=$HOST_IP#; s#^TZ=.*#TZ=$TZV#; s#^PUID=.*#PUID=$(id -u)#; s#^PGID=.*#PGID=$(id -g)#" .env
  DGID=$(getent group docker | cut -d: -f3 || true); [ -n "$DGID" ] && sed -i "s#^DOCKER_GID=.*#DOCKER_GID=$DGID#" .env
  fill .env
  say "${G}.env erstellt${N} (Passwörter zufällig, chmod 600)"
fi
set -a; . ./.env; set +a

# ---------- 3. stack-spezifische env-Dateien + gemeinsame .env verlinken
for ex in stacks/*/*.env.example; do
  f=${ex%.example}; [ -f "$f" ] || { cp "$ex" "$f"; fill "$f"; echo "  angelegt: $f"; }
done
for d in stacks/*/; do ln -sfn ../../.env "$d/.env"; done
[ "${1:-}" = "--env-only" ] && exit 0

# ---------- 4. Ordner + Docker-Netz
say "Lege Ordner an (sudo)"
sudo mkdir -p "$APPDATA" "$MEDIA_DATA"/{downloads/{complete,incomplete},library/{movies,tv,anime,docs}} "$CLOUD_DATA" "$GIT_STORAGE"/{repositories,workspace}
sudo chown -R "$PUID:$PGID" "$APPDATA" "$MEDIA_DATA" "$GIT_STORAGE"
docker network inspect media >/dev/null 2>&1 || docker network create media >/dev/null

# ---------- 5. Stacks wählen
ALL=(core proxy media-server media-management downloaders streaming cloud dev release-center dashboard)
echo; say "Verfügbare Stacks:"
for i in "${!ALL[@]}"; do printf "  %2d) %s\n" "$((i+1))" "${ALL[$i]}"; done
read -rp "Welche starten? (z. B. 1 2 3, Enter = alle): " sel
CHOSEN=(); if [ -z "$sel" ]; then CHOSEN=("${ALL[@]}"); else for n in $sel; do CHOSEN+=("${ALL[$((n-1))]}"); done; fi
for s in "${CHOSEN[@]}"; do
  say "Starte $s"
  (cd "stacks/$s" && docker compose up -d --build)
done

echo
say "${G}Fertig.${N} Dashboard: http://$HOST_IP  ·  weitere Schritte: docs/02-schnellstart-debian.md"
grep -q "^CODE_PASSWORD=" .env && echo "  Code-Server-Passwort steht in .env (CODE_PASSWORD)."
echo "  ${Y}Tipp:${N} mDNS-Namen (*.local) mit host/avahi/install.sh einrichten."
