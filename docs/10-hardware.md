# 10 · Hardware-Tipps

## Fujitsu PRIMERGY RX300 S6 (pve1)

### iRMC S2 (Fernwartung)
- Web: `http://<irmc-ip>` (HTTPS nur mit alter TLS → im Browser oft nicht erreichbar)
- **IPMI über LAN** funktioniert hervorragend:
  ```bash
  export IPMI_PASSWORD=…
  ipmitool -I lanplus -H <irmc-ip> -U admin -E chassis power status   # on|soft|off|reset|cycle
  ipmitool -I lanplus -H <irmc-ip> -U admin -E sdr elist full          # Sensoren
  ipmitool -I lanplus -H <irmc-ip> -U admin -E sdr get "Total Power" "PSU1 Power" "PSU2 Power"
  ```
- Das Dashboard nutzt genau das für Hardware-Karte, Stromzähler und Telegram-`/server`
- Web-Oberfläche verträgt nur wenige gleichzeitige Sitzungen → nicht skripten, sonst „503 too many connections“ (gibt sich nach ~5 min)
- **Grafische Konsole** braucht die Lizenz „iRMC S2 Advanced Pack“ (gebraucht günstig)
- **Text-Konsole ohne Lizenz:** iRMC → Konsolen Umleitung → BIOS Text Konsole aktivieren (COM1, VT100+), dann
  ```bash
  ipmitool -I lanplus -H <irmc-ip> -U admin -E sol activate     # beenden mit ~.
  ```
  plus in Linux `console=ttyS0,9600n8` und `GRUB_TERMINAL="console serial"` → BIOS, GRUB und Login übers Netz

### BIOS
- Letztes BIOS: **R1.15** (2018, Microcode für Spectre v4). Auf der Fujitsu-Seite nicht mehr verlinkt, liegt aber noch im GlobalFlash-Archiv:
  `https://support.ts.fujitsu.com/DownloadManager/globalflash/SystemBoard/D2619-RX300S6/`
- Der neue **Microcode kommt einfacher über Linux**: `apt install intel-microcode` (Debian-Quelle `non-free-firmware`) → nach dem Neustart `microcode: 0x1f`, Spectre v4 mitigiert – ganz ohne Flashen
- Kein S3-Standby (nur S1/S4) – „schnell aufwachen“ geht bei Rack-Servern praktisch nicht
- Start dauert ~4–6 min (RAM-Test + RAID-Init); verwaiste RAID-Volumes löschen spart Zeit (`megacli -CfgLdDel -Lx -a0`)

### Strom
Leerlauf ~160–230 W ≈ 5–6 ct/h. Der Stromzähler im Dashboard (`/strom`) zeigt Verlauf + Kosten.

## Synology RS812 (NAS)

- ARMv5, 1 Kern, 512 MB, DSM 6.2.4 (letzte Version) → **kein Docker, kein CasaOS**
- NFS-Durchsatz ~30–35 MB/s (CPU-limitiert)
- Optimieren: Universal Search (SynoFinder) und AFP abschalten
- DSM-API fürs Dashboard (Login: `SYNO.API.Auth`, Werte: `SYNO.Core.System.Utilization`, `SYNO.Storage.CGI.Storage`)
- Für mehr Tempo lohnt nur neue Hardware (x86 + TrueNAS/OMV)

## HP ProDesk 405 G4 (pve2)

- Leise, sparsam, perfekt für 24/7
- iGPU (Vega 11) für den Kiosk-Monitor: `amdgpu` in Proxmox entsperren; UMA-Framebuffer im BIOS auf 512 MB senken spart RAM
- Zweite NIC per USB-Adapter fürs Storage-Netz zur NAS
