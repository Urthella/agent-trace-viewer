// Sends one made-up agent run to a viewer, through the real OpenTelemetry SDK and OTLP exporter.
//   node scripts/demo.ts [http://127.0.0.1:4318]

import { type Span, type Tracer, context, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";

/** A trip-planning agent: two model calls and two tool calls, one of which times out. */
export function emitAgentRun(tracer: Tracer, start = Date.now()): void {
  const at = (ms: number) => new Date(start + ms);
  const child = (parent: Span, name: string, from: number, attributes: Record<string, string | number>) =>
    tracer.startSpan(name, { startTime: at(from), attributes }, trace.setSpan(context.active(), parent));

  const agent = tracer.startSpan("invoke_agent trip-planner", {
    startTime: at(0),
    attributes: {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "trip-planner",
      "gen_ai.provider.name": "anthropic",
      // Totals for the whole run, which the model calls below also report.
      "gen_ai.usage.input_tokens": 1450,
      "gen_ai.usage.output_tokens": 310,
    },
  });
  const model = { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-sonnet-5-5" };
  child(agent, "chat claude-sonnet-5-5", 10, { ...model, "gen_ai.usage.input_tokens": 600, "gen_ai.usage.output_tokens": 120 }).end(at(1400));
  child(agent, "execute_tool search_flights", 1420, {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "search_flights",
    "gen_ai.tool.call.id": "call_1",
  }).end(at(2100));
  const weather = child(agent, "execute_tool get_weather", 1420, {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "get_weather",
    "gen_ai.tool.call.id": "call_2",
  });
  weather.setStatus({ code: 2, message: "timed out after 5 s" });
  weather.end(at(1900));
  child(agent, "chat claude-sonnet-5-5", 2120, { ...model, "gen_ai.usage.input_tokens": 850, "gen_ai.usage.output_tokens": 190 }).end(at(3900));
  agent.end(at(3950));
}

export function provider(url: string): TracerProvider {
  return new TracerProvider({
    resource: resourceFromAttributes({ "service.name": "travel-assistant" }),
    spanProcessors: [new SimpleSpanProcessor({ exporter: new OTLPTraceExporter({ url: `${url}/v1/traces` }) })],
  });
}

if (import.meta.main) {
  const url = process.argv[2] ?? "http://127.0.0.1:4318";
  const p = provider(url);
  emitAgentRun(p.getTracer("demo"));
  await p.shutdown();
  console.log(`sent one run to ${url}`);
}
