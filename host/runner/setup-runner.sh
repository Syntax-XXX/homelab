#!/usr/bin/env bash
# Build-Runner für Forgejo Actions einrichten (Debian 12 LXC/VM mit Docker).
# Proxmox-LXC: unprivilegiert, Features nesting=1,keyctl=1 – optional Mountpoint für Build-Artefakte (/mnt/builds).
#   FORGEJO_URL=http://192.168.1.21:3300 RUNNER_TOKEN=xxx ./setup-runner.sh
# Token: Forgejo → Site-Administration → Actions → Runner → "Neuen Runner erstellen"
set -euo pipefail
: "${FORGEJO_URL:?FORGEJO_URL setzen}" "${RUNNER_TOKEN:?RUNNER_TOKEN setzen}"
RUNNER_VERSION=${RUNNER_VERSION:-13.2.1}
NAME=${RUNNER_NAME:-$(hostname)}
CAPACITY=${CAPACITY:-4}
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
apt-get update -qq && apt-get install -y -qq ca-certificates curl gnupg git >/dev/null
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
curl -fsSL -o /usr/local/bin/forgejo-runner "https://code.forgejo.org/forgejo/runner/releases/download/v${RUNNER_VERSION}/forgejo-runner-${RUNNER_VERSION}-linux-amd64"
chmod +x /usr/local/bin/forgejo-runner
id runner >/dev/null 2>&1 || useradd -r -m -d /var/lib/forgejo-runner -s /bin/bash -G docker runner
cd /var/lib/forgejo-runner
/usr/local/bin/forgejo-runner generate-config > config.yml
python3 - "$CAPACITY" <<'PY'
import sys,re
p="config.yml"; s=open(p).read()
s=s.replace("  capacity: 1\n",f"  capacity: {sys.argv[1]}\n",1)
s=re.sub(r"\n  envs:\n(?:    [A-Z_0-9]+: [^\n]*\n)*", "\n  envs:\n    TZ: Europe/Berlin\n", s, 1)
s=s.replace("  options:\n  # The parent","  options: \"-v /mnt/builds:/builds\"\n  # The parent",1)
s=s.replace("  valid_volumes: []\n","  valid_volumes:\n    - /mnt/builds\n",1)
s=s.replace('  docker_host: "-"\n','  docker_host: "automount"\n',1)
open(p,"w").write(s)
PY
mkdir -p /mnt/builds
/usr/local/bin/forgejo-runner register --no-interactive --config config.yml --instance "$FORGEJO_URL" --token "$RUNNER_TOKEN" --name "$NAME" \
  --labels "ubuntu-latest:docker://ghcr.io/catthehacker/ubuntu:act-24.04,debian:docker://node:22-bookworm,docker:docker://node:22-bookworm"
chown -R runner:runner /var/lib/forgejo-runner
cat > /etc/systemd/system/forgejo-runner.service <<UNIT
[Unit]
Description=Forgejo Actions Runner
After=docker.service network-online.target
Requires=docker.service
[Service]
User=runner
Group=runner
WorkingDirectory=/var/lib/forgejo-runner
ExecStart=/usr/local/bin/forgejo-runner daemon --config /var/lib/forgejo-runner/config.yml
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now forgejo-runner
echo "Runner '$NAME' läuft. Builds legen ihre Artefakte unter /builds ab (= /mnt/builds auf dem Runner)."
