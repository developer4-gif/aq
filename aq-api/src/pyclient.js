/* Thin client for the Python notes service (the AI/media worker). Only fixed, validated paths are ever requested. */
import { HttpError } from "./http.js";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function assertPyUrl(url, allowRemote = false) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`PY_NOTES_URL is not a valid URL: ${url}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("PY_NOTES_URL must be http(s).");
  if (!allowRemote && !LOOPBACK.has(u.hostname)) throw new Error("PY_NOTES_URL must point to this machine (set ALLOW_REMOTE_PY=1 to override).");
}

export function createPyClient({ baseUrl, timeoutMs = 10_000, fetchImpl = fetch }) {
  /** -> {status, headers, json} (json = null when the body is not JSON). Throws HttpError 503 when the service is unreachable. */
  async function json(path, { method = "GET", body, timeout = timeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(baseUrl + path, {
        method, redirect: "error", signal: AbortSignal.timeout(timeout),
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw offline(e);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, json: data };
  }
  /** Raw response (body not consumed) for streaming files through. */
  async function raw(path, { method = "GET", timeout = 30_000 } = {}) {
    try {
      return await fetchImpl(baseUrl + path, { method, redirect: "error", signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw offline(e);
    }
  }
  return { json, raw };
}

function offline(e) {
  const timeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
  return new HttpError(503, timeout ? "The notes service took too long to answer." : "The notes service is not running. Start it (start.ps1) and try again.", { code: "py_offline" });
}
