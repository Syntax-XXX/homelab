# Hält die interne Kuma-Status-Seite "tv" synchron mit allen Monitoren (für Uptime-% im TV-Modus)
from uptime_kuma_api import UptimeKumaApi
api = UptimeKumaApi("http://127.0.0.1:3001", timeout=30)
try:
    api.login()  # Auth ist deaktiviert
except Exception:
    pass
mons = sorted(api.get_monitors(), key=lambda m: m["name"].lower())
slugs = [p["slug"] for p in api.get_status_pages()]
if "tv" not in slugs:
    api.add_status_page("tv", "TV")
api.save_status_page(slug="tv", title="TV", description="Intern fuer den TV-Modus",
    publicGroupList=[{"name": "Alle", "monitorList": [{"id": m["id"]} for m in mons]}])
print("tv status page:", len(mons), "monitors")
api.disconnect()
