class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.expose = statusCode < 500;
    if (options.detail) this.detail = String(options.detail).slice(0, 2000);
    if (options.cause) this.cause = options.cause;
  }
}

function httpError(statusCode, message, options) {
  return new HttpError(statusCode, message, options);
}

function asyncHandler(handler) {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

function requireString(value, label, options = {}) {
  const {
    minLength = 1,
    maxLength = 4096,
    trim = true
  } = options;

  if (typeof value !== 'string') {
    throw httpError(400, `${label} must be a string.`);
  }

  const nextValue = trim ? value.trim() : value;
  if (nextValue.length < minLength) {
    throw httpError(400, `${label} is required.`);
  }
  if (nextValue.length > maxLength) {
    throw httpError(400, `${label} is too long.`);
  }

  return nextValue;
}

function optionalString(value, fallback, label, options = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  return requireString(value, label, options);
}

function routeId(value, label = 'Id') {
  const id = requireString(value, label, { maxLength: 200 });
  if (!/^[a-zA-Z0-9._:-]+$/.test(id)) {
    throw httpError(400, `${label} contains invalid characters.`);
  }
  return id;
}

module.exports = {
  HttpError,
  httpError,
  asyncHandler,
  optionalString,
  requireString,
  routeId
};
