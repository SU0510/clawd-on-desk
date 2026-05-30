// src/server.js — Minimal HTTP server for local health endpoint

const http = require("http");
const {
  DEFAULT_SERVER_PORT,
  RUNTIME_CONFIG_PATH,
  clearRuntimeConfig,
  getPortCandidates,
  readRuntimePort,
  writeRuntimeConfig,
} = require("../hooks/server-config");

const CLAWD_SERVER_ID = "pomeranian-on-desk";

module.exports = function initServer(ctx) {

  const createHttpServer = ctx.createHttpServer || http.createServer.bind(http);
  const setImmediateFn = ctx.setImmediate || setImmediate;
  const clearRuntimeConfigFn = ctx.clearRuntimeConfig || clearRuntimeConfig;
  const getPortCandidatesFn = ctx.getPortCandidates || getPortCandidates;
  const readRuntimePortFn = ctx.readRuntimePort || readRuntimePort;
  const writeRuntimeConfigFn = ctx.writeRuntimeConfig || writeRuntimeConfig;

  let httpServer = null;
  let activeServerPort = null;

  function getHookServerPort() {
    return activeServerPort || readRuntimePortFn() || DEFAULT_SERVER_PORT;
  }

  function getRuntimeStatus() {
    let address = null;
    try {
      address = httpServer && typeof httpServer.address === "function" ? httpServer.address() : null;
    } catch {
      address = null;
    }
    const addressPort = address && typeof address === "object" && Number.isInteger(address.port)
      ? address.port
      : null;
    const port = activeServerPort || addressPort || null;
    const runtimePort = readRuntimePortFn();
    return {
      listening: !!port && (!httpServer || httpServer.listening !== false),
      port,
      runtimePath: typeof ctx.runtimeConfigPath === "string" ? ctx.runtimeConfigPath : RUNTIME_CONFIG_PATH,
      runtimePort,
      runtimeFileExists: Number.isInteger(runtimePort),
      runtimeMatches: Number.isInteger(port) && runtimePort === port,
    };
  }

  function repairRuntimeStatus() {
    const status = getRuntimeStatus();
    if (status && status.listening && Number.isInteger(status.port)) {
      const written = writeRuntimeConfigFn(status.port);
      return written
        ? { status: "ok" }
        : { status: "error", message: "Failed to write runtime config" };
    }
    if (!httpServer) {
      startHttpServer();
      return { status: "ok" };
    }
    return {
      status: "error",
      message: "Local server is not listening; restart app",
    };
  }

  function startHttpServer() {
    httpServer = createHttpServer((req, res) => {
      if (req.method === "GET" && req.url === "/state") {
        const body = JSON.stringify({ ok: true, app: CLAWD_SERVER_ID, port: getHookServerPort() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const listenPorts = getPortCandidatesFn();
    let listenIndex = 0;
    httpServer.on("error", (err) => {
      if (!activeServerPort && err.code === "EADDRINUSE" && listenIndex < listenPorts.length - 1) {
        listenIndex++;
        httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
        return;
      }
      if (!activeServerPort && err.code === "EADDRINUSE") {
        const firstPort = listenPorts[0];
        const lastPort = listenPorts[listenPorts.length - 1];
        console.warn(`Ports ${firstPort}-${lastPort} are occupied`);
      } else {
        console.error("HTTP server error:", err.message);
      }
    });

    httpServer.on("listening", () => {
      activeServerPort = listenPorts[listenIndex];
      writeRuntimeConfigFn(activeServerPort);
      console.log(`Pomeranian state server listening on 127.0.0.1:${activeServerPort}`);
    });

    httpServer.listen(listenPorts[listenIndex], "127.0.0.1");
  }

  function cleanup() {
    clearRuntimeConfigFn();
    if (httpServer) httpServer.close();
  }

  return {
    startHttpServer,
    getHookServerPort,
    getRuntimeStatus,
    repairRuntimeStatus,
    cleanup,
  };

};
