/**
 * Warm-process server for mpg.
 *
 * Eliminates the ~1.1 s Node cold-start cost for agent harnesses that
 * call mpg repeatedly. Supports two modes:
 *
 *   stdio  — newline-delimited JSON (NDJSON) over stdin/stdout.
 *            Each stdin line: { id, method, params }
 *            Each stdout line: { id, result } | { id, error: { code, message } }
 *
 *   http   — tiny node:http server on a configurable port.
 *            POST /          { method, params } → { result } | { error }
 *            GET  /health    → { ok: true, version, palace_path }
 *
 * Methods exposed (all delegate to api.ts / mind-palace.ts):
 *   search, health, tool_spec,
 *   palace.list, palace.get, palace.stash, palace.drop,
 *   palace.compose, palace.intersect, palace.except,
 *   palace.link, palace.graph,
 *   palace.prune_expired, palace.prune_tag,
 *   palace.prune_older_than, palace.prune_keep
 *
 * No new runtime deps. Only node built-ins.
 */

// ─── NOTE: api.ts missing exports ────────────────────────────────────
//
// The following palace operations are NOT exported from api.ts:
//   addRelation, removeRelation, traversalGraph,
//   pruneExpired, pruneOlderThan, pruneKeep, pruneTag,
//   composeToSources, exceptToSources, intersectToSources
//
// We import them directly from mind-palace.ts (a lower-level building
// block), wrap palace load/save around them, and dispatch here.
// No api.ts modification required.

import * as http from "node:http";
import * as readline from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import {
  search,
  stash as apiStash,
  listStashes as apiListStashes,
  getStash as apiGetStash,
  dropStash as apiDropStash,
} from "./api.js";

import {
  defaultPalacePath,
  loadPalace,
  savePalace,
  composeToSources,
  exceptToSources,
  intersectToSources,
  addRelation,
  traversalGraph,
  pruneExpired,
  pruneOlderThan,
  pruneKeep,
  pruneTag,
} from "./mind-palace.js";

import { buildToolSpec } from "./tool-spec.js";

// ─── Version ──────────────────────────────────────────────────────────

// Use createRequire to read package.json in ESM context.
const _require = createRequire(import.meta.url);
const _pkgPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../package.json",
);
const _pkg = _require(_pkgPath) as { version: string };
const VERSION: string = _pkg.version;

// ─── Logging ──────────────────────────────────────────────────────────

const DEBUG = process.env.MPG_DEBUG === "1";
function dbg(method: string, ms: number): void {
  if (DEBUG) process.stderr.write(`[mpg-server] ${method} ${ms}ms\n`);
}

// ─── Dispatch ─────────────────────────────────────────────────────────

type ErrorCode = "BAD_PARAMS" | "INTERNAL" | "UNKNOWN_METHOD" | "NOT_IMPLEMENTED";

interface ServerError {
  code: ErrorCode;
  message: string;
}

// Params are arbitrary JSON objects coming in over the wire.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = Record<string, any>;

async function dispatch(method: string, params: Params): Promise<unknown> {
  switch (method) {

    // ── Core search ────────────────────────────────────────────────
    case "search": {
      if (typeof params.pattern !== "string") {
        throw mkErr("BAD_PARAMS", "search: params.pattern (string) is required");
      }
      return search({
        pattern: params.pattern,
        in: asStringArray(params.in),
        cmd: asStringOrUndef(params.cmd),
        url: asStringOrUndef(params.url),
        stdin: params.stdin === true,
        before: asNumberOrUndef(params.before),
        after: asNumberOrUndef(params.after),
        maxNodes: asNumberOrUndef(params.max_nodes),
        maxTokens: asNumberOrUndef(params.max_tokens),
        effort: params.effort,
        strategy: params.strategy,
        from: asStringOrUndef(params.mp_from ?? params.from),
        compose: asStringArray(params.mp_compose ?? params.compose),
        palacePath: asStringOrUndef(params.palace_path),
        page: asNumberOrUndef(params.page),
        pageSize: asNumberOrUndef(params.page_size),
        all: params.all === true,
        sort: params.sort,
        windowCurve: params.window_curve,
        clipChars: asNumberOrUndef(params.clip_chars),
        fuzzy: params.fuzzy === true,
        noAutoTune: params.no_auto_tune === true,
      });
    }

    // ── Health ─────────────────────────────────────────────────────
    case "health": {
      return { ok: true, version: VERSION, palace_path: defaultPalacePath() };
    }

    // ── Tool spec ──────────────────────────────────────────────────
    case "tool_spec": {
      const fmt = params.format ?? "anthropic";
      if (fmt !== "openai" && fmt !== "anthropic" && fmt !== "gemini") {
        throw mkErr("BAD_PARAMS", `tool_spec: format must be openai|anthropic|gemini, got ${fmt}`);
      }
      return buildToolSpec(fmt);
    }

    // ── Palace: list ───────────────────────────────────────────────
    case "palace.list": {
      const tags = asStringArray(params.tag_filter ?? params.tags);
      return apiListStashes(
        asStringOrUndef(params.palace_path),
        tags.length > 0 ? tags : undefined,
      );
    }

    // ── Palace: get ────────────────────────────────────────────────
    case "palace.get": {
      if (typeof params.name !== "string") {
        throw mkErr("BAD_PARAMS", "palace.get: params.name (string) is required");
      }
      const s = apiGetStash(params.name, asStringOrUndef(params.palace_path));
      if (!s) return null;
      if (params.with_nodes === true) return s;
      // Card view: omit node bodies.
      const { nodes: _n, ...card } = s as typeof s & { nodes?: unknown };
      return card;
    }

    // ── Palace: stash ──────────────────────────────────────────────
    case "palace.stash": {
      if (typeof params.name !== "string") {
        throw mkErr("BAD_PARAMS", "palace.stash: params.name (string) is required");
      }
      if (typeof params.note !== "string") {
        throw mkErr("BAD_PARAMS", "palace.stash: params.note (string) is required");
      }
      // Allow passing nodes directly or a SearchResult.
      const nodes = params.nodes ?? [];
      return apiStash(Array.isArray(nodes) ? nodes : [], {
        name: params.name,
        note: params.note,
        tags: asStringArray(params.tags),
        replace: params.replace === true,
        palacePath: asStringOrUndef(params.palace_path),
        ttl: asStringOrUndef(params.ttl),
        locations: params.locations === true,
      });
    }

    // ── Palace: drop ───────────────────────────────────────────────
    case "palace.drop": {
      if (typeof params.name !== "string") {
        throw mkErr("BAD_PARAMS", "palace.drop: params.name (string) is required");
      }
      const ok = apiDropStash(params.name, asStringOrUndef(params.palace_path));
      return { dropped: ok };
    }

    // ── Palace: compose ────────────────────────────────────────────
    case "palace.compose": {
      const names = asStringArray(params.names);
      if (names.length === 0) {
        throw mkErr("BAD_PARAMS", "palace.compose: params.names (string[]) is required");
      }
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      return composeToSources(palace, names).map((s) => s.id);
    }

    // ── Palace: intersect ──────────────────────────────────────────
    case "palace.intersect": {
      const names = asStringArray(params.names);
      if (names.length === 0) {
        throw mkErr("BAD_PARAMS", "palace.intersect: params.names (string[]) is required");
      }
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      return intersectToSources(palace, names).map((s) => s.id);
    }

    // ── Palace: except ─────────────────────────────────────────────
    case "palace.except": {
      if (typeof params.base !== "string") {
        throw mkErr("BAD_PARAMS", "palace.except: params.base (string) is required");
      }
      const exclude = asStringArray(params.exclude);
      if (exclude.length === 0) {
        throw mkErr("BAD_PARAMS", "palace.except: params.exclude (string[]) is required");
      }
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      return exceptToSources(palace, params.base, exclude).map((s) => s.id);
    }

    // ── Palace: link ───────────────────────────────────────────────
    case "palace.link": {
      const { from: fromName, to: toName, type: relType, note: relNote } = params;
      if (typeof fromName !== "string" || typeof toName !== "string" || typeof relType !== "string") {
        throw mkErr("BAD_PARAMS", "palace.link: from, to, type (string) are required");
      }
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      addRelation(palace, fromName, toName, relType, asStringOrUndef(relNote) ?? "");
      savePalace(pp, palace);
      return { linked: true, from: fromName, to: toName, type: relType };
    }

    // ── Palace: graph ──────────────────────────────────────────────
    case "palace.graph": {
      if (typeof params.name !== "string") {
        throw mkErr("BAD_PARAMS", "palace.graph: params.name (string) is required");
      }
      const depth = asNumberOrUndef(params.depth) ?? 3;
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      return traversalGraph(palace, params.name, depth);
    }

    // ── Palace: prune_expired ──────────────────────────────────────
    case "palace.prune_expired": {
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      const dryRun = params.dry_run === true;
      const result = pruneExpired(palace, dryRun);
      if (!dryRun) savePalace(pp, palace);
      return result;
    }

    // ── Palace: prune_tag ──────────────────────────────────────────
    case "palace.prune_tag": {
      if (typeof params.tag !== "string") {
        throw mkErr("BAD_PARAMS", "palace.prune_tag: params.tag (string) is required");
      }
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      const dryRun = params.dry_run === true;
      const result = pruneTag(palace, params.tag, dryRun);
      if (!dryRun) savePalace(pp, palace);
      return result;
    }

    // ── Palace: prune_older_than ───────────────────────────────────
    case "palace.prune_older_than": {
      if (typeof params.duration !== "string") {
        throw mkErr("BAD_PARAMS", "palace.prune_older_than: params.duration (string) is required, e.g. '24h'");
      }
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      const dryRun = params.dry_run === true;
      const result = pruneOlderThan(palace, params.duration, dryRun);
      if (!dryRun) savePalace(pp, palace);
      return result;
    }

    // ── Palace: prune_keep ─────────────────────────────────────────
    case "palace.prune_keep": {
      if (typeof params.n !== "number") {
        throw mkErr("BAD_PARAMS", "palace.prune_keep: params.n (number) is required");
      }
      const pp = asStringOrUndef(params.palace_path) ?? defaultPalacePath();
      const palace = loadPalace(pp);
      const dryRun = params.dry_run === true;
      const result = pruneKeep(palace, params.n, dryRun);
      if (!dryRun) savePalace(pp, palace);
      return result;
    }

    default:
      throw mkErr("UNKNOWN_METHOD", `Unknown method: ${method}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function mkErr(code: ErrorCode, message: string): { __isServerError: true; code: ErrorCode; message: string } {
  return { __isServerError: true, code, message };
}

function isServerError(e: unknown): e is ServerError & { __isServerError: true } {
  return typeof e === "object" && e !== null && "__isServerError" in e;
}

function asStringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

async function safeDispatch(
  method: string,
  params: Params,
): Promise<{ result: unknown } | { error: ServerError }> {
  const t0 = Date.now();
  try {
    const result = await dispatch(method, params);
    dbg(method, Date.now() - t0);
    return { result };
  } catch (err) {
    dbg(`${method} ERR`, Date.now() - t0);
    if (isServerError(err)) {
      return { error: { code: err.code, message: err.message } };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { error: { code: "INTERNAL", message: msg } };
  }
}

// ─── Stdio server (NDJSON) ────────────────────────────────────────────

export async function startStdioServer(opts?: { onReady?: () => void }): Promise<void> {
  opts?.onReady?.();

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Process requests strictly sequentially.
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let req: { id?: unknown; method?: unknown; params?: unknown };
    try {
      req = JSON.parse(trimmed) as typeof req;
    } catch {
      // Malformed line — emit a parse error with null id.
      const resp = { id: null, error: { code: "BAD_PARAMS" as ErrorCode, message: "JSON parse error" } };
      process.stdout.write(JSON.stringify(resp) + "\n");
      continue;
    }

    const id = req.id ?? null;
    const method = typeof req.method === "string" ? req.method : null;
    const params = (typeof req.params === "object" && req.params !== null && !Array.isArray(req.params))
      ? (req.params as Params)
      : {};

    if (!method) {
      const resp = { id, error: { code: "BAD_PARAMS" as ErrorCode, message: "method (string) is required" } };
      process.stdout.write(JSON.stringify(resp) + "\n");
      continue;
    }

    const out = await safeDispatch(method, params);
    const resp = "error" in out
      ? { id, error: out.error }
      : { id, result: out.result };
    process.stdout.write(JSON.stringify(resp) + "\n");
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────

export async function startHttpServer(opts: {
  port: number;
  host?: string;
}): Promise<{ close: () => Promise<void>; port: number }> {
  const host = opts.host ?? "127.0.0.1";

  const server = http.createServer((req, res) => {
    void handleHttp(req, res);
  });

  async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method === "GET" && req.url === "/health") {
        const body = JSON.stringify({ ok: true, version: VERSION, palace_path: defaultPalacePath() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }

      if (req.method !== "POST" || req.url !== "/") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "UNKNOWN_METHOD", message: "Not found. Use POST /" } }));
        return;
      }

      // Read body.
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");

      let body: { method?: unknown; params?: unknown };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "BAD_PARAMS", message: "JSON parse error" } }));
        return;
      }

      const method = typeof body.method === "string" ? body.method : null;
      if (!method) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "BAD_PARAMS", message: "method (string) is required" } }));
        return;
      }

      const params = (typeof body.params === "object" && body.params !== null && !Array.isArray(body.params))
        ? (body.params as Params)
        : {};

      const out = await safeDispatch(method, params);
      const statusCode = "error" in out && out.error.code === "UNKNOWN_METHOD" ? 404 : 200;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "INTERNAL", message: msg } }));
      } catch { /* headers already sent */ }
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;
  if (DEBUG) process.stderr.write(`[mpg-server] HTTP listening on ${host}:${actualPort}\n`);

  // Graceful shutdown.
  function shutdown(): void {
    server.close();
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        process.removeListener("SIGINT", shutdown);
        process.removeListener("SIGTERM", shutdown);
        server.close(() => resolve());
      }),
  };
}
