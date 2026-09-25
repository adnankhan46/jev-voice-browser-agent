// @ts-nocheck
/**
 * Execution policy: pure code that turns model answers into ACT / WAIT / IGNORE / CONFIRM /
 * DISAMBIGUATE. Every gate is a number from constants.js so the UI can show WHY.
 */
import {
  T,
  TARGET_INTENTS,
  SITE_HOME,
  SITE_SEARCH,
  DEFAULT_SEARCH_ENGINE,
  SILENCE_COMPLETE_MS,
  PAYLOAD_SILENCE_MS,
  PAYLOAD_INTENTS,
} from "../shared/constants.ts";
import { toHttpUrl } from "../shared/spans.ts";

const r2 = (x) => Math.round(x * 100) / 100;

function check(reasons, name, value, threshold, pass, note) {
  reasons.push({ name, value: typeof value === "number" ? r2(value) : value, threshold, pass, note });
  return pass;
}

/** Top-N choice options by probability, excluding `none`. */
export function topChoices(choiceAnswer, n = 3) {
  if (!choiceAnswer?.probabilities) return [];
  return Object.entries(choiceAnswer.probabilities)
    .filter(([k]) => k !== "none")
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => ({ id, p: r2(p) }));
}

function pickSpan(answer, minConfidence, fallback) {
  if (!answer) return fallback ?? null;
  if (answer.choice === "none") return null;
  if (answer.confidence < minConfidence) return fallback ?? answer.choice;
  return answer.choice;
}

function fillTemplate(tpl, q) {
  return tpl.replace("%s", encodeURIComponent(q));
}

const SITE_ALIASES = {
  google: ["google"],
  duckduckgo: ["duckduckgo", "duck duck go"],
  youtube: ["youtube", "you tube"],
  wikipedia: ["wikipedia", "wiki"],
  github: ["github", "git hub"],
  amazon: ["amazon"],
  reddit: ["reddit"],
  twitter_x: ["twitter x", "twitter", "x"],
  hacker_news: ["hacker news", "hackernews", "news ycombinator"],
  example_com: ["example dot com", "example.com", "example"],
  the_web: ["the web", "web"],
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findNamedSite(text) {
  const aliases = Object.entries(SITE_ALIASES)
    .flatMap(([site, names]) => names.map((name) => ({ site, name })))
    .sort((a, b) => b.name.length - a.name.length);
  for (const { site, name } of aliases) {
    if (new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(name)}(?:$|[^a-z0-9])`, "i").test(text)) return site;
    // Speech recognition occasionally drops the final sound ("youtub") or changes one
    // character. Permit one edit for long, single-word brand names only.
    if (!name.includes(" ") && name.length >= 5) {
      const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
      if (words.some((word) => distanceAtMostOne(word, name))) return site;
    }
  }
  return null;
}

function distanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

function normalizeSpeechCommand(transcript) {
  const text = String(transcript || "").trim();
  const words = text.split(/\s+/);
  const first = words[0]?.toLowerCase().replace(/[.,!?]+$/g, "");
  const commands = new Set(["open", "go", "visit", "navigate", "search", "scroll", "back", "forward", "close", "switch", "new"]);
  if (first?.length > 2 && first[0] === first[1] && commands.has(first.slice(1))) words[0] = words[0].slice(1);
  return words.join(" ");
}

function parseDirectBrowserAction(transcript) {
  const t = normalizeSpeechCommand(transcript).toLowerCase().replace(/[.!?]+$/g, "").trim();
  if (/^(?:(?:please|hey browser)\s+)?(?:open\s+)?(?:a\s+)?new\s+tab$/.test(t)) return "open_new_tab";
  if (/^(?:(?:please|hey browser)\s+)?close\s+(?:this\s+)?tab$/.test(t)) return "close_tab";
  if (/^(?:(?:please|hey browser)\s+)?(?:switch\s+to\s+)?(?:the\s+)?(?:next|following)\s+tab$/.test(t)) return "switch_tab_next";
  if (/^(?:(?:please|hey browser)\s+)?(?:switch\s+to\s+)?(?:the\s+)?(?:previous|last)\s+tab$/.test(t)) return "switch_tab_previous";
  if (/^(?:(?:please|hey browser)\s+)?(?:go\s+)?back(?:\s+to\s+the\s+previous\s+page)?$/.test(t) || /^(?:undo|go back)$/.test(t)) return "go_back";
  if (/^(?:(?:please|hey browser)\s+)?(?:go\s+)?forward$/.test(t) || /^next page$/.test(t)) return "go_forward";
  if (/\bscroll\b/.test(t)) {
    if (/\b(?:up|top|back up)\b/.test(t)) return "scroll_up";
    if (/\b(?:down|bottom|end)\b/.test(t)) return "scroll_down";
  }
  return null;
}

function parseDirectNavigation(transcript, candidates) {
  const match = normalizeSpeechCommand(transcript).match(/^\s*(?:(?:please|hey browser)\s+)?(?:go to|open|visit|navigate to|take me to)\s+(.+)$/i);
  if (!match) return null;
  // A spoken domain is more specific than a brand alias.
  if (candidates?.url?.length) return { url: candidates.url[0] };
  const site = findNamedSite(match[1]);
  return site && SITE_HOME[site] ? { site } : null;
}

function parseDirectSearch(transcript) {
  const match = normalizeSpeechCommand(transcript).match(/^\s*(?:(?:please|hey browser)\s+)?(search|look\s+up|find|google)\s+(.+?)\s*[.!?]*$/i);
  if (!match) return null;
  const verb = match[1].toLowerCase().replace(/\s+/g, " ");
  let rest = match[2].trim();
  let site = verb === "google" ? "google" : null;

  const aliases = Object.entries(SITE_ALIASES)
    .filter(([id]) => id !== "the_web")
    .flatMap(([id, names]) => names.map((name) => ({ id, name })))
    .sort((a, b) => b.name.length - a.name.length);
  let siteSearch = false;
  for (const { id, name } of aliases) {
    const specific = rest.match(new RegExp(`^(?:(?:on|in)\\s+)?${escapeRegExp(name)}\\s+for\\s+(.+)$`, "i"));
    if (specific) {
      site = id;
      rest = specific[1].trim();
      siteSearch = true;
      break;
    }
  }

  if (!siteSearch && /^for\s+/i.test(rest)) rest = rest.replace(/^for\s+/i, "");
  const nextStep = rest.search(/(?:,\s*|\s+)(?:(?:and|then)\s+)?(?:click|tap|open|select|choose|go\s+to|navigate\s+to|visit|scroll|type|press)\s+/i);
  if (nextStep > 0) rest = rest.slice(0, nextStep).trim();
  const query = rest.replace(/[.!?]+$/g, "").trim();
  return query ? { query, site: site || "the_web" } : null;
}

/** Find an explicit search step left after an already completed navigation. */
function parseRemainingTaskSearch(transcript, snapshot) {
  const normalized = normalizeSpeechCommand(transcript);
  const match = normalized.match(/\b(?:and|then)\s+(?:search(?:\s+for)?|look\s+up|find|google)\s+(.+?)\s*[.!?]*$/i);
  if (!match) return null;
  const query = match[1].trim();
  if (!query) return null;
  const namedSite = findNamedSite(normalized);
  const site = namedSite && SITE_SEARCH[namedSite]
    ? namedSite
    : (snapshot?.site && SITE_SEARCH[snapshot.site] ? snapshot.site : DEFAULT_SEARCH_ENGINE);
  return { query, site };
}

/**
 * @param {object} p
 * @param {object} p.answers   model answers (intent, target, site, complete, is_command, destructive, scroll_amount, text_span?, url_span?, tab_direction)
 * @param {object} p.candidates {text: string[], url: string[]}
 * @param {object} p.snapshot  current page snapshot (elements, searchBoxId, site, url)
 * @param {number} p.silentMs  ms since the transcript last changed
 * @param {boolean} p.isFinal  the speech recognizer marked this utterance final
 * @param {object|null} p.pending  a pending destructive action awaiting "confirm"
 * @param {boolean} p.confirmed  user already said confirm for this action
 * @returns {{decision: string, action?: object, candidates?: Array, reasons: Array, summary: string}}
 */
export function evaluatePolicy({ answers, candidates, snapshot, transcript = "", silentMs = 0, isFinal = false, pending = null, context = null, taskContinuation = false }) {
  const reasons = [];
  if (taskContinuation) {
    const remainingSearch = parseRemainingTaskSearch(transcript, snapshot);
    if (remainingSearch) {
      const url = fillTemplate(SITE_SEARCH[remainingSearch.site], remainingSearch.query);
      if (snapshot?.url !== url) {
        check(reasons, "task_plan", `${remainingSearch.site} search: ${remainingSearch.query}`, "explicit remaining search step", true, "query extracted from the user's original multi-step instruction");
        return { decision: "act", action: { type: "navigate_url", url, label: `search ${remainingSearch.site}: ${remainingSearch.query}`, query: remainingSearch.query }, reasons, summary: `search ${remainingSearch.site}: ${remainingSearch.query}` };
      }
    }
  }
  if (taskContinuation) {
    const status = answers.task_status?.choice;
    const confidence = answers.task_status?.confidence ?? 0;
    if (status === "complete" && confidence >= T.intentConfidence) {
      check(reasons, "task_status", status, T.intentConfidence, true, "goal completed");
      return { decision: "complete", reasons, summary: "goal completed" };
    }
    if (status === "clarify" && confidence >= T.intentConfidence) {
      check(reasons, "task_status", status, T.intentConfidence, true, "user input is needed before continuing");
      return { decision: "clarify", reasons, summary: "I need more information to continue" };
    }
    if (status !== "continue" || confidence < T.intentConfidence) {
      check(reasons, "task_status", `${status ?? "none"} (${r2(confidence)})`, T.intentConfidence, false, "no confident next step");
      return { decision: "clarify", reasons, summary: "I could not determine a safe next step" };
    }
    check(reasons, "task_status", status, T.intentConfidence, true, "a next step is needed");
  }
  const intent = answers.intent;
  const intentName = intent?.choice ?? "none";
  const lastAction = context?.recentActions?.length ? context.recentActions[context.recentActions.length - 1] : null;
  const correction = answers.is_correction?.noul ?? 0;
  // The model's correction score is useful only when the words actually sound like a correction.
  // Otherwise an ordinary follow-up such as "search iPhone 16" can undo the prior navigation.
  const finishedPhrase = (answers.complete?.noul ?? 0) >= T.complete || silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const correctionCue = /^\s*(?:undo\b|wrong\b|not that\b|the other one\b|i meant\b|that's not\b|that wasn't\b|no\s*[,;:]?\s+(?:not\b|wrong\b|that\b|the other\b|the second\b|the first\b|undo\b|i meant\b))/i.test(transcript);
  const isCorrection = !taskContinuation && Boolean(lastAction) && correction >= T.correction && finishedPhrase && correctionCue;

  // 0. Confirm / cancel handling for a pending destructive action.
  if (pending) {
    if (intentName === "confirm" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `confirm (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action confirmed");
      return { decision: "act", action: { ...pending, confirmed: true }, reasons, summary: `confirmed: ${describe(pending)}` };
    }
    if (intentName === "cancel" && intent.confidence >= T.intentConfidence) {
      check(reasons, "intent", `cancel (${r2(intent.confidence)})`, T.intentConfidence, true, "pending action cancelled");
      return { decision: "cancel", reasons, summary: "cancelled pending action" };
    }
  }

  // 1. Correction of the previous action ("no, not that one", "wrong link, undo"). A bare "no"
  // is a reaction to the browser, not a fresh imperative, so this runs before the is_command gate.
  // When the user rejects what just happened and names no new target, reverse it; when they do
  // name a new target ("no, the other one") fall through and exclude the previous target below.
  if (isCorrection) {
    check(reasons, "is_correction", correction, T.correction, true, `rejects previous action: ${describe(lastAction)}`);
    const confidentIntent = intentName !== "none" && (intent?.confidence ?? 0) >= T.intentConfidence;
    // "the other one" names a new element; "not that one" alone does not (target comes back `none`
    // or the element just acted on) — the latter is a plain reversal.
    const namesNewTarget =
      TARGET_INTENTS.has(intentName) && topChoices(answers.target, 2).some((c) => c.id !== lastAction.targetId && c.p >= T.targetTopProb);
    // A confident closed-set command ("go back", "scroll down", "open youtube") said after a scroll
    // or click is what it says, not a request to reverse the last action: fall through to normal
    // handling. Only an unconfident / target-less correction is treated as "undo that".
    const reverse = lastAction.type !== "go_back" && (!confidentIntent || (TARGET_INTENTS.has(intentName) && !namesNewTarget));
    if (reverse) {
      const reversal = reverseAction(lastAction);
      return { decision: "act", action: reversal, reasons, summary: `correction → ${describe(reversal)}` };
    }
  }

  // 1b. Is the user talking to the browser at all?
  const isCmd = answers.is_command?.noul ?? 0;
  const directNavigation = taskContinuation ? null : parseDirectNavigation(transcript, candidates);
  const directSearch = taskContinuation ? null : parseDirectSearch(transcript);
  const directBrowserAction = taskContinuation ? null : parseDirectBrowserAction(transcript);
  const directCommand = Boolean(directNavigation || directSearch || directBrowserAction);
  const isCommand = isCmd >= T.isCommand || directCommand || taskContinuation;
  if (!check(reasons, "is_command", isCmd, T.isCommand, isCommand, directCommand ? "explicit navigation/search phrase recognized in code" : "user is addressing the browser")) {
    return { decision: "ignore", reasons, summary: "not a browser command" };
  }

  // 2. Is there a confident intent?
  const conf = intent?.confidence ?? 0;
  const normalizedTranscript = normalizeSpeechCommand(transcript);
  const explicitNavigation = /^\s*(?:(?:please|hey browser)\s+)?(?:go to|open|visit|navigate to|take me to)\s+/i.test(normalizedTranscript);
  const deterministicRoute = directNavigation ? "navigate_url" : directSearch ? "search_web" : directBrowserAction ? (directBrowserAction.startsWith("switch_tab_") ? "switch_tab" : directBrowserAction) : null;
  const effectiveIntentName = deterministicRoute || intentName;
  const routeFallback = directCommand;
  if (directSearch) {
    check(reasons, "search_fallback", directSearch.query, "explicit search phrase", true, `query extracted; site=${directSearch.site}`);
  }
  if (directNavigation) {
    check(reasons, "navigation_fallback", directNavigation.site || directNavigation.url, "explicit navigation phrase", true, "destination extracted from spoken site/domain");
  }
  if (taskContinuation) {
    const words = normalizedTranscript.toLowerCase();
    const expected = {
      go_back: /\b(?:back|previous page|undo)\b/.test(words),
      go_forward: /\b(?:forward|next page)\b/.test(words),
      open_new_tab: /\bnew tab\b/.test(words),
      close_tab: /\bclose\s+(?:this\s+)?tab\b/.test(words),
      switch_tab: /\btab\b/.test(words),
      scroll_up: /\b(?:scroll|page|top)\b/.test(words),
      scroll_down: /\b(?:scroll|page|bottom|end)\b/.test(words),
      navigate_url: Boolean(parseDirectNavigation(transcript, candidates)),
    };
    if (Object.hasOwn(expected, effectiveIntentName) && !expected[effectiveIntentName]) {
      check(reasons, "task_action_match", effectiveIntentName, "supported by the stated goal", false, "the selected action does not match the user's task");
      return { decision: "clarify", reasons, summary: "the selected browser action does not match the requested goal" };
    }
  }
  const intentOk = effectiveIntentName !== "none" && (conf >= T.intentConfidence || routeFallback);
  check(reasons, "intent", `${intentName} (${r2(conf)})`, T.intentConfidence, intentOk, routeFallback ? `explicit phrase routed as ${effectiveIntentName}` : "confident, non-none intent");
  if (!intentOk) return { decision: "wait", reasons, summary: intentName === "none" ? "no recognizable command yet" : "intent not confident yet" };

  // 3. Has the user finished the command? (silence or a final result also counts)
  const complete = answers.complete?.noul ?? 0;
  const silent = silentMs >= SILENCE_COMPLETE_MS || isFinal;
  const completeOk = complete >= T.complete || silent || directCommand || taskContinuation;
  check(
    reasons,
    "complete",
    complete,
    T.complete,
    completeOk,
    silent ? (isFinal ? "recognizer marked utterance final" : `silent for ${silentMs}ms`) : "command has verb + object",
  );
  if (!completeOk) return { decision: "wait", reasons, summary: "waiting for the rest of the command" };

  // 3b. Free-text payloads must be finished before they are copied verbatim.
  if (PAYLOAD_INTENTS.has(effectiveIntentName)) {
    const payloadOk = isFinal || silentMs >= PAYLOAD_SILENCE_MS;
    check(
      reasons,
      "payload_final",
      isFinal ? "final" : `${silentMs}ms silence`,
      `final or ${PAYLOAD_SILENCE_MS}ms`,
      payloadOk,
      "free text (query / typed text) must be finished before it is copied",
    );
    if (!payloadOk) {
      return { decision: "wait", reasons, summary: "waiting for the end of the phrase (free text)", retryInMs: Math.max(50, PAYLOAD_SILENCE_MS - silentMs) };
    }
  }

  // 4. Build the concrete action (code owns URLs, templates and text; Laya only picked options).
  // On a correction that names a new target, the previous target is not an option ("the other one").
  const excludeTargetId = isCorrection && TARGET_INTENTS.has(effectiveIntentName) ? lastAction.targetId ?? null : null;
  let actionAnswers = answers;
  let actionCandidates = candidates;
  if (directNavigation) {
    actionAnswers = { ...answers };
    actionCandidates = { ...candidates, url: directNavigation.url ? [directNavigation.url] : [] };
    if (directNavigation.site) actionAnswers.site = { type: "choice", choice: directNavigation.site, confidence: 1 };
    if (directNavigation.url) actionAnswers.url_span = { type: "choice", choice: directNavigation.url, confidence: 1 };
  } else if (directSearch) {
    actionAnswers = {
      ...answers,
      site: { type: "choice", choice: directSearch.site, confidence: 1 },
      text_span: { type: "choice", choice: directSearch.query, confidence: 1 },
    };
    actionCandidates = { ...candidates, text: [directSearch.query] };
  } else if (directBrowserAction?.startsWith("switch_tab_")) {
    actionAnswers = { ...answers, tab_direction: { type: "choice", choice: directBrowserAction.endsWith("previous") ? "previous" : "next", confidence: 1 } };
  }

  // The model may choose among plausible actions, but a contradictory closed-set action must
  // never execute (for example, mapping "ask AI" to go_back or "open new tab" to search).
  if (directBrowserAction && deterministicRoute) {
    actionAnswers = { ...actionAnswers, intent: { type: "choice", choice: effectiveIntentName, confidence: 1 } };
  } else if (!taskContinuation && transcript && explicitNavigation && !directNavigation && effectiveIntentName !== "click_element") {
    check(reasons, "command_match", effectiveIntentName, "spoken destination or page target", false, "navigation phrase has no recognized destination; refusing an unrelated model action");
    return { decision: "wait", reasons, summary: "which site or page item do you mean?" };
  } else if (!taskContinuation && transcript && ["go_back", "go_forward", "switch_tab", "open_new_tab", "close_tab"].includes(effectiveIntentName)) {
    check(reasons, "command_match", effectiveIntentName, "matching spoken browser command", false, "no matching back/forward, tab, or scroll phrase");
    return { decision: "wait", reasons, summary: "command did not match the selected browser action" };
  } else if (transcript && ["scroll_up", "scroll_down"].includes(effectiveIntentName) && /\bscroll\b/i.test(transcript) && !/\b(?:up|down|top|bottom|end)\b/i.test(transcript)) {
    check(reasons, "command_match", effectiveIntentName, "scroll direction", true, "generic scroll request uses model's direction selection");
  }
  const built = buildAction({ intentName: effectiveIntentName, answers: actionAnswers, candidates: actionCandidates, snapshot, reasons, excludeTargetId });
  if (built.decision !== "act") return { ...built, reasons };
  const action = built.action;

  // 5. Destructive? Only side-effecting element actions can be.
  const destructive = answers.destructive?.noul ?? 0;
  const canBeDestructive = ["click_element", "press_enter", "select_option"].includes(action.type);
  if (canBeDestructive) {
    const safe = destructive < T.destructive;
    check(reasons, "destructive", destructive, T.destructive, safe, safe ? "reversible action" : "needs spoken confirmation");
    if (!safe) {
      return { decision: "confirm", action, reasons, summary: `say "confirm" to ${describe(action)}` };
    }
  }

  return { decision: "act", action, reasons, summary: describe(action) };
}

/** The action that undoes `action` as far as a browser can: navigations/clicks → back; typing → clear; tabs → close/switch. */
export function reverseAction(action) {
  switch (action?.type) {
    case "type_into_field":
      return { type: "type_into_field", targetId: action.targetId, text: "", submit: false, label: `clear ${action.label || action.targetId}` };
    case "open_new_tab":
      return { type: "close_tab", label: "close the new tab" };
    case "close_tab":
      return { type: "go_back", label: "back (tab already closed)" };
    case "switch_tab":
      return { type: "switch_tab", direction: action.direction === "previous" ? "next" : "previous", label: "switch back" };
    case "scroll_down":
      return { type: "scroll_up", amount: action.amount || "page", label: "scroll back up" };
    case "scroll_up":
      return { type: "scroll_down", amount: action.amount || "page", label: "scroll back down" };
    default:
      return { type: "go_back", label: `undo ${describe(action)}` };
  }
}

function buildAction({ intentName, answers, candidates, snapshot, reasons, excludeTargetId = null }) {
  const site = answers.site?.choice ?? "none";
  const elements = snapshot?.elements ?? [];

  switch (intentName) {
    case "navigate_url": {
      const urlPick = pickSpan(answers.url_span, T.spanConfidence, candidates.url?.[0]);
      if (urlPick) {
        check(reasons, "url_span", urlPick, T.spanConfidence, true, "domain spoken verbatim");
        return { decision: "act", action: { type: "navigate_url", url: toHttpUrl(urlPick), label: urlPick } };
      }
      if (SITE_HOME[site]) {
        check(reasons, "site", `${site} (${r2(answers.site.confidence)})`, "-", true, "known site");
        return { decision: "act", action: { type: "navigate_url", url: SITE_HOME[site], label: site } };
      }
      check(reasons, "site", site, "known site or spoken domain", false, "no destination yet");
      return { decision: "wait", summary: "where to? (no site or domain recognised)" };
    }

    case "search_web": {
      const query = pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);
      if (!query) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "no query text yet");
        return { decision: "wait", summary: "search for what?" };
      }
      check(reasons, "text_span", query, T.spanConfidence, true, "query copied verbatim");
      if (SITE_SEARCH[site]) {
        return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[site], query), label: `search ${site}: ${query}`, query } };
      }
      if (snapshot?.searchBoxId && snapshot.site !== "blank") {
        return { decision: "act", action: { type: "type_into_field", targetId: snapshot.searchBoxId, text: query, submit: true, label: `search this site: ${query}` } };
      }
      return { decision: "act", action: { type: "navigate_url", url: fillTemplate(SITE_SEARCH[DEFAULT_SEARCH_ENGINE], query), label: `search: ${query}`, query } };
    }

    case "click_element":
    case "select_option":
    case "type_into_field": {
      const target = answers.target;
      let top = topChoices(target, T.candidateCount + 1);
      let chosen = target?.choice;
      let chosenP = target?.probabilities?.[chosen] ?? 0;
      if (excludeTargetId && chosen === excludeTargetId) {
        // "no, the other one": the element just acted on is ruled out; take the runner-up.
        top = top.filter((c) => c.id !== excludeTargetId);
        chosen = top[0]?.id ?? "none";
        chosenP = top[0]?.p ?? 0;
        check(reasons, "exclude_target", excludeTargetId, "-", true, `previous target excluded → ${chosen}`);
      }
      top = top.slice(0, T.candidateCount);
      const targetOk =
        chosen && chosen !== "none" && target.confidence >= T.targetConfidence && chosenP >= T.targetTopProb;
      const text = intentName === "click_element" ? null : pickSpan(answers.text_span, T.spanConfidence, candidates.text?.[0]);

      if (intentName !== "click_element" && !text) {
        check(reasons, "text_span", "none", T.spanConfidence, false, "no text to type yet");
        return { decision: "wait", summary: "type what?" };
      }

      if (targetOk) {
        check(reasons, "target", `${chosen} (${r2(target.confidence)})`, T.targetConfidence, true, elementLabel(elements, chosen));
        return { decision: "act", action: { type: intentName, targetId: chosen, text, label: elementLabel(elements, chosen) } };
      }

      // Typing with no confident target: fall back to the page's search box.
      if (intentName === "type_into_field" && snapshot?.searchBoxId) {
        check(reasons, "target", `${chosen} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "falling back to search box");
        return { decision: "act", action: { type: intentName, targetId: snapshot.searchBoxId, text, label: "search box" } };
      }

      check(reasons, "target", `${chosen ?? "none"} (${r2(target?.confidence ?? 0)})`, T.targetConfidence, false, "ambiguous target");
      // Show the plausible candidates (at least two when anything is plausible at all).
      let viable = top.filter((c) => c.p >= 0.08);
      if (viable.length === 1) viable = top.filter((c) => c.p >= 0.02).slice(0, 2);
      if (viable.length === 0) return { decision: "wait", summary: "no matching element on this page" };
      return {
        decision: "disambiguate",
        candidates: viable.map((c) => ({ ...c, label: elementLabel(elements, c.id) })),
        pendingIntent: { type: intentName, text },
        summary: `which one? ${viable.map((c, i) => `${i + 1}: ${elementLabel(elements, c.id)}`).join(" | ")}`,
      };
    }

    case "scroll_down":
    case "scroll_up": {
      const lvl = Math.round(answers.scroll_amount?.score ?? 1);
      const amount = ["little", "page", "end"][Math.min(2, Math.max(0, lvl))];
      check(reasons, "scroll_amount", answers.scroll_amount?.score ?? 1, "round", true, amount);
      return { decision: "act", action: { type: intentName, amount, label: `${intentName.replace("_", " ")} (${amount})` } };
    }

    case "switch_tab": {
      const dir = answers.tab_direction?.choice && answers.tab_direction.choice !== "none" ? answers.tab_direction.choice : "next";
      return { decision: "act", action: { type: "switch_tab", direction: dir, label: `switch tab (${dir})` } };
    }

    case "confirm":
    case "cancel":
      return { decision: "wait", summary: `nothing pending to ${intentName}` };

    default:
      return { decision: "act", action: { type: intentName, label: intentName.replace(/_/g, " ") } };
  }
}

export function elementLabel(elements, id) {
  const el = elements.find((e) => e.id === id);
  return el ? `${el.role} "${el.text || el.placeholder || ""}"` : id;
}

export function describe(action) {
  if (!action) return "";
  switch (action.type) {
    case "navigate_url":
      return `open ${action.label || action.url}`;
    case "type_into_field":
      return `type "${action.text}" into ${action.label || action.targetId}${action.submit ? " + enter" : ""}`;
    case "click_element":
      return `click ${action.label || action.targetId}`;
    case "select_option":
      return `select "${action.text}" in ${action.label || action.targetId}`;
    default:
      return action.label || action.type.replace(/_/g, " ");
  }
}

export { TARGET_INTENTS };
