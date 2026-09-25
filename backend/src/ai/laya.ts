// @ts-nocheck
/**
 * The single Laya request per transcript update: build state + speculative question fan-out,
 * call the API, return typed answers with latency / usage / cost.
 *
 * API key stays server-side. Reads IMPOSSIBL_API_KEY.
 */
import { TypeSafeClient, choice, noul, score, APIUserAbortError } from "@typesafe-ai/sdk";
import { MODEL, PRICE_PER_M_INPUT_TOKENS_USD, QUESTIONS, MAX_TRANSCRIPT_CHARS, MAX_CONTEXT_ACTIONS } from "../shared/constants.ts";
import { extractTextCandidates, extractUrlCandidates } from "../shared/spans.ts";

let _client = null;

export function getClient() {
  if (_client) return _client;
  const apiKey = process.env.IMPOSSIBL_API_KEY;
  if (!apiKey) {
    throw new Error("Missing API key: set IMPOSSIBL_API_KEY. See run.sh / .env.example.");
  }
  _client = new TypeSafeClient({
    apiKey,
    baseURL: "https://api.impossibl.com",
    defaultModel: MODEL,
    timeout: 8000,
    retry: { maxRetries: 1, backoffInitialMs: 150, backoffMaxMs: 600 },
    logLevel: "off",
  });
  return _client;
}

export function hasApiKey() {
  return Boolean(process.env.IMPOSSIBL_API_KEY);
}

export function costUsd(usage) {
  const tokens = usage?.input_tokens ?? 0;
  return (tokens / 1_000_000) * PRICE_PER_M_INPUT_TOKENS_USD;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** `e09 link "GitHub - typesafe-ai" → github.com` — short, human-readable, few tokens. */
export function encodeElement(el, pageHost = "") {
  let s = `${el.id} ${el.role}`;
  const text = el.text || "";
  if (text) s += ` "${text}"`;
  if (el.placeholder && el.placeholder !== text) s += ` (placeholder: ${el.placeholder})`;
  if (el.href) {
    const host = el.href.split("/")[0];
    if (host && host !== pageHost) s += ` → ${host}`;
  }
  if (el.below_fold) s += " [below fold]";
  return s;
}

/**
 * Build the state object and question map for one decision.
 * Exported so tests can inspect exactly what Laya sees.
 */
/**
 * Compact conversation context: where the user just came from and the last few executed actions,
 * most recent first. `null` when nothing has happened yet.
 */
export function encodeContext(context) {
  if (!context) return null;
  const out = {};
  if (context.previousPage?.url) {
    out.previous_page = {
      url: String(context.previousPage.url).slice(0, 200),
      title: String(context.previousPage.title || "").slice(0, 120),
    };
  }
  const actions = (context.recentActions || []).slice(-MAX_CONTEXT_ACTIONS).reverse();
  if (actions.length) {
    const now = Date.now();
    out.recent_actions = actions.map((a) => {
      const e = { said: String(a.said || "").slice(0, 120), action: a.type };
      if (a.targetLabel) e.target = String(a.targetLabel).slice(0, 80);
      if (a.text) e.text = String(a.text).slice(0, 80);
      if (a.url) e.url = String(a.url).slice(0, 200);
      e.outcome = a.outcome || (a.ok === false ? "failed" : "done");
      if (a.at) e.seconds_ago = Math.max(0, Math.round((now - a.at) / 1000));
      return e;
    });
  }
  return Object.keys(out).length ? out : null;
}

export function buildRequest({ transcript, snapshot, pendingConfirmation = null, tabs = null, context = null, task = null }) {
  const text = String(transcript || "").slice(-MAX_TRANSCRIPT_CHARS);
  const textCandidates = extractTextCandidates(text);
  const urlCandidates = extractUrlCandidates(text);

  const elements = snapshot?.elements || [];
  const pageHost = hostOf(snapshot?.url);
  const state = {
    transcript: text,
    page: {
      url: (snapshot?.url || "about:blank").slice(0, 200),
      title: (snapshot?.title || "").slice(0, 120),
      site: snapshot?.site || "blank",
    },
    // One compact line per element, in visual order (viewport first). The `target` question's
    // options are these ids; their text lives here (semantic-find pattern) to halve token use.
    elements: elements.map((el) => encodeElement(el, pageHost)),
  };
  const ctx = encodeContext(context);
  if (ctx) state.context = ctx;
  if (task?.goal) {
    state.task = {
      goal: String(task.goal).slice(0, 400),
      completed_actions: (task.actions || []).slice(-5).map(({ action, result }) => ({
        action: (typeof action === "string" ? action : JSON.stringify(action || {})).slice(0, 160),
        result: String(result || "").slice(0, 160),
      })),
    };
  }
  if (pendingConfirmation) state.pending_confirmation = pendingConfirmation;
  if (tabs && tabs.length > 1) state.open_tabs = tabs.length;

  const targetCriteria = {};
  for (const el of elements) targetCriteria[el.id] = null;
  targetCriteria.none = "No element on this page is referred to";

  const questions = {
    intent: choice(QUESTIONS.intent.instructions, QUESTIONS.intent.criteria),
    site: choice(QUESTIONS.site.instructions, QUESTIONS.site.criteria),
    complete: noul(QUESTIONS.complete.instructions, QUESTIONS.complete.criteria),
    is_command: noul(QUESTIONS.is_command.instructions, QUESTIONS.is_command.criteria),
    destructive: noul(QUESTIONS.destructive.instructions, QUESTIONS.destructive.criteria),
    scroll_amount: score(QUESTIONS.scroll_amount.instructions, QUESTIONS.scroll_amount.criteria),
    tab_direction: choice(QUESTIONS.tab_direction.instructions, QUESTIONS.tab_direction.criteria),
  };
  // Choice questions require at least two criteria. With no interactive elements, a lone
  // `none` option is invalid; omit target selection and let policy wait on target intents.
  if (elements.length) {
    questions.target = choice(QUESTIONS.target.instructions, targetCriteria);
  }
  if (ctx?.recent_actions?.length) {
    questions.is_correction = noul(QUESTIONS.is_correction.instructions, QUESTIONS.is_correction.criteria);
  }
  if (task?.continuation) {
    questions.task_status = choice(QUESTIONS.task_status.instructions, QUESTIONS.task_status.criteria);
  }

  if (textCandidates.length) {
    const c = Object.fromEntries(textCandidates.map((s) => [s, null]));
    c.none = "Nothing should be typed or searched";
    questions.text_span = choice(QUESTIONS.text_span.instructions, c);
  }
  if (urlCandidates.length) {
    const c = Object.fromEntries(urlCandidates.map((s) => [s, null]));
    c.none = "No web address is mentioned";
    questions.url_span = choice(QUESTIONS.url_span.instructions, c);
  }

  return { state, questions, candidates: { text: textCandidates, url: urlCandidates } };
}

/**
 * Ask Laya. Resolves to { answers, latencyMs, usage, costUsd, model, requestId, candidates, state }
 * or rejects with APIUserAbortError when `signal` aborts (newer transcript arrived).
 */
export async function decide(input, { signal } = {}) {
  const client = getClient();
  const { state, questions, candidates } = buildRequest(input);
  const t0 = performance.now();
  const { data, requestId } = await client
    .systemOne({ state, questions, model: MODEL }, { signal })
    .withResponse();
  const latencyMs = Math.round(performance.now() - t0);
  return {
    answers: data.answers,
    latencyMs,
    usage: data.usage,
    costUsd: costUsd(data.usage),
    model: data.model,
    requestId,
    candidates,
    state,
    questionCount: Object.keys(questions).length,
  };
}

export function isAbortError(err) {
  return err instanceof APIUserAbortError || err?.name === "AbortError" || err?.name === "APIUserAbortError";
}
