// @ts-nocheck
/**
 * Orchestrator: transcript updates -> (debounce, cancel stale) -> one Laya request ->
 * policy -> Playwright action -> fresh snapshot. Emits events for the UI / demo / tests.
 */
import { EventEmitter } from "node:events";
import { DEBOUNCE_MS, SILENCE_COMPLETE_MS, CANDIDATE_TTL_MS, MAX_INFLIGHT, MAX_CONTEXT_ACTIONS, MAX_TASK_STEPS, MODEL, T } from "../shared/constants.ts";
import { decide, isAbortError } from "../ai/laya.ts";
import { evaluatePolicy, describe } from "./policy.ts";
import { execute } from "../browser/executor.ts";
import { parseCandidatePick, cleanTranscript } from "../shared/spans.ts";
import { approxTokens } from "../browser/snapshot.ts";

const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const startsNewBrowserTask = (text) => /^(?:please\s+)?(?:open|go\s+to|visit|navigate|search|look\s+up|find|click|tap|press|type|write|enter|select|choose|scroll|reload|refresh|close\s+(?:this\s+)?tab|switch\s+to\s+(?:the\s+)?(?:next|previous)\s+tab)\b/i.test(text.trim());

export class Controller extends EventEmitter {
  [key: string]: any;
  /**
   * @param {{browser: import('../browser/browser.ts').BrowserManager, decideFn?: Function, executeFn?: Function}} opts
   *   decideFn / executeFn are injectable for tests (default: real Laya + Playwright).
   */
  constructor({ browser, decideFn = decide, executeFn = execute }) {
    super();
    this.browser = browser;
    this._decide = decideFn;
    this._execute = executeFn;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.utterance = null; // { id, physicalId, prefix, gen, text, final, startedAt, updatedAt, actedOn, actedText }
    this.consumed = null; // { id: physical utterance id, prefix: executed text (lowercase), gen }
    this.pending = null; // destructive action awaiting "confirm"
    this.candidates = null; // { list: [{n,id,label}], intent: {type,text}, at }
    this.lastDecision = null;
    this.debounceTimer = null;
    this.silenceTimer = null;
    this.inflight = []; // [{ac, text, at}] requests currently awaiting Laya
    this.busy = false;
    this.log = [];
    this.stats = { calls: 0, inputTokens: 0, costUsd: 0, latencies: [], actions: 0, model: MODEL, commandToActionMs: [], decisionMs: [] };
    this.history = [];
    this.task = null;
    this.pausedTask = null;
    // Conversation context sent to Laya with every request (see jev.encodeContext):
    // the page before the last navigation and the last few executed actions.
    this.context = { previousPage: null, recentActions: [] };
    browser.onChange(() => this.emit("tabs", browser.tabInfo()));
  }

  async start() {
    await this.refreshSnapshot();
    this._log("info", `ready — model ${MODEL}, ${this.snapshot.elements.length} elements on ${this.snapshot.url}`);
  }

  _log(level, msg, extra = {}) {
    const entry = { t: Date.now(), level, msg, ...extra };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    this.emit("log", entry);
  }

  async refreshSnapshot() {
    this.snapshot = await this.browser.snapshot();
    this.snapshotAt = Date.now();
    this.emit("snapshot", this.snapshot);
    return this.snapshot;
  }

  /** Typed command fallback: behaves like a final utterance. */
  handleCommand(text) {
    return this.handleTranscript({ text, final: true, utteranceId: `typed-${Date.now()}` });
  }

  /**
   * Called on every partial transcript from the mic (or the demo replay).
   * @param {{text: string, final?: boolean, utteranceId: string|number}} msg
   */
  handleTranscript({ text, final = false, utteranceId }) {
    let clean = cleanTranscript(text);
    const now = Date.now();

    if (/(?:^|\s)(?:stop(?:\s+the)?\s+task|cancel\s+task)$/i.test(clean) && this.task?.status === "running") {
      this.task.status = "stopped";
      for (const req of this.inflight) req.ac.abort();
      this._log("warn", `task stopped by user — ${this.task.goal}`);
      this.emit("task", this.taskState());
      return;
    }

    // One action per utterance — but if the user keeps talking in the same breath
    // ("go to wikipedia ... search for alan turing"), the words after the already-executed
    // command become a fresh virtual utterance (id "<physical>+<n>"). Fewer than two new words
    // ("please") are ignored.
    const consumed = this.consumed;
    let virtualId = utteranceId;
    if (consumed && consumed.id === utteranceId) {
      if (!clean.toLowerCase().startsWith(consumed.prefix)) return; // recognizer revised the executed words; ignore
      clean = clean.slice(consumed.prefix.length).trim();
      if (clean.split(/\s+/).filter(Boolean).length < 2) return;
      virtualId = `${utteranceId}+${consumed.gen}`;
    }

    if (!this.utterance || this.utterance.id !== virtualId) {
      const confirmingTask = this.pending && this.pausedTask && /^(?:confirm|yes|do it)$/i.test(clean);
      const resumeTask = !confirmingTask && this.task?.status === "needs_input" && !startsNewBrowserTask(clean);
      this.utterance = {
        id: virtualId,
        physicalId: utteranceId,
        prefix: consumed && consumed.id === utteranceId ? consumed.prefix : "",
        gen: consumed && consumed.id === utteranceId ? consumed.gen : 0,
        text: clean,
        final,
        startedAt: now,
        updatedAt: now,
        actedOn: false,
        actedText: null,
        silenceEvaluated: false,
      };
      if (confirmingTask) {
        this.task = this.pausedTask;
        this.task.utteranceId = virtualId;
        this.task.status = "running";
        this.pausedTask = null;
      } else if (resumeTask) {
        this.task.goal = `${this.task.goal}\nUser clarification: ${clean}`.slice(0, 400);
        this.task.utteranceId = virtualId;
        this.task.status = "running";
        this.utterance.actedOn = true;
        this.utterance.actedText = clean;
      } else {
        this.task = { utteranceId: virtualId, goal: clean, actions: [], status: "running", requestVersion: 0 };
      }
      if (virtualId !== utteranceId) this._log("debug", `continuing utterance → new command "${clean}"`);
    } else {
      if (clean === this.utterance.text && final === this.utterance.final) return;
      if (clean !== this.utterance.text) this.utterance.silenceEvaluated = false;
      this.utterance.text = clean;
      this.utterance.final = final || this.utterance.final;
      this.utterance.updatedAt = now;
      if (!this.utterance.actedOn && this.task?.utteranceId === virtualId) this.task.goal = clean;
      if (this.utterance.actedOn && this.task?.utteranceId === virtualId && this.task.status === "running") {
        this.task.requestVersion = (this.task.requestVersion || 0) + 1;
        for (const req of this.inflight) if (req.task === this.task) req.ac.abort();
      }
    }
    this.emit("transcript", { text: clean, final, utteranceId: virtualId, actedOn: this.utterance.actedOn });
    this.emit("task", this.taskState());
    if (this.utterance.actedOn && this.task?.utteranceId === virtualId && this.task.status === "running" && this.task.goal.includes("User clarification:")) {
      clearTimeout(this.debounceTimer);
      clearTimeout(this.silenceTimer);
      this.debounceTimer = setTimeout(() => this.decideNow("task-clarification", true), final ? 0 : DEBOUNCE_MS);
      return;
    }
    if (!clean || this.utterance.actedOn) return;

    // Deterministic shortcut: numbered candidate overlays + a spoken number => no Laya needed.
    if (this.candidates && now - this.candidates.at < CANDIDATE_TTL_MS) {
      const n = parseCandidatePick(clean, this.candidates.list.length);
      if (n) {
        const c = this.candidates.list[n - 1];
        const task = this.candidates.task ?? null;
        this._consume(this.utterance, clean);
        this._log("info", `picked candidate ${n} (${c.label}) by number — no model call`);
        const action = { ...this.candidates.intent, targetId: c.id, label: c.label };
        this.candidates = null;
        if (task) {
          task.utteranceId = virtualId;
          task.status = "running";
          this.task = task;
        }
        this._runAction(action, { via: "candidate-pick", utterance: this.utterance, task })
          .then(() => this._advanceTaskAfterAction(task, this.utterance));
        return;
      }
    }

    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    this.debounceTimer = setTimeout(() => this.decideNow("debounce"), final ? 0 : DEBOUNCE_MS);
  }

  /** Mark `text` of this utterance as executed so later words in the same breath start a new command. */
  _consume(utt, text) {
    utt.actedOn = true;
    utt.actedText = text;
    this.consumed = {
      id: utt.physicalId,
      prefix: `${utt.prefix} ${text}`.trim().toLowerCase(),
      gen: (utt.gen || 0) + 1,
    };
  }

  /** Ask Laya about the current utterance. Cancels any in-flight request. */
  async decideNow(trigger = "manual", taskContinuation = false) {
    const utt = this.utterance;
    const taskAtRequest = this.task;
    if (!utt || !utt.text || (utt.actedOn && !taskContinuation)) return;
    if (taskContinuation && (!taskAtRequest || taskAtRequest.utteranceId !== utt.id || taskAtRequest.status !== "running")) return;
    if (this.busy) {
      // An action is executing; re-evaluate once it finishes.
      this.silenceTimer = setTimeout(() => this.decideNow("after-action"), 150);
      return;
    }
    // Allow up to MAX_INFLIGHT overlapping requests (a request for the previous partial may
    // still be useful — if the words already commit to an action we act on it). Anything older
    // is stale and gets cancelled via AbortSignal.
    while (this.inflight.length >= MAX_INFLIGHT) {
      const old = this.inflight.shift();
      old.ac.abort();
    }
    const ac = new AbortController();
    const textAtRequest = taskContinuation ? taskAtRequest.goal : utt.text;
    const taskVersion = taskContinuation ? (taskAtRequest.requestVersion = (taskAtRequest.requestVersion || 0) + 1) : 0;
    const req = { ac, text: textAtRequest, task: taskAtRequest, taskVersion, at: Date.now() };
    this.inflight.push(req);

    if (Date.now() - this.snapshotAt > 1500) {
      try {
        await this.refreshSnapshot();
      } catch (err) {
        this.inflight = this.inflight.filter((r) => r !== req);
        this._log("error", `page snapshot failed: ${err.message || err}`);
        if (taskContinuation && this.task === taskAtRequest) {
          taskAtRequest.status = "needs_input";
          this.emit("task", this.taskState());
        }
        return;
      }
    }

    let result;
    try {
      result = await this._decide(
        {
          transcript: textAtRequest,
          snapshot: this.snapshot,
          pendingConfirmation: this.pending ? describe(this.pending) : null,
          tabs: this.browser.tabInfo(),
          context: this.context,
          task: taskAtRequest ? { goal: taskAtRequest.goal, actions: taskAtRequest.actions, continuation: taskContinuation } : null,
        },
        { signal: ac.signal },
      );
    } catch (err) {
      this.inflight = this.inflight.filter((r) => r !== req);
      if (isAbortError(err) || ac.signal.aborted) {
        this._log("debug", `cancelled stale request for "${textAtRequest}"`);
        return;
      }
      this._log("error", `Laya error: ${err.message || err}`);
      // EventEmitter treats an unhandled "error" event as a process-fatal exception.
      // The log event already carries the failure to the UI; keep the server alive so
      // the user can retry with the next utterance.
      this.emit("apiError", err);
      if (taskContinuation && this.task === taskAtRequest) {
        taskAtRequest.status = "needs_input";
        this.emit("task", this.taskState());
      }
      return;
    }
    this.inflight = this.inflight.filter((r) => r !== req);
    if (ac.signal.aborted || this.utterance !== utt || this.task !== taskAtRequest || taskAtRequest?.status !== "running" || (taskContinuation && taskAtRequest.requestVersion !== taskVersion) || (utt.actedOn && !taskContinuation)) return;

    this.stats.calls += 1;
    this.stats.inputTokens += result.usage?.input_tokens ?? 0;
    this.stats.costUsd += result.costUsd;
    this.stats.latencies.push(result.latencyMs);
    if (this.stats.latencies.length > 200) this.stats.latencies.shift();
    if (result.model && result.model !== this.stats.model) this.stats.model = result.model;

    // If more words arrived while this request was in flight, its transcript is a prefix of the
    // real one: it may still act on closed-set intents (the words already commit to "go back"),
    // but it must never be treated as final/silent — free-text payloads would be truncated.
    const stale = !taskContinuation && utt.text !== textAtRequest;
    const silentMs = stale ? 0 : Date.now() - utt.updatedAt;
    const policy = evaluatePolicy({
      answers: result.answers,
      candidates: result.candidates,
      snapshot: this.snapshot,
      transcript: textAtRequest,
      silentMs,
      isFinal: taskContinuation || (utt.final && !stale),
      pending: this.pending,
      context: this.context,
      taskContinuation,
    });

    const decision = {
      transcript: textAtRequest,
      trigger,
      decisionLagMs: Math.max(0, Date.now() - utt.updatedAt), // last spoken word -> decision available
      answers: result.answers,
      candidates: result.candidates,
      latencyMs: result.latencyMs,
      usage: result.usage,
      costUsd: result.costUsd,
      model: result.model,
      requestId: result.requestId,
      questionCount: result.questionCount,
      stateTokens: approxTokens(result.state),
      policy,
      taskContinuation,
      silentMs,
      thresholds: T,
      at: Date.now(),
    };
    this.lastDecision = decision;
    this.emit("decision", decision);
    this._log(
      policy.decision === "act" ? "act" : "info",
      `${result.latencyMs}ms · "${textAtRequest}" → ${policy.decision}: ${policy.summary}`,
    );

    switch (policy.decision) {
      case "act":
        if (taskContinuation && taskAtRequest.actions.length && this._sameAction(taskAtRequest.actions.at(-1).action, policy.action)) {
          taskAtRequest.status = "needs_input";
          this._log("warn", `task paused — Laya repeated ${describe(policy.action)} without page progress`);
          await this.browser.overlay("toast", "Task paused — the next step did not change", 5000);
          this.emit("task", this.taskState());
          break;
        }
        if (!taskContinuation) this._consume(utt, textAtRequest);
        if (policy.action.confirmed) this.pending = null;
        this.candidates = null;
        await this._runAction(policy.action, { decision, utterance: utt, task: taskAtRequest });
        await this._advanceTaskAfterAction(taskAtRequest, utt);
        break;
      case "complete":
        taskAtRequest.status = "complete";
        this._log("act", `✓ task complete — ${taskAtRequest.goal}`);
        this.emit("task", this.taskState());
        break;
      case "clarify":
        taskAtRequest.status = "needs_input";
        this._log("warn", `${policy.summary} — ${taskAtRequest.goal}`);
        await this.browser.overlay("toast", policy.summary, 5000);
        this.emit("task", this.taskState());
        break;
      case "confirm":
        this._consume(utt, textAtRequest);
        this.pending = policy.action;
        taskAtRequest.status = "needs_input";
        this.pausedTask = taskAtRequest;
        this.emit("task", this.taskState());
        await this.browser.overlay("toast", `Say "confirm" to ${describe(policy.action)}`, 6000);
        this.emit("pending", { action: policy.action, summary: policy.summary });
        break;
      case "cancel":
        this._consume(utt, textAtRequest);
        this.pending = null;
        if (this.pausedTask) {
          this.pausedTask.status = "stopped";
          this.pausedTask = null;
        }
        await this.browser.overlay("toast", "cancelled");
        this.emit("pending", null);
        break;
      case "disambiguate": {
        const list = policy.candidates.map((c, i) => ({ n: i + 1, id: c.id, label: c.label, p: c.p }));
        taskAtRequest.status = "needs_input";
        this.candidates = { list, intent: policy.pendingIntent, at: Date.now(), task: taskAtRequest };
        this.emit("task", this.taskState());
        await this.browser.overlay("candidates", list, CANDIDATE_TTL_MS);
        await this.browser.overlay("toast", "Which one? Say the number.", 3000);
        this.emit("candidates", list);
        this._scheduleSilenceRetry(utt);
        break;
      }
      case "wait":
        if (taskContinuation) {
          taskAtRequest.status = "needs_input";
          await this.browser.overlay("toast", policy.summary || "I need more information to continue", 5000);
          this.emit("task", this.taskState());
        } else this._scheduleSilenceRetry(utt, policy.retryInMs);
        break;
      default:
        break;
    }
  }

  /** If the user stops talking, re-evaluate with silentMs so `complete` is bypassed. */
  _scheduleSilenceRetry(utt, retryInMs = null) {
    clearTimeout(this.silenceTimer);
    const waitFor = retryInMs ?? Math.max(50, SILENCE_COMPLETE_MS - (Date.now() - utt.updatedAt));
    // A low-confidence result won't improve by repeatedly sending the same transcript.
    // Allow earlier staged retries (for example, payload completion at 600 ms), but only
    // one model re-check after the full silence-completion threshold.
    if (utt.silenceEvaluated && Date.now() - utt.updatedAt + waitFor >= SILENCE_COMPLETE_MS) return;
    this.silenceTimer = setTimeout(() => {
      if (this.utterance === utt && !utt.actedOn) {
        if (Date.now() - utt.updatedAt >= SILENCE_COMPLETE_MS) utt.silenceEvaluated = true;
        this.decideNow("silence");
      }
    }, waitFor);
  }

  _sameAction(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    return ["url", "targetId", "text", "direction", "amount"].every((key) => (a[key] ?? null) === (b[key] ?? null));
  }

  async _advanceTaskAfterAction(task, utt) {
    if (!task || this.task !== task || this.utterance !== utt || task.status !== "running") return;
    if (task.actions.length >= MAX_TASK_STEPS) {
      task.status = "step_limit";
      this._log("warn", `task paused at the ${MAX_TASK_STEPS}-action safety limit`);
      await this.browser.overlay("toast", "Task paused at the action limit", 5000);
      this.emit("task", this.taskState());
    } else if (task.actions.at(-1)?.ok) {
      const lastAction = task.actions.at(-1).action;
      const searchStep = task.goal.match(/\b(?:and|then)\s+(?:search(?:\s+for)?|look\s+up|find|google)\s+(.+?)(?:\s+((?:and\s+then|then|and)\s+(?:click|tap|open|select|choose|go\s+to|navigate|visit|scroll|type|press)\b)|[.!?]*$)/i);
      const hasLaterStep = Boolean(searchStep?.[2]);
      if (lastAction?.query && searchStep && !hasLaterStep && this.snapshot?.url === lastAction.url) {
        task.status = "complete";
        this._log("act", `✓ task complete — search results opened for ${lastAction.query}`);
        this.emit("task", this.taskState());
        return;
      }
      await this.decideNow("task-follow-up", true);
    } else {
      task.status = "failed";
      this.emit("task", this.taskState());
    }
  }

  taskState() {
    if (!this.task) return null;
    return {
      goal: this.task.goal,
      status: this.task.status,
      step: this.task.actions.length,
      maxSteps: MAX_TASK_STEPS,
      actions: this.task.actions.map(({ action, result }) => ({ action: describe(action), result })),
    };
  }

  async _runAction(action, meta = {}) {
    this.busy = true;
    const t0 = Date.now();
    const utt = meta.utterance || this.utterance;
    const pageBefore = this.snapshot ? { url: this.snapshot.url, title: this.snapshot.title, site: this.snapshot.site } : null;
    try {
      const res = await this._execute(action, this.browser);
      const took = Date.now() - t0;
      const sinceLastWord = utt ? Date.now() - utt.updatedAt : null;
      const sinceUtteranceStart = utt ? Date.now() - utt.startedAt : null;
      this.stats.actions += 1;
      if (sinceLastWord != null) this.stats.commandToActionMs.push(sinceLastWord);
      if (meta.decision?.decisionLagMs != null) this.stats.decisionMs.push(meta.decision.decisionLagMs);
      this.history.push({ action, at: Date.now(), url: res.detail });
      if (meta.task && this.task === meta.task && meta.task.utteranceId === utt?.id) {
        meta.task.actions.push({ action, result: res.ok ? (res.detail || "done") : (res.detail || "failed"), ok: Boolean(res.ok) });
        this.emit("task", this.taskState());
      }
      this._recordContext({ action, ok: res.ok, detail: res.detail, said: meta.decision?.transcript || utt?.actedText || "", pageBefore });
      const decisionMs = meta.decision?.decisionLagMs ?? null;
      const entry = {
        action,
        ok: res.ok,
        detail: res.detail,
        executeMs: took,
        decisionMs, // last word -> decision
        sinceLastWordMs: sinceLastWord, // last word -> action finished (includes page load)
        sinceUtteranceStartMs: sinceUtteranceStart,
        via: meta.via || "laya",
      };
      this._log(res.ok ? "act" : "warn", `${res.ok ? "✓" : "✗"} ${describe(action)} — decided ${decisionMs ?? "?"}ms after last word, executed in ${took}ms ${res.detail || ""}`);
      this.emit("action", entry);
    } catch (err) {
      this._log("error", `action failed: ${describe(action)} — ${err.message || err}`);
      if (meta.task && this.task === meta.task && meta.task.utteranceId === utt?.id) {
        meta.task.actions.push({ action, result: String(err.message || err), ok: false });
      }
      this.emit("action", { action, ok: false, detail: String(err.message || err) });
    } finally {
      this.busy = false;
      await this.refreshSnapshot().catch(() => {});
    }
  }

  /**
   * Remember what was just done so the next Laya request can resolve "back to the results",
   * "the other one", "not that one". Called after every executed action; the page snapshot is
   * refreshed by the caller right after, so `outcome` is derived from the post-action URL.
   */
  _recordContext({ action, ok, detail, said, pageBefore }) {
    const after = this.browser.currentUrl?.() ?? null;
    const navigated = pageBefore && after && after !== pageBefore.url;
    if (navigated) this.context.previousPage = pageBefore;
    let outcome = ok ? "done" : "failed";
    if (ok && navigated) outcome = `navigated to ${after.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}`;
    else if (ok && typeof detail === "string" && detail && !detail.startsWith("http")) outcome = detail.slice(0, 80);
    this.context.recentActions.push({
      type: action.type,
      targetId: action.targetId ?? null,
      targetLabel: action.label ?? null,
      text: action.text ?? null,
      url: action.url ?? null,
      said,
      ok,
      outcome,
      at: Date.now(),
    });
    if (this.context.recentActions.length > MAX_CONTEXT_ACTIONS) this.context.recentActions.shift();
  }

  /** "Undo" = go back in history. */
  async undo() {
    await this._runAction({ type: "go_back", label: "undo (back)" }, { via: "undo" });
  }

  uiState() {
    const lat = this.stats.latencies;
    const sorted = [...lat].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      model: this.stats.model,
      thresholds: T,
      stats: {
        calls: this.stats.calls,
        actions: this.stats.actions,
        inputTokens: this.stats.inputTokens,
        costUsd: this.stats.costUsd,
        lastLatencyMs: lat[lat.length - 1] ?? null,
        p50LatencyMs: p50,
        avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        avgCommandToActionMs: avg(this.stats.commandToActionMs),
        avgDecisionMs: avg(this.stats.decisionMs),
      },
      snapshot: this.snapshot && {
        url: this.snapshot.url,
        title: this.snapshot.title,
        site: this.snapshot.site,
        searchBoxId: this.snapshot.searchBoxId,
        elements: this.snapshot.elements,
        tabs: this.snapshot.tabs,
      },
      lastDecision: this.lastDecision,
      context: this.context,
      task: this.taskState(),
      pending: this.pending ? { summary: describe(this.pending) } : null,
      candidates: this.candidates?.list ?? null,
      log: this.log.slice(-60),
    };
  }

  async close() {
    clearTimeout(this.debounceTimer);
    clearTimeout(this.silenceTimer);
    for (const r of this.inflight) r.ac.abort();
    this.inflight = [];
  }
}
