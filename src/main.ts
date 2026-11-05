#!/usr/bin/env node
import { parseArgs } from "node:util";

import { viewer } from "./server.ts";
import { TraceStore } from "./store.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4318" },
    host: { type: "string", default: "127.0.0.1" },
    "max-traces": { type: "string", default: "500" },
    "max-spans": { type: "string", default: "100000" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`usage: node src/main.ts [--port 4318] [--host 127.0.0.1] [--max-traces 500] [--max-spans 100000]

Point your app's OpenTelemetry exporter at it:
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
  OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
  process.exit(0);
}

const store = new TraceStore(Number(values["max-traces"]), Number(values["max-spans"]));
const server = viewer(store);
server.listen(Number(values.port), values.host, () => {
  console.log(`agent-trace-viewer on http://${values.host}:${values.port}`);
  console.log(`send traces with OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${values.port} OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
});
