// src/utils/asyncHandler.js
// Envuelve handlers async de Express para que los errores lleguen al middleware.

export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default asyncHandler;
