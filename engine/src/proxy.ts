import http from "node:http";
import net from "node:net";

/**
 * A local HTTP/CONNECT proxy for Claude Code / Codex running on the phone:
 * those Linux programs can't read Android's DNS settings, so they send
 * traffic here and Node (which can resolve names) connects for them.
 * Listens on 127.0.0.1 only.
 */
export function startEgressProxy(port: number) {
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url ?? "");
      const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => res.writeHead(502).end());
      req.pipe(up);
    } catch {
      res.writeHead(400).end();
    }
  });
  server.on("connect", (req, client, head) => {
    const [host, port] = (req.url ?? "").split(":");
    const up = net.connect(Number(port) || 443, host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  server.listen(port, "127.0.0.1");
  return server;
}
