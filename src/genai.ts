// What the OpenTelemetry GenAI conventions say about a span: an agent run, a model call or a tool
// call, and with which model, tool and token counts. The attribute names follow
// open-telemetry/semantic-conventions-genai, which is still marked as in development.

import type { Span } from "./otlp.ts";

export type Kind = "agent" | "model" | "tool" | "other";

const AGENT = new Set(["invoke_agent", "create_agent", "invoke_workflow", "invoke_runner"]);
const MODEL = new Set(["chat", "generate_content", "text_completion", "realtime_inference", "embeddings"]);

export function kindOf(span: Span): Kind {
  const op = span.attributes["gen_ai.operation.name"];
  if (op === "execute_tool") return "tool";
  if (AGENT.has(op as string)) return "agent";
  if (MODEL.has(op as string)) return "model";
  return "other";
}

export interface Call {
  spanId: string;
  parentId?: string;
  kind: Kind;
  name: string;
  service: string;
  /** How far below the run's root, for drawing the tree. */
  depth: number;
  /** Milliseconds after the run started. */
  offset: number;
  duration: number;
  operation?: string;
  model?: string;
  provider?: string;
  agent?: string;
  tool?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  /** What the call sent and got back, when the instrumentation records it. */
  contents?: Record<string, unknown>;
}

/**
 * Attributes with a call's contents. Instrumentations record these only when told to capture
 * content, since they can hold anything a user typed. They're often JSON in a string.
 */
const CONTENTS = [
  "gen_ai.system_instructions",
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai.response.finish_reasons",
];

function contentsOf(attributes: Record<string, unknown>): Record<string, unknown> | undefined {
  const found = CONTENTS.filter((key) => attributes[key] !== undefined).map((key) => {
    const value = attributes[key];
    if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return [key, value];
    try {
      return [key, JSON.parse(value)];
    } catch {
      return [key, value];
    }
  });
  return found.length > 0 ? Object.fromEntries(found) : undefined;
}

export interface Run {
  traceId: string;
  name: string;
  service: string;
  start: number;
  duration: number;
  spans: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
}

const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The spans of one trace, in order, parents before children. */
export function describe(spans: Span[]): Call[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string | undefined, Span[]>();
  for (const s of spans) {
    // A span whose parent never arrived is shown as a root, not dropped.
    const parent = s.parentId && byId.has(s.parentId) ? s.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const start = Math.min(...spans.map((s) => s.start));
  const calls: Call[] = [];
  const visit = (parent: string | undefined, depth: number) => {
    for (const s of (children.get(parent) ?? []).sort((a, b) => a.start - b.start)) {
      const a = s.attributes;
      calls.push({
        spanId: s.spanId,
        parentId: parent,
        kind: kindOf(s),
        name: s.name,
        service: s.service,
        depth,
        offset: s.start - start,
        duration: s.end - s.start,
        operation: text(a["gen_ai.operation.name"]),
        model: text(a["gen_ai.response.model"]) ?? text(a["gen_ai.request.model"]),
        // gen_ai.system was the name before gen_ai.provider.name, and older instrumentations still send it.
        provider: text(a["gen_ai.provider.name"]) ?? text(a["gen_ai.system"]),
        agent: text(a["gen_ai.agent.name"]),
        tool: text(a["gen_ai.tool.name"]),
        inputTokens: count(a["gen_ai.usage.input_tokens"]),
        outputTokens: count(a["gen_ai.usage.output_tokens"]),
        error: s.error,
        contents: contentsOf(a),
      });
      visit(s.spanId, depth + 1);
    }
  };
  visit(undefined, 0);
  return calls;
}

/**
 * Adds up a run. Tokens come from the model calls. An agent span may also report usage for its
 * whole run, so adding everything up would count those tokens twice: agent totals are used only
 * when no model call reports any, and then only from agents that aren't inside another agent.
 */
export function summarize(traceId: string, calls: Call[]): Run {
  const models = calls.filter((c) => c.kind === "model");
  const reported = models.filter((c) => c.inputTokens !== undefined || c.outputTokens !== undefined);
  const agentAbove = new Set<string>();
  for (const c of calls) {
    const parent = c.parentId === undefined ? undefined : calls.find((p) => p.spanId === c.parentId);
    if (parent && (parent.kind === "agent" || agentAbove.has(parent.spanId))) agentAbove.add(c.spanId);
  }
  const usage = reported.length > 0 ? reported : calls.filter((c) => c.kind === "agent" && !agentAbove.has(c.spanId));
  const sum = (pick: (c: Call) => number | undefined) => usage.reduce((total, c) => total + (pick(c) ?? 0), 0);
  const root = calls[0];
  return {
    traceId,
    name: root?.agent ?? root?.name ?? "",
    service: root?.service ?? "",
    start: 0,
    duration: Math.max(0, ...calls.map((c) => c.offset + c.duration)),
    spans: calls.length,
    modelCalls: models.length,
    toolCalls: calls.filter((c) => c.kind === "tool").length,
    inputTokens: sum((c) => c.inputTokens),
    outputTokens: sum((c) => c.outputTokens),
    errors: calls.filter((c) => c.error !== undefined).length,
  };
}
