import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { BrowserManager } from "./browser/browser.ts";
import { Controller } from "./agent/controller.ts";
import { hasApiKey } from "./ai/laya.ts";
import { MODEL, QUESTIONS, T } from "./shared/constants.ts";

export interface ServerOptions { port?: number; host?: string; headless?: boolean; cdp?: string | null; startUrl?: string }
export function parseArgs(argv: string[]): ServerOptions {
  const out: ServerOptions = { port: Number(process.env.PORT) || 8787, host: process.env.HOST || "127.0.0.1", headless: false, cdp: null, startUrl: process.env.START_URL || "https://example.com/" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--headless") out.headless = true;
    else if (a === "--cdp") out.cdp = argv[++i];
    else if (a === "--start-url") out.startUrl = argv[++i];
  }
  return out;
}

export async function startServer(opts: ServerOptions = {}) {
  if (!hasApiKey()) throw new Error("Missing IMPOSSIBL_API_KEY. Copy apps/backend/.env.example to apps/backend/.env and add your key.");
  const browser = new BrowserManager();
  console.log("Launching controlled browser…");
  await browser.launch({ headless: opts.headless, cdp: opts.cdp, startUrl: opts.startUrl });
  console.log("Browser ready; taking initial page snapshot…");
  const controller = new Controller({ browser });
  await controller.start();
  console.log("Agent ready; starting API and WebSocket server…");

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const allowed = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
    if (req.headers.origin === allowed) { res.setHeader("Access-Control-Allow-Origin", allowed); res.setHeader("Vary", "Origin"); }
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.get("/health", (_req, res) => res.json({ status: "ok", model: MODEL }));
  app.get("/api/state", (_req, res) => res.json(controller.uiState()));
  app.get("/api/questions", (_req, res) => res.json({ model: MODEL, thresholds: T, questions: QUESTIONS }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const allowed = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
    if (req.headers.origin && req.headers.origin !== allowed) { socket.destroy(); return; }
    if (req.url !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  const broadcast = (type: string, payload: unknown) => {
    const msg = JSON.stringify({ type, payload });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  };
  controller.on("transcript", (p) => broadcast("transcript", p));
  controller.on("decision", (p) => broadcast("decision", p));
  controller.on("action", (p) => broadcast("action", { ...p, ui: controller.uiState() }));
  controller.on("snapshot", () => broadcast("snapshot", controller.uiState().snapshot));
  controller.on("log", (p) => broadcast("log", p));
  controller.on("candidates", (p) => broadcast("candidates", p));
  controller.on("pending", (p) => broadcast("pending", p));
  controller.on("task", (p) => broadcast("task", p));
  controller.on("tabs", (p) => broadcast("tabs", p));
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() }));
    ws.on("message", (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || typeof msg.type !== "string") return;
      switch (msg.type) {
        case "transcript": if (typeof msg.text === "string") controller.handleTranscript({ text: msg.text.slice(0, 2000), final: Boolean(msg.final), utteranceId: String(msg.utteranceId || Date.now()) }); break;
        case "command": if (typeof msg.text === "string") controller.handleCommand(msg.text.slice(0, 2000)); break;
        case "undo": controller.undo(); break;
        case "snapshot": void controller.refreshSnapshot(); break;
        case "state": ws.send(JSON.stringify({ type: "hello", payload: controller.uiState() })); break;
      }
    });
  });
  const host = opts.host || "127.0.0.1";
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port || 8787, host, resolve); });
  const url = `http://${host}:${opts.port || 8787}`;
  console.log(`\nBrowser agent API ready → ${url}\nmodel ${MODEL} · frontend: ${process.env.FRONTEND_ORIGIN || "http://localhost:3000"}\n`);
  let closing: Promise<void> | null = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      for (const client of wss.clients) client.close(1001, "server shutting down");
      await controller.close();
      await browser.close();
      wss.close();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    })();
    return closing;
  };
  const onSignal = () => { void close().finally(() => process.exit(0)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { app, server, controller, browser, url, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer(parseArgs(process.argv.slice(2))).catch((err) => { console.error(err); process.exitCode = 1; });
}
