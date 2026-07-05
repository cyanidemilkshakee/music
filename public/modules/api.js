const DEFAULT_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status || 0;
    this.requestId = options.requestId || "";
  }
}

function timeoutSignal(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("Request timed out.", "TimeoutError")), timeoutMs);
  return { controller, timer };
}

function mergeSignals(signalA, signalB) {
  if (!signalA) return signalB;
  if (!signalB) return signalA;
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
  return controller.signal;
}

async function readResponseBody(res) {
  const contentType = res.headers.get("content-type") || "";
  if (res.status === 204) return {};
  if (contentType.includes("application/json")) {
    return res.json().catch(() => ({}));
  }
  return { error: await res.text().catch(() => "") };
}

export async function api(path, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    signal,
    ...fetchOptions
  } = options;

  const timeout = timeoutSignal(timeoutMs);
  const requestHeaders = { ...headers };
  if (fetchOptions.body && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }

  let res;
  try {
    res = await fetch(path, {
      ...fetchOptions,
      headers: requestHeaders,
      signal: mergeSignals(signal, timeout?.controller.signal)
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new ApiError("The request took too long. Please try again.");
    }
    throw new ApiError("Could not reach the Local Amp server. Is it running on port 1111?");
  } finally {
    if (timeout?.timer) clearTimeout(timeout.timer);
  }

  const data = await readResponseBody(res);
  if (!res.ok) {
    throw new ApiError(data.detail || data.error || `Request failed (${res.status}).`, {
      status: res.status,
      requestId: data.requestId || res.headers.get("x-request-id") || ""
    });
  }
  return data;
}
