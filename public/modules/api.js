const DEFAULT_TIMEOUT_MS = 30_000;

class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.requestId = options.requestId || "";
    this.data = options.data || null;
  }
}

function timeoutSignal(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out.", "TimeoutError")), timeoutMs);
  return { controller, timer };
}

function mergeSignals(signalA, signalB) {
  if (!signalA) return { signal: signalB, cleanup() {} };
  if (!signalB) return { signal: signalA, cleanup() {} };
  const controller = new AbortController();
  const abort = event => {
    const source = event?.target;
    controller.abort(source?.reason || new DOMException("Request aborted.", "AbortError"));
  };
  if (signalA.aborted) abort({ target: signalA });
  else if (signalB.aborted) abort({ target: signalB });
  else {
    signalA.addEventListener("abort", abort, { once: true });
    signalB.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      signalA.removeEventListener("abort", abort);
      signalB.removeEventListener("abort", abort);
    }
  };
}

async function readResponseBody(res) {
  const contentType = res.headers.get("content-type") || "";
  if (res.status === 204) return {};
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    try {
      return await res.json();
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
      throw new ApiError("The server returned an invalid response.", { status: res.status });
    }
  }
  return { error: await res.text() };
}

let accessToken = "";
let sessionData = null;
let mutationChain = Promise.resolve();
const accessStorageKey = "local-amp-access";
if (globalThis.location?.hash) {
  const supplied = new URLSearchParams(globalThis.location.hash.slice(1)).get("local-amp");
  if (supplied && /^[a-f0-9]{64}$/.test(supplied)) {
    accessToken = supplied;
    try { globalThis.sessionStorage?.setItem(accessStorageKey, supplied); } catch { /* Memory-only session still works. */ }
    globalThis.history?.replaceState(null, "", globalThis.location.pathname + globalThis.location.search);
  }
}
function sessionToken() {
  if (!accessToken) { try { accessToken = globalThis.sessionStorage?.getItem(accessStorageKey) || ""; } catch { /* Storage may be disabled. */ } }
  if (!accessToken) throw new ApiError("Open Local Amp from its launcher to authorize this browser session.", { status: 403 });
  return accessToken;
}
export function metricsUrl() { return sessionData?.metricsUrl || "#"; }
export async function apiStream(path) {
  const data = await api("/api/access", {method:"POST",body:JSON.stringify({paths:[path]})});
  return new EventSource(data.urls[0]);
}
export async function apiDownload(path, name) {
  const response = await fetch(path, {headers:{"x-local-amp-token":sessionToken()},cache:"no-store",signal:AbortSignal.timeout(120000)});
  if (!response.ok) { const data=await readResponseBody(response); throw new ApiError(data.error || "Download failed.", {status:response.status}); }
  const url=URL.createObjectURL(await response.blob());
  const anchor=document.createElement("a"); anchor.href=url; anchor.download=name; anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function api(path, options = {}) {
  if (!options.method || ["GET", "HEAD"].includes(options.method.toUpperCase())) return request(path, options);
  if (!/^\/api\/(playlists|favorites|recent|backup|tracks)(\/|$)/.test(path)) return request(path, options);
  const result = mutationChain.then(() => request(path, options));
  mutationChain = result.catch(() => {});
  return result;
}
async function request(path, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    signal,
    ...fetchOptions
  } = options;

  const timeout = timeoutSignal(timeoutMs);
  const merged = mergeSignals(signal, timeout?.controller.signal);
  const requestHeaders = new Headers(headers);
  if (fetchOptions.body && !requestHeaders.has("Content-Type")) {
    requestHeaders.set("Content-Type", "application/json");
  }

  try {
    requestHeaders.set("x-local-amp-token", sessionToken());
    const res = await fetch(path, {
      ...fetchOptions,
      headers: requestHeaders,
      signal: merged.signal
    });
    const data = await readResponseBody(res);
    if (!res.ok) {
      throw new ApiError(data.detail || data.error || `Request failed (${res.status}).`, {
        status: res.status,
        requestId: data.requestId || res.headers.get("x-request-id") || "",
        data
      });
    }
    if (path === "/api/session") sessionData = data;
    return data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) {
      throw error;
    }
    if (timeout?.controller.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new ApiError("The request took too long. Please try again.");
    }
    throw new ApiError("Could not reach the Local Amp server. Restart it and try again.");
  } finally {
    merged.cleanup();
    if (timeout?.timer) clearTimeout(timeout.timer);
  }
}
