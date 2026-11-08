// Tiny proxy in front of AIOStreams: passes everything through, but /stream/ responses
// only keep cached (⚡) results, so Jellyfin/Gelato never offers torrents that are not instantly playable.
const http = require("node:http");
const UP = process.env.UPSTREAM || "http://aiostreams:3000";
const KEEP = new RegExp(process.env.KEEP || "⚡");
http.createServer(async (req, res) => {
  try {
    const r = await fetch(UP + req.url, { method: req.method, headers: { "user-agent": req.headers["user-agent"] || "streamfilter" }, signal: AbortSignal.timeout(120000) });
    const ct = r.headers.get("content-type") || "";
    if (req.url.includes("/stream/") && ct.includes("json")) {
      const j = await r.json();
      const all = j.streams || [];
      j.streams = all.filter(s => KEEP.test(s.name || ""));
      console.log(`${new Date().toISOString()} ${req.url.split("/stream/")[1]} ${all.length} -> ${j.streams.length}`);
      res.writeHead(r.status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
      return res.end(JSON.stringify(j));
    }
    res.writeHead(r.status, { "content-type": ct, "access-control-allow-origin": "*" });
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(502); res.end(String(e)); }
}).listen(3000, () => console.log("streamfilter ->", UP));
