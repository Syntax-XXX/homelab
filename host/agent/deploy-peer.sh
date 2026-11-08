#!/bin/sh
# Installs/updates the dashboard stats agent on every other cluster node that is reachable.
SELF=$(hostname)
for PEER in $(pvesh get /cluster/status --output-format json | python3 -c 'import json,sys;[print(n["ip"]) for n in json.load(sys.stdin) if n["type"]=="node" and n.get("ip") and n["name"]!="'$SELF'"]'); do
  SSH="ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/pve/priv/known_hosts root@$PEER"
  ping -c1 -W2 "$PEER" >/dev/null 2>&1 || continue
  LOCAL=$(cat /opt/selfhost-dash-agent/agent.py /etc/selfhost-dash/action_token | sha256sum | cut -d' ' -f1)
  REMOTE=$($SSH "cat /opt/selfhost-dash-agent/agent.py /etc/selfhost-dash/action_token 2>/dev/null | sha256sum | cut -d' ' -f1") || continue
  CODE=$(curl -s -o /dev/null -m 4 -w '%{http_code}' "http://$PEER:9101/stats")
  [ "$LOCAL" = "$REMOTE" ] && [ "$CODE" = "401" ] && continue
  echo "deploying agent to $PEER (http: $CODE)"
  # Tokens per stdin übertragen – tauchen so weder in der lokalen noch in der entfernten Prozessliste auf
  $SSH "mkdir -p /opt/selfhost-dash-agent /etc/selfhost-dash"
  $SSH "umask 077 && cat > /etc/selfhost-dash/token" < /etc/selfhost-dash/token
  $SSH "umask 077 && cat > /etc/selfhost-dash/action_token" < /etc/selfhost-dash/action_token
  $SSH "cat > /opt/selfhost-dash-agent/agent.py" < /opt/selfhost-dash-agent/agent.py
  $SSH "cat > /etc/systemd/system/selfhost-dash-agent.service" < /etc/systemd/system/selfhost-dash-agent.service
  $SSH "chmod 755 /opt/selfhost-dash-agent/agent.py && systemctl daemon-reload && systemctl enable selfhost-dash-agent >/dev/null 2>&1 && systemctl restart selfhost-dash-agent"
  sleep 3; echo "agent on $PEER -> HTTP $(curl -s -o /dev/null -m 4 -w '%{http_code}' "http://$PEER:9101/stats") (401 = running)"
done
