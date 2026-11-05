import { type Call, type Run, describe, summarize } from "./genai.ts";
import type { Span } from "./otlp.ts";

/**
 * Keeps recent traces in memory, within fixed limits, so a busy app can't make the viewer grow
 * without bound. When a limit is passed, the traces that went longest without a new span go first.
 */
export class TraceStore {
  private traces = new Map<string, Map<string, Span>>();
  private spanCount = 0;
  readonly maxTraces: number;
  readonly maxSpans: number;

  constructor(maxTraces = 500, maxSpans = 100_000) {
    this.maxTraces = maxTraces;
    this.maxSpans = maxSpans;
  }

  add(spans: Span[]): void {
    for (const span of spans) {
      const trace = this.traces.get(span.traceId) ?? new Map<string, Span>();
      // Exporters retry, so the same span can arrive twice.
      if (!trace.has(span.spanId)) this.spanCount++;
      trace.set(span.spanId, span);
      // Re-inserting moves the trace to the end, the most recently updated.
      this.traces.delete(span.traceId);
      this.traces.set(span.traceId, trace);
    }
    for (const [id, trace] of this.traces) {
      if (this.traces.size <= this.maxTraces && this.spanCount <= this.maxSpans) break;
      this.traces.delete(id);
      this.spanCount -= trace.size;
    }
  }

  get size(): { traces: number; spans: number } {
    return { traces: this.traces.size, spans: this.spanCount };
  }

  /** Newest first. */
  runs(): Run[] {
    return [...this.traces].reverse().map(([id, trace]) => this.run(id, [...trace.values()]).run);
  }

  trace(id: string): { run: Run; calls: Call[] } | undefined {
    const trace = this.traces.get(id);
    return trace && this.run(id, [...trace.values()]);
  }

  private run(id: string, spans: Span[]): { run: Run; calls: Call[] } {
    const calls = describe(spans);
    return { run: { ...summarize(id, calls), start: Math.min(...spans.map((s) => s.start)) }, calls };
  }
}
