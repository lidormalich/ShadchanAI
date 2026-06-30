// ═══════════════════════════════════════════════════════════
// ShadchanAI — AI Prompt Builders
//
// Pure functions that take typed inputs and return ChatMessage[]
// arrays. No side effects, no DB calls, no randomness.
//
// Every prompt follows the same shape:
//   1. System message: role, constraints, JSON-only output rules
//   2. User message: structured context as compact JSON
//
// Hard rules encoded in every system message:
//   - Do NOT invent candidates or facts
//   - Do NOT execute actions (no "I'll send", "I'll update", etc.)
//   - Output must be valid JSON matching the given schema
//   - Use only the information provided in the user message
// ═══════════════════════════════════════════════════════════

import type {
  ChatMessage,
  ExplainMatchInput,
  GenerateMessageInput,
  SummarizeCandidateInput,
  ClassifyMessageInput,
  SuggestNextStepInput,
} from './ai.types.js';

// ── Shared system-prompt prefix ──────────────────────────

const CORE_CONSTRAINTS = `
You are an advisory assistant for a religious matchmaking platform (ShadchanAI).

HARD RULES (never violate):
- NEVER invent candidates, facts, or details not present in the input.
- NEVER state or imply that you will perform an action (sending messages,
  updating records, contacting anyone). You only produce structured advice.
- NEVER produce content outside the requested JSON schema.
- NEVER include markdown, prose, or explanations outside the JSON.
- If you lack information, say so inside the JSON (e.g. warnings array)
  rather than fabricating.

OUTPUT FORMAT:
- Return a single JSON object matching the schema described below.
- Do not wrap the JSON in code fences, commentary, or headers.
- Do not include trailing text.
`.trim();

// ── explainMatch ─────────────────────────────────────────

export function buildExplainMatchPrompt(input: ExplainMatchInput, strictRetry = false): ChatMessage[] {
  const schema = `
{
  "summary": string (1-3 sentences describing the match overall),
  "strengths": string[] (key compatibility points, 2-6 items),
  "concerns": string[] (potential issues worth noting, 0-6 items),
  "nuance": string (optional deeper insight, may be empty string),
  "recommendedApproach": string (how the Shadchan should approach this match, 1-2 sentences),
  "notMatchReasons": string[] (concrete, specific reasons this pair is NOT a good match — 0-8 items)
}`.trim();

  const eligible = input.eligible !== false;

  const system = `${CORE_CONSTRAINTS}

TASK: Explain a deterministic engine-generated match for the Shadchan.

Context: The engine already scored this pair using 8 dimensions
(age, sector, lifestyle, study-work, location, mutual expectations,
life-stage, flexibility) and classified it as ${input.matchType}.
Your job is to translate the structured signals into a short,
respectful narrative — NOT to re-score or override the engine.

LANGUAGE: Write ALL natural-language fields in Hebrew.

notMatchReasons RULES (this is the "למה לא מתאים" array):
- This pair is ${eligible ? 'ELIGIBLE but may still be weak' : 'INELIGIBLE (hard-blocked)'}.
- If the pair is ineligible OR the match score is low (< 55), populate
  notMatchReasons with the concrete reasons it is not a good match.
- Ground EVERY reason in the provided data: the engine "blockers"
  (deterministic — these are the real, primary reasons) and the
  lowest-scoring dimensions in scoreBreakdown. Do NOT invent reasons.
- Each item: one short, specific Hebrew sentence (e.g. a real gap in
  age / sector / lifestyle / status). Order most-decisive first.
- If the match is strong (eligible and score >= 55 with no notable
  gaps), return an EMPTY notMatchReasons array.

Respect religious community sensibilities. Use neutral, professional
language suitable for a Shadchan reviewing the match.

OUTPUT JSON SCHEMA:
${schema}${strictRetry ? '\n\nSTRICT MODE: Previous response was invalid. Return ONLY the JSON object.' : ''}`;

  const user = JSON.stringify({
    internal: input.internal,
    external: input.external,
    engineScoring: {
      eligible,
      matchScore: input.matchScore,
      confidenceScore: input.confidenceScore,
      matchType: input.matchType,
      riskLevel: input.riskLevel,
      strengths: input.strengths,
      attentionPoints: input.attentionPoints,
      scoreBreakdown: input.scoreBreakdown,
      blockers: input.blockers ?? [],
    },
  }, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── generateMessage ──────────────────────────────────────

export function buildGenerateMessagePrompt(input: GenerateMessageInput, strictRetry = false): ChatMessage[] {
  const schema = `
{
  "message": string (the drafted message text — Hebrew if language='he'),
  "tone": string (echo the requested tone),
  "language": string (echo the requested language code),
  "reviewFlags": string[] (things the Shadchan should review before sending, 0-5 items)
}`.trim();

  const system = `${CORE_CONSTRAINTS}

TASK: Draft a message that a Shadchan will review before sending.
The draft is ADVISORY — the Shadchan will edit and approve before any
send happens. You never send anything.

Tone: ${input.tone}
Language: ${input.language} (${input.language === 'he' ? 'Hebrew' : 'English'})
Purpose: ${input.purpose}

Respect religious community conventions:
- Use appropriate greetings/blessings where culturally expected
- Do not use overly casual language for religious audiences
- Do not include personal opinions or speculation
- Do not promise outcomes

If the purpose is 'decline', be gentle and respectful — do not specify
reasons beyond what is explicitly stated in the input.

OUTPUT JSON SCHEMA:
${schema}${strictRetry ? '\n\nSTRICT MODE: Previous response was invalid. Return ONLY the JSON object.' : ''}`;

  const user = JSON.stringify({
    purpose: input.purpose,
    recipient: input.recipient,
    aboutCandidate: input.aboutCandidate,
    tone: input.tone,
    language: input.language,
    additionalContext: input.additionalContext,
    constraints: input.constraints ?? [],
  }, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── summarizeCandidate ───────────────────────────────────

export function buildSummarizeCandidatePrompt(input: SummarizeCandidateInput, strictRetry = false): ChatMessage[] {
  const schema = `
{
  "summary": string (2-4 sentence neutral profile summary),
  "personalityTraits": string[] (traits inferred ONLY from explicit input, 0-8 items),
  "values": string[] (values inferred ONLY from explicit input, 0-8 items),
  "communicationStyle": string (may be empty if no signal),
  "warnings": string[] (missing data, unclear signals, or profile gaps, 0-6 items)
}`.trim();

  const system = `${CORE_CONSTRAINTS}

TASK: Produce a neutral, factual summary of a candidate based ONLY on
the provided profile data. Do not infer beyond explicit statements.

Critical: If the profile has missing fields or unclear signals, surface
those in the 'warnings' array rather than inventing answers.

OUTPUT JSON SCHEMA:
${schema}${strictRetry ? '\n\nSTRICT MODE: Previous response was invalid. Return ONLY the JSON object.' : ''}`;

  const user = JSON.stringify({ candidate: input.candidate }, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── classifyMessage ──────────────────────────────────────

export function buildClassifyMessagePrompt(input: ClassifyMessageInput, strictRetry = false): ChatMessage[] {
  const schema = `
{
  "intent": string (concise intent label, e.g. 'introduction', 'decline', 'scheduling', 'question', 'update', 'greeting', 'unclear'),
  "sentiment": 'positive' | 'neutral' | 'negative' | 'mixed' | 'unknown',
  "language": string (ISO 639-1 code, e.g. 'he', 'en'),
  "urgency": 'low' | 'normal' | 'high',
  "actionNeeded": boolean (true if the Shadchan should respond or act),
  "confidence": number (0-1, how certain the classification is)
}`.trim();

  const system = `${CORE_CONSTRAINTS}

TASK: Classify an inbound message from a candidate or family.

Use only the text content. Do not invent intent beyond the evidence.
If the message is ambiguous, use 'unclear' intent and lower confidence.

OUTPUT JSON SCHEMA:
${schema}${strictRetry ? '\n\nSTRICT MODE: Previous response was invalid. Return ONLY the JSON object.' : ''}`;

  const user = JSON.stringify({
    text: input.text,
    context: input.context ?? null,
  }, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── suggestNextStep ──────────────────────────────────────

export function buildSuggestNextStepPrompt(input: SuggestNextStepInput, strictRetry = false): ChatMessage[] {
  const schema = `
{
  "action": string (recommended next operational action, e.g. 'wait for response', 'follow up with side A', 'prepare decline draft'),
  "reason": string (why this action makes sense given the state),
  "urgency": 'low' | 'normal' | 'high',
  "alternatives": string[] (0-3 alternative actions worth considering)
}`.trim();

  const system = `${CORE_CONSTRAINTS}

TASK: Given the current state of a match suggestion, recommend the
next operational step for the Shadchan to consider.

CRITICAL: You are advisory. You do NOT send messages, change statuses,
or take actions. Your output is a recommendation the Shadchan decides on.

The engine has already produced its own recommendedAction ('${input.recommendedAction}').
Your job is to translate the state into a human-friendly next-step
suggestion that fits typical matchmaking operations.

OUTPUT JSON SCHEMA:
${schema}${strictRetry ? '\n\nSTRICT MODE: Previous response was invalid. Return ONLY the JSON object.' : ''}`;

  const user = JSON.stringify(input, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── Ask AI: Intent detection ─────────────────────────────

export function buildAskAIIntentPrompt(query: string, strictRetry = false): ChatMessage[] {
  const schema = `
{
  "intent": 'find_matching_candidates' | 'find_unhandled_candidates' | 'find_high_potential_matches' | 'find_stale_candidates' | 'find_similar_candidates' | 'find_active_issues' | 'summarize_candidate' | 'unknown',
  "filters": {
    "candidateId": string (optional),
    "sectorGroup": string (optional),
    "subSector": string (optional),
    "city": string (optional),
    "ageMin": number (optional),
    "ageMax": number (optional),
    "mode": 'strict' | 'discovery' (optional),
    "matchType": string (optional),
    "limit": number (optional, 1-100),
    "daysSinceAction": number (optional)
  },
  "reasoning": string (brief explanation of why you chose this intent)
}`.trim();

  const system = `${CORE_CONSTRAINTS}

TASK: Classify a Shadchan's natural-language question into one of the
supported intents and extract structured filters.

SUPPORTED INTENTS:
- find_matching_candidates: "find matches for candidate X", "who could David go with?"
- find_unhandled_candidates: "show me candidates nothing has happened with", "who hasn't been contacted"
- find_high_potential_matches: "best matches this week", "top scoring pairs"
- find_stale_candidates: "external profiles that are getting old", "stale records"
- find_similar_candidates: "candidates similar to X" (requires a candidate id)
- find_active_issues: "what needs my attention", "problems requiring review"
- summarize_candidate: "tell me about X" (requires a candidate id)
- unknown: query is ambiguous or unsupported

Extract only filters you can clearly infer from the query. Do NOT
guess candidate IDs. If the query mentions a name but no id, leave
candidateId empty and include a warning in your reasoning.

OUTPUT JSON SCHEMA:
${schema}${strictRetry ? '\n\nSTRICT MODE: Previous response was invalid. Return ONLY the JSON object.' : ''}`;

  const user = JSON.stringify({ query }, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ── Ask AI: Result summarization ─────────────────────────

export function buildAskAISummaryPrompt(
  intent: string,
  query: string,
  results: unknown[],
  appliedFilters: Record<string, unknown>,
  strictRetry = false,
): ChatMessage[] {
  const schema = `
{
  "reasoningSummary": string (2-5 sentences explaining what was searched and found),
  "recommendedActions": string[] (0-6 actionable next steps for the Shadchan),
  "warnings": string[] (0-6 caveats, e.g. 'ambiguous name in query', 'results may be stale')
}`.trim();

  const system = `${CORE_CONSTRAINTS}

TASK: Summarize internal tool-fetched results for the Shadchan.

IMPORTANT:
- The 'results' array was produced by the deterministic engine and
  internal tools. You do NOT re-score, re-rank, or re-filter them.
- You only explain what was found and suggest what the Shadchan might
  consider doing next (reviewing, calling, etc.) — no actions taken.
- Do not repeat the raw results — summarize them.
- If results are empty, say so clearly and suggest how to broaden.

OUTPUT JSON SCHEMA:
${schema}${strictRetry ? '\n\nSTRICT MODE: Previous response was invalid. Return ONLY the JSON object.' : ''}`;

  const user = JSON.stringify({
    intent,
    originalQuery: query,
    appliedFilters,
    resultCount: results.length,
    resultsPreview: results.slice(0, 10),
  }, null, 2);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
