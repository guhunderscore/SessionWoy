import type { RuleSpec } from '../shared/rules.js';

type Rule = chrome.declarativeNetRequest.Rule;

/** sessionId -> currently installed DNR session-rule ids. */
const installed = new Map<string, number[]>();
let nextId = 1;

export const ruleStats = { updates: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastCount: 0 };

function record(ms: number, count: number): void {
  ruleStats.updates++;
  ruleStats.totalMs += ms;
  ruleStats.maxMs = Math.max(ruleStats.maxMs, ms);
  ruleStats.lastMs = ms;
  ruleStats.lastCount = count;
}

/**
 * Service-worker start: replaces whatever session rules survived the previous
 * worker with a fresh set in ONE atomic call, so there is never a moment where
 * managed tabs are without their cookie-stripping rules.
 */
export async function replaceAllRules(specsBySession: Map<string, RuleSpec[]>): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  installed.clear();
  nextId = Math.max(0, ...existing.map((r) => r.id)) + 1;
  const addRules: Rule[] = [];
  for (const [sid, specs] of specsBySession) {
    const rules = specs.map((s) => ({ id: nextId++, ...s })) as unknown as Rule[];
    if (rules.length) installed.set(sid, rules.map((r) => r.id));
    addRules.push(...rules);
  }
  const t0 = performance.now();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: existing.map((r) => r.id), addRules });
  record(performance.now() - t0, addRules.length);
}

/** Atomically replaces one session's rules (single updateSessionRules call). */
export async function applySessionRules(sessionId: string, specs: RuleSpec[]): Promise<void> {
  const removeRuleIds = installed.get(sessionId) ?? [];
  const addRules = specs.map((s) => ({ id: nextId++, ...s })) as unknown as Rule[];
  const t0 = performance.now();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  record(performance.now() - t0, addRules.length);
  if (addRules.length) installed.set(sessionId, addRules.map((r) => r.id));
  else installed.delete(sessionId);
}
