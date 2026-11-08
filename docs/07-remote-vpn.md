# 7 · Fernzugriff & VPN

**Grundsatz:** Nichts wird im Router freigegeben. Von unterwegs geht alles über **Tailscale** (WireGuard, kostenlos für private Nutzung).

## Tailscale als Subnet-Router + Exit-Node

Auf **einem** Server, der 24/7 läuft (bei mir pve2):

```bash
curl -fsSL https://tailscale.com/install.sh | sh
cat >/etc/sysctl.d/99-tailscale.conf <<EOF
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
EOF
sysctl -p /etc/sysctl.d/99-tailscale.conf
tailscale up --advertise-routes=10.40.32.0/24 --advertise-exit-node
```

Dann in der [Tailscale-Admin-Konsole](https://login.tailscale.com/admin/machines):
1. Maschine → **Edit route settings** → Subnetz **und** Exit-Node freigeben
2. **Disable key expiry** für den Server (sonst fliegt er nach 180 Tagen raus)

Auf Handy/Laptop: Tailscale-App installieren, gleiche Anmeldung.

| Ziel | So geht's |
|---|---|
| Heimnetz von unterwegs | Tailscale an → alle `10.40.32.x`-Adressen erreichbar |
| Öffentliches WLAN absichern | Exit-Node „pve2“ wählen → gesamter Verkehr läuft über zu Hause |
| Streaming unterwegs | Jellyfin-App → `http://10.40.32.108:8096` |

> `*.local`-Namen funktionieren über Tailscale nicht (mDNS bleibt im LAN). Entweder IPs nutzen oder in der Tailscale-Konsole **DNS → Split DNS** auf den Router zeigen lassen und dort Namen eintragen.

## Lokale Namen

Siehe [Architektur → Namen](01-architektur.md#namen-statt-ips): avahi (mDNS) + Caddy.

## Sicherheit – Checkliste

- [ ] Keine Portfreigaben in der FritzBox
- [ ] Jeder Dienst mit eigenem Passwort (setup.sh erzeugt zufällige)
- [ ] Guacamole mit TOTP
- [ ] Proxmox: Root-Login per SSH nur mit Schlüssel
- [ ] Tailscale-ACLs, wenn du Freunden Zugriff gibst (nur Jellyfin freigeben)
