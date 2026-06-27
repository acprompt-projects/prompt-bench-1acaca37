===
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────
export interface PromptTemplate {
  id: string;
  template: string;
  variables?: Record<string, string>;
}

export type Provider = "openai" | "anthropic" | "local";

export interface EndpointConfig {
  id: string;
  provider: Provider;
  url: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export type RubricType = "keyword" | "regex" | "length_min" | "length_max" | "json_valid";

export interface Rubric {
  id: string;
  name: string;
  type: RubricType;
  weight: number;
  params: Record<string, unknown>;
}

export interface BenchmarkConfig {
  name: string;
  prompts: PromptTemplate[];
  endpoints: EndpointConfig[];
  rubrics: Rubric[];
  iterations?: number;
}

export interface ScoreDetail {
  rubricId: string;
  rubricName: string;
  weight: number;
  raw: number;      // 0-1
  weighted: number;  // raw * weight
}

export interface RunResult {
  promptId: string;
  endpointId: string;
  iteration: number;
  renderedPrompt: string;
  response: string;
  latencyMs: number;
  scores: ScoreDetail[];
  totalScore: number;
  error?: string;
}

export interface BenchmarkReport {
  name: string;
  timestamp: string;
  config: BenchmarkConfig;
  results: RunResult[];
  summary: SummaryRow[];
}

export interface SummaryRow {
  promptId: string;
  endpointId: string;
  avgLatencyMs: number;
  avgScore: number;
  runs: number;
  errors: number;
}

// ── Template rendering ───────────────────────────────────────────────────
export function renderTemplate(tpl: PromptTemplate): string {
  let text = tpl.template;
  for (const [key, val] of Object.entries(tpl.variables ?? {})) {
    text = text.replaceAll(`{{${key}}}`, val);
  }
  return text;
}

// ── Scoring ──────────────────────────────────────────────────────────────
export function scoreResponse(response: string, rubrics: Rubric[]): ScoreDetail[] {
  return rubrics.map((r) => {
    let raw = 0;
    switch (r.type) {
      case "keyword": {
        const keywords = (r.params.keywords as string[]) ?? [];
        const lower = response.toLowerCase();
        const hits = keywords.filter((k) => lower.includes(k.toLowerCase())).length;
        raw = keywords.length ? hits / keywords.length : 0;
        break;
      }
      case "regex": {
        const pattern = r.params.pattern as string;
        const flags = (r.params.flags as string) ?? "";
        raw = new RegExp(pattern, flags).test(response) ? 1 : 0;
        break;
      }
      case "length_min": {
        const min = (r.params.min as number) ?? 0;
        raw = response.length >= min ? 1 : response.length / Math.max(min, 1);
        break;
      }
      case "length_max": {
        const max = (r.params.max as number) ?? Infinity;
        raw = response.length <= max ? 1 : max / Math.max(response.length, 1);
        break;
      }
      case "json_valid": {
        try { JSON.parse(response); raw = 1; } catch { raw = 0; }
        break;
      }
    }
    const clipped = Math.max(0, Math.min(1, raw));
    return { rubricId: r.id, rubricName: r.name, weight: r.weight, raw: clipped, weighted: clipped * r.weight };
  });
}

// ── LLM call ─────────────────────────────────────────────────────────────
async function callEndpoint(endpoint: EndpointConfig, prompt: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(endpoint.headers ?? {}) };
  if (endpoint.apiKey) {
    headers["Authorization"] = `Bearer ${endpoint.apiKey}`;
  }

  let body: Record<string, unknown>;
  if (endpoint.provider === "anthropic") {
    headers["x-api-key"] = endpoint.apiKey ?? "";
    headers["anthropic-version"] = "2023-06-01";
    body = { model: endpoint.model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] };
  } else {
    body = { model: endpoint.model, messages: [{ role: "user", content: prompt }], max_tokens: 1024 };
  }

  const res = await fetch(endpoint.url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  if (endpoint.provider === "anthropic") {
    const content = json.content as Array<{ type: string; text: string }>;
    return content?.[0]?.text ?? "";
  }
  const choices = json.choices as Array<{ message: { content: string } }>;
  return choices?.[0]?.message?.content ?? "";
}

// ── Runner ───────────────────────────────────────────────────────────────
export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkReport> {
  const iterations = config.iterations ?? 1;
  const results: RunResult[] = [];

  for (const prompt of config.prompts) {
    const rendered = renderTemplate(prompt);
    for (const endpoint of config.endpoints) {
      for (let i = 0; i < iterations; i++) {
        let response = "";
        let latencyMs = 0;
        let error: string | undefined;
        try {
          const start = performance.now();
          response = await callEndpoint(endpoint, rendered);
          latencyMs = Math.round(performance.now() - start);
        } catch (err: unknown) {
          error = err instanceof Error ? err.message : String(err);
          latencyMs = 0;
        }
        const scores = scoreResponse(response, config.rubrics);
        const totalScore = scores.reduce((s, sc) => s + sc.weighted, 0);
        results.push({ promptId: prompt.id, endpointId: endpoint.id, iteration: i, renderedPrompt: rendered, response, latencyMs, scores, totalScore, error });
      }
    }
  }

  const summary = buildSummary(results);
  return { name: config.name, timestamp: new Date().toISOString(), config, results, summary };
}

function buildSummary(results: RunResult[]): SummaryRow[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = `${r.promptId}::${r.endpointId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  return Array.from(groups.entries()).map(([, runs]) => {
    const valid = runs.filter((r) => !r.error);
    return {
      promptId: runs[0].promptId,
      endpointId: runs[0].endpointId,
      avgLatencyMs: valid.length ? Math.round(valid.reduce((s, r) => s + r.latencyMs, 0) / valid.length) : 0,
      avgScore: valid.length ? +(valid.reduce((s, r) => s + r.totalScore, 0) / valid.length).toFixed(4) : 0,
      runs: runs.length,
      errors: runs.filter((r) => r.error).length,
    };
  });
}

// ── Config loader ────────────────────────────────────────────────────────
export async function loadConfig(path: string): Promise<BenchmarkConfig> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as BenchmarkConfig;
}