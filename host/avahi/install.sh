#!/bin/sh
# Veröffentlicht <name>.local per mDNS für jeden Dienst (Debian/Ubuntu).
# Aufruf: sudo ./install.sh [interface]   – Standard: Interface der Default-Route
set -e
IFACE=${1:-$(ip route show default | awk '{print $5; exit}')}
apt-get install -y avahi-daemon avahi-utils >/dev/null
sed "s/ens18/$IFACE/g" "$(dirname "$0")/avahi-alias" > /usr/local/bin/avahi-alias && chmod 755 /usr/local/bin/avahi-alias
cp "$(dirname "$0")/avahi-alias@.service" /etc/systemd/system/
systemctl daemon-reload
for n in jellyfin seerr sonarr radarr prowlarr bazarr qbittorrent mediathekarr aiostreams comet uptime dozzle git code release; do
  systemctl enable --now "avahi-alias@$n" >/dev/null 2>&1 && echo "  $n.local"
done
