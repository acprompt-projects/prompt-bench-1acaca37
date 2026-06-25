# Prompt Evaluation Framework & Scoring Schema

## 1. Overview

This document defines the benchmark architecture for `prompt-bench`, a CLI tool that compares LLM prompt variations against a target API. All implementation tasks must conform to these schemas and contracts.

---

## 2. Prompt Template Format

Prompt templates are YAML files stored in a `prompts/` directory. Each file defines one named prompt variation.

```yaml
# prompts/summarize_v1.yaml
id: summarize_v1
description: "Baseline summarization prompt with explicit instruction"
version: "1.0.0"
metadata:
  author: team
  tags: [summarization, baseline]
system: |
  You are a concise summarizer. Produce accurate, brief summaries.
user: |
  Summarize the following text in {{max_points}} bullet points:

  {{input_text}}
parameters:
  max_points:
    type: integer
    default: 3
    min: 1
    max: 10
  input_text:
    type: string
    required: true
```

### Template Rules

- `id`: Unique snake_case identifier, must match filename stem.
- `system` / `user`: Prompt strings using `{{param}}` mustache placeholders.
- `parameters`: Declared variables with type, default, and optional constraints.
- Unknown placeholders in prompt strings that lack a parameter declaration are errors at validation time.

---

## 3. Benchmark Suite Format

A benchmark suite is a YAML file that binds prompt templates to test cases.

```yaml
# benchmarks/summarize_bench.yaml
name: summarize_benchmark
description: "Compare summarization prompt variants"
prompts:
  - summarize_v1
  - summarize_v2
cases:
  - id: case_short_news
    input:
      max_points: 3
      input_text: "..."        # inline or file reference
    reference: "Expected summary or criteria"
  - id: case_long_article
    input:
      max_points: 5
      input_text: "@/data/article1.txt"  # @ prefix loads from file
    reference: "@/data/article1_summary.txt"
runs: 3                         # repeat each case for variance
```

---

## 4. Evaluation Criteria & Scoring Rubrics

Every criterion produces a float score in **[0, 1]** where 1 is best.

### 4.1 Accuracy (weight: 0.40)

Measures semantic correctness of the output against the reference.

| Score Range | Meaning |
|-------------|---------|
| 0.9 – 1.0   | Semantically equivalent to reference |
| 0.7 – 0.89  | Captures most key points; minor omissions |
| 0.4 – 0.69  | Partial; notable hallucinations or omissions |
| 0.0 – 0.39  | Substantially incorrect or irrelevant |

**Scoring method**: Cosine similarity of embedded output vs. reference using a sentence-transformer model. If no embedding model is available, fall back to a keyword-overlap heuristic (ROUGE-1 F1 normalized to [0,1]).

Evaluator config:
```yaml
accuracy:
  method: embedding           # embedding | keyword
  model: all-MiniLM-L6-v2    # only for embedding method
  threshold_reference: 0.85   # score ≥ this → "pass"
```

### 4.2 Latency (weight: 0.25)

Measures wall-clock response time in milliseconds.

| Score Range | Meaning |
|-------------|---------|
| 0.9 – 1.0   | ≤ p25 of all results in the run |
| 0.7 – 0.89  | ≤ p50 |
| 0.4 – 0.69  | ≤ p75 |
| 0.0 – 0.39  | > p75 |

**Scoring method**: Raw latency is recorded per call. After all calls complete, scores are computed relative to the distribution of latencies across all prompt variations in the benchmark suite. This makes latency scores relative, not absolute.

```yaml
latency:
  unit: ms
  scoring: relative            # relative | fixed
  fixed_thresholds:            # only if scoring=fixed
    excellent: 500
    good: 1500
    fair: 3000
```

### 4.3 Token Usage (weight: 0.20)

Combined metric of input + output tokens relative to the completion quality achieved.

| Score Range | Meaning |
|-------------|---------|
| 0.9 – 1.0   | ≤ p25 tokens-per-quality-point |
| 0.7 – 0.89  | ≤ p50 |
| 0.4 – 0.69  | ≤ p75 |
| 0.0 – 0.39  | > p75 |

**Scoring method**: Compute `tokens_used / max(accuracy, 0.01)` per call. Score against the distribution (same relative approach as latency). Captures efficiency — a prompt that uses fewer tokens for equal accuracy scores higher.

```yaml
token_usage:
  scoring: relative
  include_input_tokens: true
  include_output_tokens: true
```

### 4.4 Safety (weight: 0.15)

Measures absence of harmful, biased, or policy-violating content.

| Score Range | Meaning |
|-------------|---------|
| 1.0         | No safety issues detected |
| 0.5         | Minor concern (edge-case bias, ambiguous phrasing) |
| 0.0         | Clear safety violation |

**Scoring method**: Keyword/pattern matching against a configurable blocklist. Optional: call a moderation API endpoint if configured.

```yaml
safety:
  method: blocklist            # blocklist | moderation_api
  blocklist_file: safety_blocklist.yaml
  moderation_endpoint: ""      # URL if method=moderation_api
  fail_on_violation: false     # true → score=0 and halt the run
```

### 4.5 Composite Score

```
composite = Σ(criterion_score × weight)
```

Default weights: accuracy=0.40, latency=0.25, token_usage=0.20, safety=0.15. Weights are normalized so they sum to 1.0.

---

## 5. Result Schema (JSON)

The CLI outputs a single JSON object conforming to this schema.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "PromptBenchResult",
  "type": "object",
  "required": ["benchmark", "timestamp", "config", "prompts"],
  "properties": {
    "benchmark": {
      "type": "string",
      "description": "Benchmark suite name"
    },
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "config": {
      "type": "object",
      "properties": {
        "api_endpoint": { "type": "string" },
        "model": { "type": "string" },
        "runs_per_case": { "type": "integer" },
        "weights": {
          "type": "object",
          "properties": {
            "accuracy": { "type": "number" },
            "latency": { "type": "number" },
            "token_usage": { "type": "number" },
            "safety": { "type": "number" }
          }
        },
        "evaluators": { "type": "object" }
      }
    },
    "prompts": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "cases", "summary"],
        "properties": {
          "id": { "type": "string" },
          "cases": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["case_id", "runs"],
              "properties": {
                "case_id": { "type": "string" },
                "runs": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": ["run_index", "scores", "raw"],
                    "properties": {
                      "run_index": { "type": "integer" },
                      "scores": {
                        "type": "object",
                        "properties": {
                          "accuracy":  { "type": "number" },
                          "latency":   { "type": "number" },
                          "token_usage": { "type": "number" },
                          "safety":    { "type": "number" },
                          "composite": { "type": "number" }
                        }
                      },
                      "raw": {
                        "type": "object",
                        "properties": {
                          "output_text":    { "type": "string" },
                          "latency_ms":     { "type": "number" },
                          "input_tokens":   { "type": "integer" },
                          "output_tokens":  { "type": "integer" },
                          "error":          { "type": ["string", "null"] }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          "summary": {
            "type": "object",
            "required": ["mean_scores", "rank"],
            "properties": {
              "mean_scores": {
                "type": "object",
                "properties": {
                  "accuracy":    { "type": "number" },
                  "latency":     { "type": "number" },
                  "token_usage": { "type": "number" },
                  "safety":      { "type": "number" },
                  "composite":   { "type": "number" }
                }
              },
              "mean_latency_ms":    { "type": "number" },
              "mean_total_tokens":  { "type": "number" },
              "rank":               { "type": "integer" }
            }
          }
        }
      }
    }
  }
}
```

### Example minimal output

```json
{
  "benchmark": "summarize_benchmark",
  "timestamp": "2025-01-15T10:30:00Z",
  "config": {
    "api_endpoint": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4o-mini",
    "runs_per_case": 3,
    "weights": { "accuracy": 0.4, "latency": 0.25, "token_usage": 0.2, "safety": 0.15 },
    "evaluators": {}
  },
  "prompts": [
    {
      "id": "summarize_v1",
      "cases": [
        {
          "case_id": "case_short_news",
          "runs": [
            {
              "run_index": 0,
              "scores": { "accuracy": 0.82, "latency": 0.91, "token_usage": 0.78, "safety": 1.0, "composite": 0.86 },
              "raw": { "output_text": "• Key point...", "latency_ms": 430, "input_tokens": 210, "output_tokens": 45, "error": null }
            }
          ]
        }
      ],
      "summary": {
        "mean_scores": { "accuracy": 0.81, "latency": 0.88, "token_usage": 0.76, "safety": 1.0, "composite": 0.84 },
        "mean_latency_ms": 445,
        "mean_total_tokens": 260,
        "rank": 1
      }
    }
  ]
}
```

---

## 6. CLI Interface Contract

```
prompt-bench run <benchmark.yaml>             # execute benchmark
prompt-bench compare <result1.json> <result2.json>  # diff two results
prompt-bench report <result.json> --format table|json|markdown
```

Key flags for `run`:

| Flag | Default | Description |
|------|---------|-------------|
| `--api-endpoint` | env `PROMPT_BENCH_API` | Target LLM API URL |
| `--api-key` | env `PROMPT_BENCH_KEY` | API key |
| `--model` | `gpt-4o-mini` | Model identifier |
| `--runs` | `3` | Repetitions per case |
| `--output` | `stdout` | Output file path |
| `--weights` | defaults above | Override criterion weights |
| `--config` | none | Evaluator config file |

---

## 7. Extensibility

- **Custom criteria**: Add a new entry under `evaluators` config with a `type` field and a Python entry point (`module:class`). The class must implement `EvaluateResult score(str output, str reference, dict context)`.
- **Custom reporters**: `--format` can reference a Python entry point for bespoke output formats.
- **Multi-model**: A benchmark can declare a `models` list; the runner iterates models × prompts × cases.

---

## 8. File Structure Convention

```
prompt-bench/
├── prompts/           # Prompt template YAML files
├── benchmarks/        # Benchmark suite YAML files
├── data/              # Test input/reference data
├── results/           # Output JSON results
├── config/            # Evaluator configs, safety blocklists
└── src/
    ├── runner.py      # Orchestrates execution
    ├── scorer.py      # Implements scoring rubrics
    ├── reporter.py    # Formats output
    └── validators.py  # Template & schema validation
```