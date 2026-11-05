// Reads OTLP/HTTP JSON trace exports, the body of POST /v1/traces with Content-Type
// application/json (https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding).

export interface Span {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  service: string;
  /** Milliseconds since the epoch. */
  start: number;
  end: number;
  attributes: Record<string, unknown>;
  /** The status message, when the span's status is an error. */
  error?: string;
}

interface AnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  bytesValue?: string;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
}

interface KeyValue {
  key: string;
  value?: AnyValue;
}

function value(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  // int64 is a string in proto3 JSON, though some exporters send a number.
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(value);
  if (v.kvlistValue) return attributes(v.kvlistValue.values);
  return v.bytesValue;
}

function attributes(kvs: KeyValue[] = []): Record<string, unknown> {
  return Object.fromEntries(kvs.map((kv) => [kv.key, value(kv.value)]));
}

/**
 * Trace and span IDs are hex in OTLP JSON. Some exporters use protobuf's default JSON mapping
 * instead, which is base64, so that's accepted too.
 */
function id(raw: unknown, bytes: number): string | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(raw)) return raw.toLowerCase();
  const decoded = Buffer.from(raw, "base64");
  return decoded.length === bytes ? decoded.toString("hex") : undefined;
}

function millis(nanos: unknown): number {
  if (typeof nanos !== "string" && typeof nanos !== "number") return 0;
  return Number(BigInt(nanos) / 1000n) / 1000;
}

const STATUS_ERROR = new Set<unknown>([2, "STATUS_CODE_ERROR"]);

/** The spans in an export. Spans without valid trace and span IDs are skipped. */
export function parseExport(body: unknown): Span[] {
  const resourceSpans = (body as { resourceSpans?: unknown })?.resourceSpans;
  if (!Array.isArray(resourceSpans)) throw new Error("not an OTLP trace export: there's no resourceSpans array");
  const spans: Span[] = [];
  for (const rs of resourceSpans) {
    const service = String(attributes(rs.resource?.attributes)["service.name"] ?? "unknown");
    for (const ss of rs.scopeSpans ?? []) {
      for (const s of ss.spans ?? []) {
        const traceId = id(s.traceId, 16);
        const spanId = id(s.spanId, 8);
        if (!traceId || !spanId) continue;
        spans.push({
          traceId,
          spanId,
          parentId: id(s.parentSpanId, 8),
          name: String(s.name ?? ""),
          service,
          start: millis(s.startTimeUnixNano),
          end: millis(s.endTimeUnixNano),
          attributes: attributes(s.attributes),
          error: STATUS_ERROR.has(s.status?.code) ? s.status?.message || "error" : undefined,
        });
      }
    }
  }
  return spans;
}
