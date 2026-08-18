const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const role = String(process.env.SERVICE_ROLE || "dylan-heartbeat").trim().toLowerCase();

function startHealthOnly(roleName) {
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, role: roleName }));
  });
  server.listen(port, "0.0.0.0", () => {
    console.log("Railway entry running without background worker", { role: roleName, port });
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (role === "disabled") {
  // Manual parking mode for long-lived SSE services. Railway uses rolling deploys,
  // so park the service first, wait for the old container to terminate, then
  // explicitly switch back to garden-wake. This avoids overlapping Garden SSE connections.
  startHealthOnly("disabled");
} else if (role !== "garden-wake") {
  require("./railway_start.js");
} else {
  const port = Number(process.env.PORT) || 8080;
  let stopping = false;
  let childExited = false;

  const healthServer = http.createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
      return;
    }
    if (childExited) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, role: "garden-wake" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, role: "garden-wake" }));
  });

  const worker = spawn(process.execPath, [path.join(__dirname, "garden_bridge_worker.js")], {
    cwd: __dirname,
    env: process.env,
    stdio: "inherit"
  });

  function finish(exitCode) {
    if (stopping) return;
    stopping = true;
    childExited = true;
    healthServer.close(() => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 1000).unref();
  }

  function forward(signal) {
    if (stopping) return;
    stopping = true;
    if (!worker.killed) worker.kill(signal);
    childExited = true;
    healthServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }

  worker.on("error", error => {
    console.error("Garden wake worker failed to start", {
      name: error?.name || "Error",
      message: error?.message || String(error)
    });
    finish(1);
  });

  worker.on("exit", (code, signal) => {
    if (stopping) return;
    console.error("Garden wake worker exited", {
      code: code ?? null,
      signal: signal || null,
      automatic_restart: false
    });
    finish(code && code > 0 ? code : 1);
  });

  healthServer.listen(port, "0.0.0.0", () => {
    console.log("Garden wake Railway entry ready", {
      port,
      automatic_restart: false
    });
  });

  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}
