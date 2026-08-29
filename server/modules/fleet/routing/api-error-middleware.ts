import type { ErrorRequestHandler } from 'express';

import { AppError } from '@/shared/utils.js';

export function createApiErrorMiddleware(
  report: (error: unknown) => void = console.error,
): ErrorRequestHandler {
  return (error, _request, response, _next) => {
    if (error instanceof AppError) {
      response.status(error.statusCode).json({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
      return;
    }

    report(error);
    response.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    });
  };
}
