# JEV Browser Agent

A local voice browser agent that turns spoken or typed instructions into browser actions. It uses the Jev model through Impossibl's API.

## Setup

Install Bun, then copy `backend/.env.example` to `backend/.env` and add your `IMPOSSIBL_API_KEY`.

## Run

From the project root, run:

```sh
./run.sh
```

Open [http://localhost:3000](http://localhost:3000). The backend API runs at `http://127.0.0.1:8787`.

The script checks for the backend and frontend tools before installing dependencies, then starts both development servers with a colored startup summary. Press Ctrl+C to stop them.

## Architecture

The project has two parts:

- `frontend/` is a Next.js app. It provides the browser agent interface and connects to the backend over HTTP and WebSocket.
- `backend/` is a Node.js TypeScript service. It manages Chromium, interprets commands, applies action policy, and streams state and events to the frontend.

```text
┌─────────────────────────────┐
│ Next.js frontend            │
│ microphone, commands, UI    │
└──────────────┬──────────────┘
               │ HTTP state and WebSocket events / commands
               ▼
┌─────────────────────────────┐
│ Backend server              │
│ Express API and WebSocket   │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐       ┌──────────────────────────┐
│ Controller                  │──────▶│ Impossibl Jev API        │
│ transcript and task flow    │◀──────│ typed intent and targets │
└──────────────┬──────────────┘       └──────────────────────────┘
               ▼
┌─────────────────────────────┐
│ Policy and action executor  │
│ checks, confirmation, action│
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Playwright Chromium          │
│ tabs, page snapshot, actions│
└──────────────┬──────────────┘
               └──── updated state and events ────▶ frontend
```

The backend flow is:

1. `server.ts` starts the HTTP API and WebSocket server.
2. `Controller` receives partial or final speech transcripts and typed commands. It debounces updates, cancels stale model requests, and coordinates decisions and browser actions.
3. `ai/laya.ts` sends a compact page snapshot, recent action context, and transcript to the Impossibl API. The API key stays in the backend environment.
4. `agent/policy.ts` checks the model's typed answers against confidence thresholds. Ambiguous targets can be shown as numbered choices, and potentially destructive actions can require confirmation.
5. `browser/executor.ts` performs the approved action through Playwright. The browser snapshot is refreshed and updates are sent to the frontend.

## Backend modules

- `src/server.ts`: API routes, WebSocket events, startup, and shutdown. HTTP endpoints include `/health`, `/api/state`, and `/api/questions`; the WebSocket endpoint is `/ws`.
- `src/agent/controller.ts`: command lifecycle, task progress, confirmation, candidate selection, event log, and usage statistics.
- `src/agent/policy.ts`: action eligibility and safety checks based on intent, target, and destructive-action confidence.
- `src/ai/laya.ts`: builds compact model requests and returns typed decisions, latency, usage, and estimated cost.
- `src/browser/browser.ts`: launches a persistent Chromium profile or attaches to Chrome over CDP, tracks tabs, and captures page state.
- `src/browser/snapshot.ts`: collects and limits visible page elements for decision-making.
- `src/browser/executor.ts`: carries out navigation, search, click, typing, scrolling, history, and tab actions.
- `src/browser/overlay.ts`: browser page overlays for target choices and action feedback.
- `src/shared/constants.ts`: model name, supported sites and intents, size limits, timings, and policy thresholds.
- `src/shared/spans.ts`: transcript cleanup and extraction of text, URL, and numbered candidate references.

## Configuration

The backend reads `IMPOSSIBL_API_KEY` from `backend/.env`. Optional backend settings include `PORT`, `HOST`, `FRONTEND_ORIGIN`, `START_URL`, and `BROWSER_PROFILE_DIR`. The browser opens visibly by default and keeps its profile in `.browser-profile`. To attach to an existing Chrome instance, the backend supports the `--cdp` option.

The frontend API and WebSocket addresses can be changed in `frontend/.env` using `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`. Example values are in the `.env.example` files.
