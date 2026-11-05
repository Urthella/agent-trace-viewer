import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";

import { emitAgentRun, provider } from "../scripts/demo.ts";
import { describe, summarize } from "../src/genai.ts";
import { type Span, parseExport } from "../src/otlp.ts";
import { viewer } from "../src/server.ts";
import { TraceStore } from "../src/store.ts";

const TRACE = "5b8efff798038103d269b633813fc60c";
// Responses from the viewer's own API, which the tests check field by field.
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

/** One span in OTLP JSON, as the spec encodes it. */
function otlpSpan(spanId: string, parent: string, attributes: Record<string, string | number>, start = 0, end = 1000) {
  return {
    traceId: TRACE,
    spanId,
    parentSpanId: parent,
    name: `span ${spanId.slice(-2)}`,
    startTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(start) * 1_000_000n),
    endTimeUnixNano: String(1_700_000_000_000_000_000n + BigInt(end) * 1_000_000n),
    attributes: Object.entries(attributes).map(([key, v]) => ({
      key,
      value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v },
    })),
  };
}

const exportOf = (...spans: unknown[]) => ({
  resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] }, scopeSpans: [{ spans }] }],
});

test("OTLP JSON is read as the spec encodes it", () => {
  const [span] = parseExport({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE.toUpperCase(),
                spanId: "eee19b7ec3c1b174",
                parentSpanId: "",
                name: "chat",
                startTimeUnixNano: "1700000000123456789",
                endTimeUnixNano: 1700000001123456789,
                status: { code: 2, message: "boom" },
                attributes: [
                  { key: "s", value: { stringValue: "x" } },
                  { key: "i", value: { intValue: "42" } },
                  { key: "d", value: { doubleValue: 0.5 } },
                  { key: "b", value: { boolValue: true } },
                  { key: "a", value: { arrayValue: { values: [{ stringValue: "p" }, { intValue: 7 }] } } },
                  { key: "kv", value: { kvlistValue: { values: [{ key: "k", value: { stringValue: "v" } }] } } },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(span.traceId, TRACE);
  assert.equal(span.parentId, undefined);
  assert.equal(span.service, "svc");
  assert.equal(span.start, 1700000000123.456);
  assert.ok(Math.abs(span.end - 1700000001123.456) < 0.001);
  assert.equal(span.error, "boom");
  assert.deepEqual(span.attributes, { s: "x", i: 42, d: 0.5, b: true, a: ["p", 7], kv: { k: "v" } });
});

test("base64 IDs, from protobuf's default JSON mapping, are read too, and bad ones skipped", () => {
  const traceBase64 = Buffer.from(TRACE, "hex").toString("base64");
  const spans = parseExport(exportOf({ ...otlpSpan("eee19b7ec3c1b174", "", {}), traceId: traceBase64 }, { ...otlpSpan("x", "", {}), spanId: "nothex" }));
  assert.deepEqual(spans.map((s) => s.traceId), [TRACE]);
  assert.throws(() => parseExport({ resourceLogs: [] }), /no resourceSpans/);
});

const spans = (...raw: ReturnType<typeof otlpSpan>[]): Span[] => parseExport(exportOf(...raw));

test("an agent's own token totals aren't added on top of its model calls", () => {
  const calls = describe(
    spans(
      otlpSpan("a000000000000001", "", { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "planner", "gen_ai.usage.input_tokens": 150, "gen_ai.usage.output_tokens": 30 }),
      otlpSpan("a000000000000002", "a000000000000001", { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 }, 10, 400),
      otlpSpan("a000000000000003", "a000000000000001", { "gen_ai.operation.name": "chat", "gen_ai.usage.input_tokens": 50, "gen_ai.usage.output_tokens": 10 }, 500, 900),
    ),
  );
  const run = summarize(TRACE, calls);
  assert.deepEqual([run.inputTokens, run.outputTokens, run.modelCalls, run.name], [150, 30, 2, "planner"]);
});

test("without model call usage, only the outermost agents' totals count", () => {
  const calls = describe(
    spans(
      otlpSpan("b000000000000001", "", { "gen_ai.operation.name": "invoke_agent", "gen_ai.usage.input_tokens": 300, "gen_ai.usage.output_tokens": 60 }),
      otlpSpan("b000000000000002", "b000000000000001", { "gen_ai.operation.name": "invoke_agent", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 20 }),
      otlpSpan("b000000000000003", "b000000000000002", { "gen_ai.operation.name": "chat" }),
    ),
  );
  const run = summarize(TRACE, calls);
  assert.deepEqual([run.inputTokens, run.outputTokens], [300, 60]);
});

test("calls are a tree in time order, with orphans as roots and model and provider fallbacks", () => {
  const calls = describe(
    spans(
      otlpSpan("c000000000000001", "", { "gen_ai.operation.name": "invoke_agent" }, 0, 1000),
      otlpSpan("c000000000000003", "c000000000000001", { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "search" }, 300, 400),
      otlpSpan("c000000000000002", "c000000000000001", { "gen_ai.operation.name": "chat", "gen_ai.request.model": "asked", "gen_ai.response.model": "answered", "gen_ai.system": "openai" }, 100, 200),
      otlpSpan("c000000000000004", "ffffffffffffffff", { "gen_ai.operation.name": "embeddings" }, 1100, 1200),
      otlpSpan("c000000000000005", "", { other: "x" }, 500, 600),
    ),
  );
  assert.deepEqual(
    calls.map((c) => [c.spanId.slice(-1), c.depth, c.kind]),
    [["1", 0, "agent"], ["2", 1, "model"], ["3", 1, "tool"], ["5", 0, "other"], ["4", 0, "model"]],
  );
  const chat = calls[1];
  assert.deepEqual([chat.model, chat.provider, chat.offset, chat.duration], ["answered", "openai", 100, 100]);
  assert.equal(calls[2].tool, "search");
  assert.equal(summarize(TRACE, calls).duration, 1200);
});

test("the store keeps within its limits, dropping what went longest without a new span", () => {
  const store = new TraceStore(2, 5);
  const span = (trace: string, id: string): Span => ({ traceId: trace.repeat(32), spanId: id.repeat(16), name: "", service: "", start: 0, end: 1, attributes: {} });
  store.add([span("a", "1"), span("b", "1"), span("a", "2")]);
  store.add([span("a", "2")]); // a retried span
  assert.deepEqual(store.size, { traces: 2, spans: 3 });
  store.add([span("c", "1")]);
  assert.deepEqual(store.runs().map((r) => r.traceId[0]), ["c", "a"]);
  store.add([span("c", "2"), span("c", "3"), span("c", "4"), span("c", "5")]);
  assert.deepEqual(store.size, { traces: 1, spans: 5 });
  assert.equal(store.trace("a".repeat(32)), undefined);
});

async function start() {
  const server = viewer(new TraceStore());
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  after(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("the server takes JSON and gzip, and explains what it refuses", async () => {
  const url = await start();
  const post = (body: string | Uint8Array, headers: Record<string, string>) => fetch(`${url}/v1/traces`, { method: "POST", body, headers });
  const exported = JSON.stringify(exportOf(otlpSpan("d000000000000001", "", { "gen_ai.operation.name": "chat" })));

  const ok = await post(exported, { "content-type": "application/json" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await json(ok), {});
  assert.equal((await post(gzipSync(exported), { "content-type": "application/json", "content-encoding": "gzip" })).status, 200);

  const proto = await post(Buffer.from([0x0a, 0x00]), { "content-type": "application/x-protobuf" });
  assert.equal(proto.status, 415);
  assert.match((await json(proto)).message, /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
  assert.equal((await post("{not json", { "content-type": "application/json" })).status, 400);
  assert.equal((await post('{"resourceLogs": []}', { "content-type": "application/json" })).status, 400);
  assert.equal((await post(Buffer.alloc(17 << 20), { "content-type": "application/json" })).status, 413);

  const runs = await json(fetch(`${url}/api/traces`));
  assert.equal(runs.length, 1);
  assert.equal((await fetch(`${url}/api/traces/${"0".repeat(32)}`)).status, 404);
  const page = await fetch(url);
  assert.match(page.headers.get("content-type")!, /text\/html/);
  assert.match(await page.text(), /<title>Agent traces<\/title>/);
});

test("a run sent by the real OpenTelemetry SDK and exporter adds up", async () => {
  const url = await start();
  const p = provider(url);
  emitAgentRun(p.getTracer("test"), 1_800_000_000_000);
  await p.shutdown();

  const [run] = await json(fetch(`${url}/api/traces`));
  assert.equal(run.name, "trip-planner");
  assert.equal(run.service, "travel-assistant");
  // 600 + 850 from the model calls, not twice that with the agent's own totals.
  assert.deepEqual([run.inputTokens, run.outputTokens], [1450, 310]);
  assert.deepEqual([run.modelCalls, run.toolCalls, run.errors, run.spans], [2, 2, 1, 5]);
  assert.equal(run.duration, 3950);

  const { calls } = await json(fetch(`${url}/api/traces/${run.traceId}`));
  assert.deepEqual(
    calls.map((c: { kind: string; depth: number; tool?: string }) => [c.kind, c.depth, c.tool ?? ""]),
    [["agent", 0, ""], ["model", 1, ""], ["tool", 1, "search_flights"], ["tool", 1, "get_weather"], ["model", 1, ""]],
  );
  assert.equal(calls[3].error, "timed out after 5 s");
  // What the tool got and returned, read back from the JSON strings it was recorded as.
  assert.deepEqual(calls[2].contents, {
    "gen_ai.tool.call.arguments": { from: "IST", to: "LIS", date: "2026-12-03" },
    "gen_ai.tool.call.result": [{ flight: "TK1759", departs: "08:40", price: 212 }],
  });
  assert.deepEqual(calls[4].contents["gen_ai.response.finish_reasons"], ["stop"]);
  assert.equal(calls[4].contents["gen_ai.output.messages"][0].role, "assistant");
  assert.equal(calls[1].contents, undefined);
  assert.equal(calls[1].model, "claude-sonnet-5-5");
  assert.equal(calls[1].provider, "anthropic");
});

test("contents that aren't valid JSON are shown as they are", () => {
  const [call] = describe(
    spans(
      otlpSpan("e000000000000001", "", {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.call.arguments": "{not json",
        "gen_ai.tool.call.result": "plain text",
        "gen_ai.input.messages": '[{"role":"user"}]',
      }),
    ),
  );
  assert.deepEqual(call.contents, {
    "gen_ai.input.messages": [{ role: "user" }],
    "gen_ai.tool.call.arguments": "{not json",
    "gen_ai.tool.call.result": "plain text",
  });
});
