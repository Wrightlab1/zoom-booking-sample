import { AppError, ErrorCode } from '../errors.js';
import { config } from '../config.js';

/** Express 4 error middleware. Must keep all four parameters. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const isProd = config.server.env === 'production';

  if (err instanceof AppError) {
    // SLOT_TAKEN is an expected outcome, not a fault. Log it quietly.
    const level = err.code === ErrorCode.SLOT_TAKEN ? 'info' : 'error';
    console[level === 'info' ? 'log' : 'error'](
      `[${err.code}] ${req.method} ${req.originalUrl} → ${err.status}: ${err.detail ?? err.message}`
    );
    return res.status(err.status).json(err.toJSON({ includeDetail: !isProd }));
  }

  console.error(`[UNHANDLED] ${req.method} ${req.originalUrl}`, err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong.',
      ...(isProd ? {} : { detail: err?.message }),
    },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}` },
  });
}
