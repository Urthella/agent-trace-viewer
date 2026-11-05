import { readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { gunzipSync } from "node:zlib";

import { parseExport } from "./otlp.ts";
import { TraceStore } from "./store.ts";

const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");
const MAX_BODY = 16 << 20;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Reads the body, unzipping it if needed. Past 16 MB it keeps reading but drops the data, so the
 * client finishes sending and gets the 413 instead of a reset connection.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      if (size > MAX_BODY) return reject(new HttpError(413, "the export is larger than 16 MB"));
      const body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] !== "gzip") return resolve(body);
      try {
        resolve(gunzipSync(body, { maxOutputLength: MAX_BODY }));
      } catch (e) {
        const tooBig = (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE";
        reject(tooBig ? new HttpError(413, "the export is larger than 16 MB unzipped") : new HttpError(400, "the gzip body is corrupt"));
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handle(store: TraceStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && pathname === "/v1/traces") {
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("application/json")) {
      // The collector's default is protobuf; this viewer reads only JSON.
      throw new HttpError(415, "send JSON: set OTEL_EXPORTER_OTLP_PROTOCOL=http/json in the app");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readBody(req)).toString("utf8"));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, "the body isn't JSON");
    }
    try {
      store.add(parseExport(parsed));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    // An empty ExportTraceServiceResponse means everything was accepted.
    return send(res, 200, {});
  }
  if (req.method === "GET" && pathname === "/") return send(res, 200, PAGE, "text/html; charset=utf-8");
  if (req.method === "GET" && pathname === "/api/traces") return send(res, 200, store.runs());
  const match = /^\/api\/traces\/([0-9a-f]{32})$/.exec(pathname);
  if (req.method === "GET" && match) {
    const trace = store.trace(match[1]);
    if (!trace) throw new HttpError(404, "no such trace; it may have been dropped to stay within the limits");
    return send(res, 200, trace);
  }
  throw new HttpError(404, "not found");
}

export function viewer(store = new TraceStore()): Server {
  return createServer((req, res) => {
    handle(store, req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : 500;
      // OTLP clients read errors from a google.rpc.Status-shaped body.
      send(res, status, { code: status, message: e instanceof Error ? e.message : String(e) });
    });
  });
}
