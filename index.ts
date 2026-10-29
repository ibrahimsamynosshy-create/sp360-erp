// =====================================================================
// SP360 — AI Project Health Analyst
// Supabase Edge Function: ai-health-analyst  (v0.4.7)
// v0.4.1: RAG and confidence come from company policy (fn_ai_build_payload v2.2);
//         the AI explains them and cannot override them.
// v0.4.4: Portfolio top_risks are structured {project_no, risk, impact} and
//         normalized to "PROJECT — Risk — Impact" (UI/PDF unchanged: strings).
// v0.4.7: Validator also checks "-103,560 KWD" (amount before currency).
// v0.4.6: Language lock (reminder in every call + AI_WRONG_LANGUAGE flag); Arabic units
//         (يوم/أيام, %N, د.ك/دينار) in the quantity validator.
// v0.4.5: Validator also checks whole-number quantities (days, %, KWD amounts),
//         e.g. "150 days overdue" when the data says 120 → AI_UNVERIFIED_QUANTITIES.
//         Prompt asks for half-up rounding and exact day counts.
//
// Provider-agnostic, resumable analysis:
//   • AI_PROVIDER = groq (default, free tier) | anthropic
//   • One LLM call per project + one portfolio call
//   • Rate-limit aware (reads provider headers, retries on 429)
//   • Time-boxed per invocation; "continue" resumes the same run
//
// Modes (POST body):
//   { "mode": "dry_run" }                              → payload preview, no AI
//   { "mode": "analyze", "language": "en"|"ar", "as_of": "YYYY-MM-DD" }
//                                                      → opens a run + processes a batch
//   { "mode": "continue", "run_id": "<uuid>" }         → processes the next batch
//   Response "status": "running" → call continue again; "success"/"partial" → done
//
// Secrets:
//   auto:      SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   groq:      GROQ_API_KEY            (required when AI_PROVIDER=groq)
//   anthropic: ANTHROPIC_API_KEY       (required when AI_PROVIDER=anthropic)
//   optional:  AI_PROVIDER, AI_MODEL, AI_OUTPUT_LANGUAGE,
//              AI_PRICE_IN_PER_MTOK, AI_PRICE_OUT_PER_MTOK,
//              AI_TIME_BUDGET_MS (default 110000), AI_CRON_SECRET (pg_cron)
// =====================================================================

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const FUNCTION_VERSION = "ai-health-analyst@0.4.7";   // 0.4.7: amount-before-currency check
const PROMPT_VERSION = "phs-v1.6";   // v1.3 CPI wording; v1.4 top_risks format; v1.5 exact counts + half-up rounding; v1.6 language lock + Arabic units

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODELS = { groq: "openai/gpt-oss-120b", anthropic: "claude-sonnet-5-5" } as const;

const CALL_TIMEOUT_MS = 60_000;
const EST_CALL_MS = 20_000;          // reserve per call when checking the time budget
const STALE_RUN_MINUTES = 10;
const MAX_RETRIES = 3;
const PORTFOLIO_KEY = "PORTFOLIO";   // allowed project_no for portfolio-wide risks

const RAG = ["green", "amber", "red"] as const;
const TREND = ["improving", "stable", "deteriorating", "unknown"] as const;
const CONFIDENCE = ["high", "medium", "low"] as const;
const PRIORITY = ["high", "medium", "low"] as const;
const OWNER_ROLES = [
  "Project Manager", "PMO", "Planning", "Procurement", "Finance",
  "Commercial", "QHSE", "Management",
] as const;
const SCHEDULE_BASIS = ["spi_calc", "spi_time_proxy", "both_unreliable", "not_applicable"] as const;
const FINISH_RISK = ["on_time", "at_risk", "late", "not_applicable"] as const;

type Provider = "groq" | "anthropic";
type Lang = "en" | "ar";
type Usage = { input: number; output: number };
type LlmConfig = {
  provider: Provider; model: string; apiKey: string;
  priceIn: number; priceOut: number;
};

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------
function loadLlmConfig(): LlmConfig | string {
  const provider = (Deno.env.get("AI_PROVIDER") ?? "groq").toLowerCase() as Provider;
  if (provider !== "groq" && provider !== "anthropic") {
    return `AI_PROVIDER must be "groq" or "anthropic" (got "${provider}")`;
  }
  const keyName = provider === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = Deno.env.get(keyName);
  if (!apiKey) return `${keyName} secret is not set in Supabase`;
  return {
    provider,
    model: Deno.env.get("AI_MODEL") || DEFAULT_MODELS[provider],
    apiKey,
    priceIn: Number(Deno.env.get("AI_PRICE_IN_PER_MTOK") ?? "0"),
    priceOut: Number(Deno.env.get("AI_PRICE_OUT_PER_MTOK") ?? "0"),
  };
}

// ---------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------
/** Repeated in every user message — the system prompt alone is not enough to stop language drift. */
function langReminder(language: Lang): string {
  return language === "ar"
    ? "OUTPUT LANGUAGE: Arabic (Modern Standard). All narrative fields in Arabic; numbers and metric names in Latin characters."
    : "OUTPUT LANGUAGE: English ONLY. Every narrative field (headline, summary, causes, actions, comments, risks) must be in English, even if some input fields are in Arabic.";
}

/** Share of letters that are Arabic, 0..1. */
function arabicRatio(text: string): number {
  const ar = (text.match(/[\u0600-\u06FF]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  return ar + lat === 0 ? 0 : ar / (ar + lat);
}

function baseRules(language: Lang): string {
  const lang = language === "ar"
    ? "Write all narrative fields in professional Modern Standard Arabic. Keep project numbers, metric names (CPI, SPI, EAC, PV, EV, BAC) and all numbers in Latin characters."
    : "Write all narrative fields in concise professional business English.";
  return `You are a Senior Project Controls Engineer preparing the weekly health review for the CEO and Board of SP360, a Kuwait-based systems-integration contractor. Currency: KWD.

RULES
1. Use ONLY facts and numbers present in the data. Never invent suppliers, events, dates, causes or figures. Never recompute EVM metrics: the "computed" block is authoritative. Round to 2 decimals at most, half-up (0.235 → 0.24).
   Day counts, percentages and KWD amounts must be copied exactly from the data (e.g. "overdue 120 days" only if the data says 120) — never estimate or round them up.
2. Read data_quality_flags FIRST.
   - PV_STALE or PV_SUSPECT: spi_calc is unreliable. Use computed.spi_time_proxy as the cross-check and say so. The proxy assumes linear progress, so it OVERSTATES delay for back-loaded / S-curve plans (civil works, early phases): an indicator, not a fact.
   - If both schedule indices are doubtful: schedule_basis = "both_unreliable", confidence = "low".
   - NOT_STARTED: schedule_basis = "not_applicable", trend = "unknown"; assess data readiness only (e.g. PV already equal to BAC before start is a data error).
3. Root causes are evidence-based hypotheses; each cites its evidence from the data.
4. Actions are specific and executable within 30 days. When data is the problem, fix data first.
5. headline <= 120 characters. summary <= 3 sentences.
6. EVM wording: CPI = 1.00 is exactly on budget; CPI > 1 is UNDER budget (favourable); CPI < 1 is OVER budget. Same logic for SPI (ahead / on / behind schedule). Never describe CPI >= 1 as "above budget" or "over budget".

${lang}`;
}

const PROJECT_TASK = `TASK: assess ONE project.
RAG and confidence are COMPANY POLICY, already computed:
- Set "rag" exactly to computed.rag_rule and "confidence" exactly to computed.data_confidence. Do not change them.
- Your job is to EXPLAIN: the headline and summary must state the assigned RAG and why, using computed.rag_reasons as the basis.
- If computed.schedule_reliable is false, say clearly that the official SPI is misleading and that spi_time_proxy is indicative only.
- If a reason or flag says UNCONFIRMED / MILESTONE_UNCONFIRMED, present it as a data-verification issue ("milestone shows as overdue but progress suggests it is complete — PM to confirm the actual date"), NEVER as a confirmed delay. The first action must be for the Project Manager to confirm or record the actual date.
Trend: compare the last 3 snapshots; fewer than 2 snapshots = "unknown". Trend is independent of RAG (a red project can be improving).
Forecast EAC: use computed.eac_cpi unless CPI data is unreliable (then omit).`;

const PORTFOLIO_TASK = `TASK: portfolio insight for the CEO.
You receive portfolio totals and the already-completed project assessments. Do NOT re-rate projects.
- rag: set exactly to "portfolio_rag" (policy). Explain it.
- summary: weighted CPI/SPI from "portfolio" (state if SPI is unreliable because of PV flags), RAG counts.
- systemic_issues: problems spanning several projects (e.g. stale PV, missing snapshots).
- top_risks: EXACTLY 3 items, most material first. Each item is an object:
    project_no — copied exactly from assessments[].project_no ("${PORTFOLIO_KEY}" only for a portfolio-wide risk);
    risk       — what may go wrong and why, in one short clause (the cause, not the metric);
    impact     — the consequence for the company, quantified with a number taken from the data
                 (KWD overrun / EAC vs BAC, CPI, SPI, days, % complete). No impact without a number.
  Prefer red projects first, then amber. Do not list the same project twice unless fewer than 3 projects are at risk.
- root_causes and recommended_actions at portfolio / process level.`;

// ---------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------
const insightProperties: Record<string, unknown> = {
  rag: { type: "string", enum: RAG },
  trend: { type: "string", enum: TREND },
  confidence: { type: "string", enum: CONFIDENCE },
  schedule_basis: { type: "string", enum: SCHEDULE_BASIS },
  headline: { type: "string" },
  summary: { type: "string" },
  root_causes: {
    type: "array",
    items: {
      type: "object",
      properties: { cause: { type: "string" }, evidence: { type: "string" } },
      required: ["cause", "evidence"],
    },
  },
  forecast: {
    type: "object",
    properties: {
      eac: { type: "number" },
      finish_risk: { type: "string", enum: FINISH_RISK },
      comment: { type: "string" },
    },
    required: ["finish_risk", "comment"],
  },
  recommended_actions: {
    type: "array",
    items: {
      type: "object",
      properties: {
        action: { type: "string" },
        owner_role: { type: "string", enum: OWNER_ROLES },
        priority: { type: "string", enum: PRIORITY },
        due_in_days: { type: "integer" },
      },
      required: ["action", "owner_role", "priority", "due_in_days"],
    },
  },
  data_quality_flags: { type: "array", items: { type: "string" } },
};
const insightRequired = [
  "rag", "trend", "confidence", "schedule_basis", "headline", "summary",
  "root_causes", "forecast", "recommended_actions", "data_quality_flags",
];

type ToolDef = { name: string; description: string; schema: Record<string, unknown> };

const PROJECT_TOOL: ToolDef = {
  name: "submit_project_assessment",
  description: "Submit the health assessment of one project.",
  schema: { type: "object", properties: insightProperties, required: insightRequired },
};

/** Portfolio tool is built per run so top_risks.project_no is constrained to real projects. */
function portfolioTool(knownNos: string[]): ToolDef {
  const projectNo: Record<string, unknown> = knownNos.length
    ? { type: "string", enum: [...knownNos, PORTFOLIO_KEY] }
    : { type: "string" };
  return {
    name: "submit_portfolio_assessment",
    description: "Submit the portfolio-level health assessment.",
    schema: {
      type: "object",
      properties: {
        ...insightProperties,
        systemic_issues: { type: "array", items: { type: "string" } },
        top_risks: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            properties: {
              project_no: projectNo,
              risk: { type: "string" },
              impact: { type: "string" },
            },
            required: ["project_no", "risk", "impact"],
          },
        },
      },
      required: [...insightRequired, "systemic_issues", "top_risks"],
    },
  };
}

// ---------------------------------------------------------------------
// Rate-limit gate (provider headers → wait before next call)
// ---------------------------------------------------------------------
function parseDurationMs(v: string | null): number | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) * 1000;            // plain seconds
  let total = 0, matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return matched ? total : null;
}

class RateGate {
  private readyAt = 0;
  msUntilReady(): number { return Math.max(0, this.readyAt - Date.now()); }
  async wait(): Promise<void> { await sleep(this.msUntilReady()); }
  pushBack(ms: number) { this.readyAt = Math.max(this.readyAt, Date.now() + ms); }

  /** Groq: x-ratelimit-remaining-tokens / x-ratelimit-reset-tokens */
  observe(headers: Headers, nextCallTokens: number) {
    const remaining = Number(headers.get("x-ratelimit-remaining-tokens") ?? NaN);
    const reset = parseDurationMs(headers.get("x-ratelimit-reset-tokens"));
    if (Number.isFinite(remaining) && remaining < nextCallTokens && reset) {
      this.pushBack(reset + 500);
    }
  }
}

// ---------------------------------------------------------------------
// LLM adapters → both return { args, usage }
// ---------------------------------------------------------------------
function parseJsonLoose(text: unknown): any | null {
  if (text && typeof text === "object") return text;
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(`LLM call timeout after ${CALL_TIMEOUT_MS / 1000}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function callGroq(
  cfg: LlmConfig, system: string, user: string, tool: ToolDef, gate: RateGate, estTokens: number,
): Promise<{ args: any; usage: Usage }> {
  let jsonMode = false;
  let lastErr = "unknown error";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await gate.wait();

    const body: Record<string, unknown> = {
      model: cfg.model,
      temperature: 0.2,
      max_completion_tokens: 3000,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: jsonMode
            ? `${user}\n\nReturn ONLY one JSON object matching this JSON Schema:\n${JSON.stringify(tool.schema)}`
            : user,
        },
      ],
    };
    if (cfg.model.includes("gpt-oss")) body.reasoning_effort = "low";
    if (jsonMode) {
      body.response_format = { type: "json_object" };
    } else {
      body.tools = [{
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.schema },
      }];
      body.tool_choice = { type: "function", function: { name: tool.name } };
    }

    const res = await fetchWithTimeout(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    gate.observe(res.headers, estTokens);
    const data = await res.json().catch(() => null);

    if (res.status === 429) {
      const wait = parseDurationMs(res.headers.get("retry-after")) ??
        parseDurationMs(res.headers.get("x-ratelimit-reset-tokens")) ?? 15_000;
      gate.pushBack(wait + 500);
      lastErr = `rate limited (429), waited ${Math.round(wait / 1000)}s`;
      continue;
    }
    if (!res.ok) {
      lastErr = `Groq ${res.status}: ${data?.error?.message ?? res.statusText}`;
      // Model produced malformed tool call → retry once in JSON mode
      if (res.status === 400 && !jsonMode) { jsonMode = true; continue; }
      if (res.status >= 500) { gate.pushBack(3000); continue; }
      throw new Error(lastErr);
    }

    const msg = data?.choices?.[0]?.message;
    const parsed = parseJsonLoose(msg?.tool_calls?.[0]?.function?.arguments ?? msg?.content);
    if (!parsed) {
      lastErr = "unparseable model output";
      if (!jsonMode) { jsonMode = true; continue; }
      continue;
    }
    return {
      args: parsed,
      usage: { input: data?.usage?.prompt_tokens ?? 0, output: data?.usage?.completion_tokens ?? 0 },
    };
  }
  throw new Error(`Groq failed after retries: ${lastErr}`);
}

async function callAnthropic(
  cfg: LlmConfig, system: string, user: string, tool: ToolDef, gate: RateGate,
): Promise<{ args: any; usage: Usage }> {
  let lastErr = "unknown error";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await gate.wait();
    const res = await fetchWithTimeout(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 3000,
        system,
        tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }],
        tool_choice: { type: "tool", name: tool.name },
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      const wait = parseDurationMs(res.headers.get("retry-after")) ?? 10_000;
      gate.pushBack(wait);
      lastErr = `Claude ${res.status}`;
      continue;
    }
    if (!res.ok) throw new Error(`Claude ${res.status}: ${data?.error?.message ?? res.statusText}`);
    if (data?.stop_reason === "max_tokens") throw new Error("Claude response truncated (max_tokens)");
    const block = data?.content?.find((b: any) => b.type === "tool_use" && b.name === tool.name);
    if (!block?.input) throw new Error(`No structured output (stop_reason=${data?.stop_reason})`);
    return {
      args: block.input,
      usage: { input: data?.usage?.input_tokens ?? 0, output: data?.usage?.output_tokens ?? 0 },
    };
  }
  throw new Error(`Claude failed after retries: ${lastErr}`);
}

function callLLM(cfg: LlmConfig, system: string, user: string, tool: ToolDef, gate: RateGate, estTokens: number) {
  return cfg.provider === "groq"
    ? callGroq(cfg, system, user, tool, gate, estTokens)
    : callAnthropic(cfg, system, user, tool, gate);
}

// ---------------------------------------------------------------------
// Validation — the AI is never trusted blindly
// ---------------------------------------------------------------------
function collectNumbers(source: unknown): number[] {
  const m = JSON.stringify(source ?? {}).match(/-?\d+(?:\.\d+)?/g) ?? [];
  return [...new Set(m.map(Number))].filter((n) => Number.isFinite(n));
}

const roundTo = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Decimal numbers in AI text that cannot be traced back to the source data. */
function unverifiedNumbers(text: string, src: number[]): string[] {
  const found = text.match(/-?\d+\.\d+/g) ?? [];
  return [...new Set(found.filter((s) => {
    const v = Number(s);
    const dp = s.split(".")[1]?.length ?? 0;
    return !src.some((n) =>
      Math.abs(roundTo(n, dp) - v) < 1e-9 ||
      Math.abs(roundTo(n * 100, dp) - v) < 1e-9 ||
      Math.abs(roundTo(n / 100, dp) - v) < 1e-9
    );
  }))];
}

/**
 * Whole-number quantities with a unit — "150 days", "42%", "KWD 1,250,000", "KWD 3.0M" —
 * that cannot be traced back to the source data. Catches invented counts the decimal
 * check misses. Money allows 1% tolerance (K/M abbreviations); days/percent are exact
 * after rounding.
 */
function unverifiedQuantities(text: string, src: number[]): string[] {
  const bad: string[] = [];
  const toNum = (s: string) => Number(s.replace(/,/g, ""));
  const matches = (v: number, tol: number, alsoPct = false) =>
    src.some((n) => {
      const cands = alsoPct ? [n, n * 100] : [n];
      return cands.some((c) =>
        tol > 0 ? Math.abs(c - v) <= Math.max(1, Math.abs(c) * tol)
                : Math.round(c) === Math.round(v) || Math.abs(c - v) < 1e-9);
    });

  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:-\s*)?(days?|d)\b/gi)) {
    const v = toNum(m[1]);
    if (Number.isFinite(v) && v >= 2 && !matches(v, 0)) bad.push(`${m[1]} ${m[2]}`);
  }
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(يوما|يوماً|يوم|أيام|ايام)/g)) {
    const v = toNum(m[1]);
    if (Number.isFinite(v) && v >= 2 && !matches(v, 0)) bad.push(`${m[1]} ${m[2]}`);
  }
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*%/g)) {
    const v = toNum(m[1]);
    if (Number.isFinite(v) && !matches(v, 0, true)) bad.push(`${m[1]}%`);
  }
  for (const m of text.matchAll(/(?<![\d.])%(\d[\d,]*(?:\.\d+)?)/g)) {
    const v = toNum(m[1]);
    if (Number.isFinite(v) && !matches(v, 0, true)) bad.push(`%${m[1]}`);
  }
  for (const m of text.matchAll(/(?:\b(?:KWD|KD)|د\.ك|دينار)\s*(\d[\d,]*(?:\.\d+)?)\s*([KkMm]|مليون|ألف)?/g)) {
    let v = toNum(m[1]);
    if (m[2]) v *= /m|مليون/i.test(m[2]) ? 1_000_000 : 1_000;
    if (Number.isFinite(v) && v >= 100 && !matches(v, m[2] ? 0.05 : 0.01)) bad.push(m[0].trim());
  }
  // amount written before the currency: "-103,560 KWD", "3.00M KWD", "257,292 د.ك"
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?\s*(?:KWD|KD|د\.ك|دينار)/g)) {
    let v = toNum(m[1]);
    if (m[2]) v *= /m/i.test(m[2]) ? 1_000_000 : 1_000;
    if (Number.isFinite(v) && v >= 100 && !matches(v, m[2] ? 0.05 : 0.01) && !matches(-v, m[2] ? 0.05 : 0.01)) bad.push(m[0].trim());
  }
  for (const m of text.matchAll(/\b(?:KWD|KD)\s*(\d[\d,]*(?:\.\d+)?)\s*([KkMm])?\b/g)) {
    let v = toNum(m[1]);
    if (m[2]) v *= /m/i.test(m[2]) ? 1_000_000 : 1_000;
    if (Number.isFinite(v) && v >= 100 && !matches(v, m[2] ? 0.05 : 0.01)) bad.push(m[0].trim());
  }
  return [...new Set(bad)];
}

function pick<T extends readonly string[]>(
  value: unknown, allowed: T, fallback: T[number], issues: string[], label: string,
): T[number] {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T[number];
  issues.push(`${label}: invalid "${String(value)}" → "${fallback}"`);
  return fallback;
}

type Policy = { rag?: string; confidence?: string; cpi?: number | null; knownProjects?: string[]; lang?: Lang };

/** Deterministic wording check: narrative must not contradict CPI. */
function cpiContradiction(text: string, cpi: number | null | undefined): string | null {
  if (cpi === null || cpi === undefined || !Number.isFinite(cpi)) return null;
  if (cpi >= 1 && /\b(over|above)[\s-]budget\b|\bcost overrun\b/i.test(text)) {
    return `AI_CONTRADICTION: text says over budget but CPI ${cpi} >= 1 (on/under budget) — reject or correct`;
  }
  if (cpi < 0.98 && /\bunder[\s-]budget\b/i.test(text)) {
    return `AI_CONTRADICTION: text says under budget but CPI ${cpi} < 1 (over budget) — reject or correct`;
  }
  return null;
}

/**
 * top_risks → "PROJECT — Risk — Impact" strings (the UI and PDF render strings).
 * Accepts the structured objects (preferred) or legacy strings; flags unknown
 * projects, missing impacts and impacts without any number.
 */
function normalizeTopRisks(raw: unknown, known: string[]): { risks: string[]; flags: string[] } {
  const flags: string[] = [];
  if (!Array.isArray(raw)) return { risks: [], flags };
  const knownSet = new Set([...known, PORTFOLIO_KEY]);
  const risks: string[] = [];
  const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

  for (const item of raw.slice(0, 3)) {
    let no = "", risk = "", impact = "";
    if (item && typeof item === "object") {
      no = clean((item as any).project_no);
      risk = clean((item as any).risk);
      impact = clean((item as any).impact);
    } else if (typeof item === "string") {
      const parts = item.split(/\s+[—–-]\s+/);
      no = clean(parts[0]);
      risk = clean(parts[1]);
      impact = clean(parts.slice(2).join(" — "));
    }
    if (!risk) continue;
    if (known.length && !knownSet.has(no)) flags.push(`AI_TOP_RISK_UNKNOWN_PROJECT: "${no || "?"}"`);
    if (!impact) flags.push(`AI_TOP_RISK_NO_IMPACT: ${no || "?"}`);
    else if (!/\d/.test(impact)) flags.push(`AI_TOP_RISK_UNQUANTIFIED: ${no || "?"}`);
    risks.push([no || PORTFOLIO_KEY, risk, impact || "impact not stated"].join(" — "));
  }
  if (raw.length > 3) flags.push(`AI_SCHEMA: top_risks had ${raw.length} items, kept 3`);
  return { risks, flags };
}

function normalizeInsight(
  raw: any, deterministicFlags: string[], sourceNums: number[], label: string, policy: Policy = {},
) {
  const issues: string[] = [];
  const aiRag = pick(raw?.rag, RAG, "amber", issues, `${label}.rag`);
  const trend = pick(raw?.trend, TREND, "unknown", issues, `${label}.trend`);
  const aiConfidence = pick(raw?.confidence, CONFIDENCE, "low", issues, `${label}.confidence`);

  // Policy always wins over the model
  const policyRag = (RAG as readonly string[]).includes(policy.rag ?? "") ? policy.rag as typeof RAG[number] : null;
  const policyConf = (CONFIDENCE as readonly string[]).includes(policy.confidence ?? "")
    ? policy.confidence as typeof CONFIDENCE[number] : null;
  const rag = policyRag ?? aiRag;
  let confidence = policyConf ?? aiConfidence;
  if (policyRag && aiRag !== policyRag) {
    issues.push(`AI rated ${aiRag}, policy RAG ${policyRag} applied — check narrative consistency`);
  }
  const scheduleBasis = pick(raw?.schedule_basis, SCHEDULE_BASIS, "both_unreliable", issues, `${label}.schedule_basis`);

  const headline = String(raw?.headline ?? "").trim().slice(0, 200) || "No headline returned";
  const summary = String(raw?.summary ?? "").trim();
  const rootCauses = Array.isArray(raw?.root_causes) ? raw.root_causes : [];
  const actions = Array.isArray(raw?.recommended_actions) ? raw.recommended_actions : [];
  const forecast: Record<string, unknown> = {
    ...(raw?.forecast && typeof raw.forecast === "object" ? raw.forecast : {}),
    schedule_basis: scheduleBasis,
  };
  if (Array.isArray(raw?.systemic_issues)) forecast.systemic_issues = raw.systemic_issues;

  let topRiskFlags: string[] = [];
  if (raw?.top_risks !== undefined) {
    const tr = normalizeTopRisks(raw.top_risks, policy.knownProjects ?? []);
    forecast.top_risks = tr.risks;
    topRiskFlags = tr.flags;
  }

  const narrative = [
    headline, summary, JSON.stringify(rootCauses), String(forecast.comment ?? ""),
    JSON.stringify(forecast.top_risks ?? []),
  ].join(" ");
  const unverified = unverifiedNumbers(narrative, sourceNums);
  const badQty = unverifiedQuantities(narrative, sourceNums);

  const validationFlags: string[] = [];
  if (unverified.length) {
    confidence = "low";
    validationFlags.push(`AI_UNVERIFIED_NUMBERS: ${unverified.join(", ")} — verify before approving`);
  }
  if (badQty.length) {
    confidence = "low";
    validationFlags.push(`AI_UNVERIFIED_QUANTITIES: ${badQty.join(", ")} — not found in source data, verify before approving`);
  }
  if (policy.lang) {
    const r = arabicRatio(`${headline} ${summary}`);
    if (policy.lang === "en" && r > 0.2) {
      validationFlags.push(`AI_WRONG_LANGUAGE: requested English but ${Math.round(r * 100)}% of the text is Arabic — reject and re-run`);
    } else if (policy.lang === "ar" && r < 0.4) {
      validationFlags.push(`AI_WRONG_LANGUAGE: requested Arabic but text is mostly English — reject and re-run`);
    }
  }
  const contradiction = cpiContradiction(`${headline} ${summary}`, policy.cpi);
  if (contradiction) {
    confidence = "low";
    validationFlags.push(contradiction);
  }
  validationFlags.push(...topRiskFlags);
  validationFlags.push(...issues.map((i) => `AI_SCHEMA: ${i}`));

  const aiFlags = Array.isArray(raw?.data_quality_flags) ? raw.data_quality_flags.map(String) : [];
  return {
    rag,
    trend: trend === "unknown" ? null : trend,
    confidence,
    headline,
    summary,
    root_causes: rootCauses,
    forecast,
    recommended_actions: actions,
    data_quality_flags: [...new Set([...deterministicFlags, ...aiFlags, ...validationFlags])],
  };
}

/** Portfolio RAG policy: red if ≥25% of rated projects are red; amber if any red/amber; else green. */
function portfolioPolicyRag(projectRags: string[]): string {
  const rated = projectRags.filter((r) => (RAG as readonly string[]).includes(r));
  if (!rated.length) return "amber";
  const red = rated.filter((r) => r === "red").length;
  if (red / rated.length >= 0.25) return "red";
  if (rated.some((r) => r === "red" || r === "amber")) return "amber";
  return "green";
}

/** Insight written when the LLM fails for a project — keeps the run moving and visible. */
function failureInsight(deterministicFlags: string[], error: string, policy: Policy = {}) {
  return {
    rag: (RAG as readonly string[]).includes(policy.rag ?? "") ? policy.rag : "amber",
    trend: null,
    confidence: "low",
    headline: "AI analysis failed — review this project manually",
    summary: "The automated assessment could not be produced for this run. Metrics and data-quality flags are still attached.",
    root_causes: [],
    forecast: { finish_risk: "not_applicable", comment: "", schedule_basis: "not_applicable" },
    recommended_actions: [],
    data_quality_flags: [...new Set([...deterministicFlags, `AI_FAILED: ${error.slice(0, 300)}`])],
  };
}

// ---------------------------------------------------------------------
// Payload shaping (keeps each call inside free-tier token limits)
// ---------------------------------------------------------------------
function truncateStrings(v: any, max: number): any {
  if (typeof v === "string") return v.length > max ? `${v.slice(0, max)}…` : v;
  if (Array.isArray(v)) return v.map((x) => truncateStrings(x, max));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, truncateStrings(x, max)]));
  }
  return v;
}

function compactProject(p: any): any {
  const c = structuredClone(p ?? {});
  if (Array.isArray(c.trend)) c.trend = c.trend.slice(-6);
  if (Array.isArray(c.invoices)) c.invoices = c.invoices.slice(-8);
  if (Array.isArray(c.change_orders)) c.change_orders = c.change_orders.slice(-10);
  if (Array.isArray(c.milestones)) c.milestones = c.milestones.slice(0, 15);
  return truncateStrings(c, 300);
}

const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

// ---------------------------------------------------------------------
// Authorization: cron secret OR signed-in reviewer
// ---------------------------------------------------------------------
type Caller = { kind: "scheduled"; userId: null } | { kind: "manual"; userId: string };

async function authorize(req: Request, url: string, anonKey: string): Promise<Caller | Response> {
  const cronSecret = Deno.env.get("AI_CRON_SECRET");
  const cronHeader = req.headers.get("x-cron-secret");
  if (cronSecret && cronHeader && cronHeader === cronSecret) return { kind: "scheduled", userId: null };

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ ok: false, error: "Missing Authorization header" }, 401);

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: "Invalid or expired session" }, 401);

  const { data: canReview, error: roleErr } = await userClient.rpc("fn_ai_can_review");
  if (roleErr) return json({ ok: false, error: `Role check failed: ${roleErr.message}` }, 500);
  if (canReview !== true) return json({ ok: false, error: "Not authorized — Admin / PMO / CEO only" }, 403);
  return { kind: "manual", userId: userData.user.id };
}

// ---------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------
async function openRun(admin: SupabaseClient, cfg: LlmConfig, caller: Caller, asOf: string | undefined, language: Lang) {
  // Fail stalled runs; block if a live run exists
  const staleBefore = new Date(Date.now() - STALE_RUN_MINUTES * 60_000).toISOString();
  await admin.from("ai_runs").update({
    status: "failed",
    error_message: "Stalled — no heartbeat for 10 minutes",
    finished_at: new Date().toISOString(),
  }).eq("status", "running").lt("last_heartbeat", staleBefore);

  const { data: live } = await admin.from("ai_runs").select("id").eq("status", "running").limit(1);
  if (live && live.length) {
    return json({
      ok: false, status: "running", run_id: live[0].id,
      error: "A run is already in progress — call mode \"continue\" with this run_id",
    }, 409);
  }

  const { data: run, error } = await admin.from("ai_runs").insert({
    trigger_type: caller.kind,
    triggered_by: caller.userId,
    status: "running",
    provider: cfg.provider,
    model: cfg.model,
    prompt_version: PROMPT_VERSION,
    language,
    ...(asOf ? { as_of: asOf } : {}),
  }).select("*").single();
  if (error || !run) return json({ ok: false, stage: "open_run", error: error?.message }, 500);
  return run;
}

async function processBatch(admin: SupabaseClient, cfg: LlmConfig, run: any): Promise<Response> {
  const t0 = Date.now();
  const budget = Number(Deno.env.get("AI_TIME_BUDGET_MS") ?? "110000");
  const lang: Lang = run.language === "ar" ? "ar" : "en";
  const gate = new RateGate();
  const usage: Usage = { input: 0, output: 0 };
  const batchLog: string[] = [];

  const heartbeat = () =>
    admin.from("ai_runs").update({ last_heartbeat: new Date().toISOString() }).eq("id", run.id);
  await admin.from("ai_runs").update({
    invocations: (run.invocations ?? 0) + 1,
    last_heartbeat: new Date().toISOString(),
  }).eq("id", run.id);

  // 1) Rebuild the deterministic payload for the run's as_of date
  const { data: payload, error: pErr } = await admin.rpc("fn_ai_build_payload", { p_as_of: run.as_of });
  if (pErr) return json({ ok: false, run_id: run.id, stage: "build_payload", error: pErr.message }, 500);
  const projects: any[] = Array.isArray(payload?.projects) ? payload.projects : [];

  const nos = projects.map((p) => String(p?.project?.project_no ?? "")).filter(Boolean);
  const { data: idRows, error: idErr } = await admin.from("projects").select("id, project_no").in("project_no", nos);
  if (idErr) return json({ ok: false, run_id: run.id, stage: "resolve_ids", error: idErr.message }, 500);
  const idByNo = new Map((idRows ?? []).map((r: any) => [String(r.project_no), String(r.id)]));

  if (run.projects_count !== projects.length) {
    await admin.from("ai_runs").update({ projects_count: projects.length }).eq("id", run.id);
  }

  // 2) Which projects are already done in this run?
  const { data: doneRows } = await admin.from("ai_insights")
    .select("project_id").eq("run_id", run.id).eq("scope", "project");
  const doneIds = new Set((doneRows ?? []).map((r: any) => String(r.project_id)));
  const todo = projects.filter((p) => {
    const id = idByNo.get(String(p?.project?.project_no ?? ""));
    return id && !doneIds.has(id);
  });

  const projectSystem = `${baseRules(lang)}\n\n${PROJECT_TASK}`;
  let stoppedForTime = false;

  // 3) Project calls
  for (const p of todo) {
    if (Date.now() - t0 + gate.msUntilReady() + EST_CALL_MS > budget) { stoppedForTime = true; break; }

    const no = String(p.project.project_no);
    const compact = compactProject(p);
    const userMsg = `${langReminder(lang)}\nAs-of date: ${payload.as_of}\nProject data (JSON):\n${JSON.stringify(compact)}`;
    const est = estimateTokens(projectSystem + userMsg) + 1800;
    const flags: string[] = Array.isArray(p.data_quality_flags) ? p.data_quality_flags : [];
    const policy: Policy = {
      rag: p?.computed?.rag_rule,
      confidence: p?.computed?.data_confidence,
      cpi: p?.computed?.cpi_calc == null ? null : Number(p.computed.cpi_calc),
    };

    let row: Record<string, unknown>;
    try {
      const { args, usage: u } = await callLLM(cfg, projectSystem, userMsg, PROJECT_TOOL, gate, est);
      usage.input += u.input; usage.output += u.output;
      row = { ...normalizeInsight(args, flags, collectNumbers(compact), no, { ...policy, lang }), raw_response: args };
      batchLog.push(`${no}: ok (${policy.rag ?? "?"})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      row = { ...failureInsight(flags, msg, policy), raw_response: null };
      batchLog.push(`${no}: FAILED — ${msg}`);
    }

    const { error: insErr } = await admin.from("ai_insights").insert({
      run_id: run.id, scope: "project", project_id: idByNo.get(no),
      input_snapshot: p, ...row,
    });
    if (insErr && insErr.code !== "23505") batchLog.push(`${no}: store error — ${insErr.message}`);
    await heartbeat();
  }

  // 4) Progress
  const { data: projRows } = await admin.from("ai_insights")
    .select("rag, trend, confidence, headline, data_quality_flags, input_snapshot")
    .eq("run_id", run.id).eq("scope", "project");
  const projDone = projRows ?? [];
  const failed = projDone.filter((r: any) =>
    (r.data_quality_flags ?? []).some((f: string) => f.startsWith("AI_FAILED"))).length;

  const totals = {
    tokens_in: (run.tokens_in ?? 0) + usage.input,
    tokens_out: (run.tokens_out ?? 0) + usage.output,
  };
  const costUsd = Number(((totals.tokens_in * cfg.priceIn + totals.tokens_out * cfg.priceOut) / 1_000_000).toFixed(4));
  const expected = projects.filter((p) => idByNo.has(String(p?.project?.project_no ?? ""))).length;
  const allProjectsDone = projDone.length >= expected;

  // 5) Portfolio call (only after every project is done)
  let portfolioDone = false;
  if (allProjectsDone && !stoppedForTime) {
    const { data: existing } = await admin.from("ai_insights")
      .select("id").eq("run_id", run.id).eq("scope", "portfolio").limit(1);
    portfolioDone = !!(existing && existing.length);

    if (!portfolioDone && Date.now() - t0 + gate.msUntilReady() + EST_CALL_MS <= budget) {
      const assessments = projDone.map((r: any) => ({
        project_no: r.input_snapshot?.project?.project_no,
        name: r.input_snapshot?.project?.name,
        rag: r.rag, trend: r.trend, confidence: r.confidence, headline: r.headline,
        cpi_calc: r.input_snapshot?.computed?.cpi_calc,
        spi_calc: r.input_snapshot?.computed?.spi_calc,
        spi_time_proxy: r.input_snapshot?.computed?.spi_time_proxy,
        eac_cpi: r.input_snapshot?.computed?.eac_cpi,
        bac: r.input_snapshot?.project?.bac,
        flags: (r.data_quality_flags ?? []).filter((f: string) => /^[A-Z_]+:/.test(f) && !f.startsWith("AI_")),
      }));
      const knownNos = assessments.map((a: any) => String(a.project_no ?? "")).filter(Boolean);
      const portfolioRag = portfolioPolicyRag(projDone.map((r: any) => r.rag));
      const portfolioInput = {
        as_of: payload.as_of,
        portfolio_rag: portfolioRag,
        portfolio_rag_policy: "red if >=25% of rated projects are red; amber if any project is red or amber; else green",
        rag_policy: payload.rag_policy,
        portfolio: payload.portfolio,
        assessments,
      };
      const userMsg = `${langReminder(lang)}\nPortfolio data (JSON):\n${JSON.stringify(portfolioInput)}`;
      const system = `${baseRules(lang)}\n\n${PORTFOLIO_TASK}`;
      const policy: Policy = {
        rag: portfolioRag,
        cpi: payload?.portfolio?.cpi_weighted == null ? null : Number(payload.portfolio.cpi_weighted),
        knownProjects: knownNos,
      };

      let row: Record<string, unknown>;
      try {
        const { args, usage: u } = await callLLM(cfg, system, userMsg, portfolioTool(knownNos), gate,
          estimateTokens(system + userMsg) + 1800);
        usage.input += u.input; usage.output += u.output;
        totals.tokens_in += u.input; totals.tokens_out += u.output;
        row = { ...normalizeInsight(args, [], collectNumbers(portfolioInput), "portfolio", { ...policy, lang }), raw_response: args };
      } catch (e) {
        row = { ...failureInsight([], e instanceof Error ? e.message : String(e), policy), raw_response: null };
      }
      const { error: insErr } = await admin.from("ai_insights").insert({
        run_id: run.id, scope: "portfolio", project_id: null,
        input_snapshot: portfolioInput, ...row,
      });
      portfolioDone = !insErr || insErr.code === "23505";
      if (insErr && insErr.code !== "23505") batchLog.push(`portfolio: store error — ${insErr.message}`);
    }
  }

  // 6) Finalize or keep running
  const finished = allProjectsDone && portfolioDone;
  const status = finished ? (failed > 0 ? "partial" : "success") : "running";

  if (finished) {
    // Review queue shows only the latest completed run
    await admin.from("ai_insights").update({ status: "superseded" })
      .eq("status", "pending_review").neq("run_id", run.id);
  }

  await admin.from("ai_runs").update({
    status,
    projects_done: projDone.length,
    projects_failed: failed,
    insights_count: projDone.length + (portfolioDone ? 1 : 0),
    tokens_in: totals.tokens_in,
    tokens_out: totals.tokens_out,
    cost_usd: costUsd,
    last_heartbeat: new Date().toISOString(),
    ...(finished ? { finished_at: new Date().toISOString() } : {}),
    ...(failed > 0 ? { error_message: `${failed} project(s) failed — see AI_FAILED flags` } : {}),
  }).eq("id", run.id);

  const ragCounts = projDone.reduce((acc: Record<string, number>, r: any) =>
    ({ ...acc, [r.rag]: (acc[r.rag] ?? 0) + 1 }), {});

  return json({
    ok: true,
    version: FUNCTION_VERSION,
    prompt_version: PROMPT_VERSION,
    provider: cfg.provider,
    model: cfg.model,
    run_id: run.id,
    status,
    progress: `${projDone.length}/${expected} projects${portfolioDone ? " + portfolio" : ""}`,
    this_batch: batchLog,
    rag_counts: ragCounts,
    projects_failed: failed,
    usage_total: { ...totals, cost_usd: costUsd },
    batch_seconds: Math.round((Date.now() - t0) / 1000),
    next: finished
      ? "Done — review in v_ai_insights_pending"
      : `Call again with { mode: "continue", run_id: "${run.id}" }`,
  });
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return json({ ok: false, error: "Server misconfigured: missing Supabase env" }, 500);
  }

  let body: { mode?: string; as_of?: string; language?: string; run_id?: string } = {};
  try { body = await req.json(); } catch { body = {}; }

  const mode = body.mode ?? "dry_run";
  if (body.as_of && !/^\d{4}-\d{2}-\d{2}$/.test(body.as_of)) {
    return json({ ok: false, error: "as_of must be YYYY-MM-DD" }, 400);
  }
  const language: Lang = (body.language ?? Deno.env.get("AI_OUTPUT_LANGUAGE") ?? "en") === "ar" ? "ar" : "en";

  const caller = await authorize(req, url, anonKey);
  if (caller instanceof Response) return caller;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // ---- dry_run: payload preview, no AI ----
  if (mode === "dry_run") {
    const t0 = Date.now();
    const { data: payload, error } = await admin.rpc("fn_ai_build_payload", body.as_of ? { p_as_of: body.as_of } : {});
    if (error) return json({ ok: false, stage: "build_payload", error: error.message }, 500);
    const text = JSON.stringify(payload);
    const projects = Array.isArray(payload?.projects) ? payload.projects : [];
    return json({
      ok: true, version: FUNCTION_VERSION, mode, trigger: caller.kind,
      stats: {
        active_projects: projects.length,
        payload_kb: Number((text.length / 1024).toFixed(1)),
        est_input_tokens: estimateTokens(text),
        projects_with_dq_flags: projects.filter((p: any) => (p.data_quality_flags?.length ?? 0) > 0).length,
        build_ms: Date.now() - t0,
      },
      payload,
    });
  }

  const cfg = loadLlmConfig();
  if (typeof cfg === "string") return json({ ok: false, error: cfg }, 500);

  // ---- analyze: open a run, process first batch ----
  if (mode === "analyze") {
    const run = await openRun(admin, cfg, caller, body.as_of, language);
    if (run instanceof Response) return run;
    return await processBatch(admin, cfg, run);
  }

  // ---- continue: resume a running run ----
  if (mode === "continue") {
    let q = admin.from("ai_runs").select("*").eq("status", "running");
    q = body.run_id ? q.eq("id", body.run_id) : q.order("started_at", { ascending: false });
    const { data: runs, error } = await q.limit(1);
    if (error) return json({ ok: false, stage: "load_run", error: error.message }, 500);
    if (!runs || !runs.length) return json({ ok: false, error: "No running run found to continue" }, 404);
    const run = runs[0];
    if (run.provider && run.provider !== cfg.provider) {
      return json({ ok: false, error: `Run was started with ${run.provider}; current AI_PROVIDER is ${cfg.provider}` }, 409);
    }
    return await processBatch(admin, cfg, run);
  }

  return json({ ok: false, error: `Unknown mode: ${mode}` }, 400);
});
