/**
 * Route errors the webview translates (TODO #829, docs/I18N.md, section on
 * API errors). The body shape lives in the plugin contract so plugins answer the
 * same way; this module adds the Express side.
 *
 * Every `apiError('code', …)` written with a literal code needs the key
 * `apiErrors.<code>` in `app/src/locales/en/apiErrors.json`, with the same
 * params: `app/src/lib/api-error-codes.test.ts` reads this tree to check it.
 */
import type { Response } from 'express';
import { apiError, type ApiErrorBody } from './plugins/contract/api-error.js';

export { apiError, API_ERROR_CODE, type ApiErrorBody, type ApiErrorParams } from './plugins/contract/api-error.js';

/** `sendApiError(res, 404, 'mission_not_found', 'mission not found')`. */
export function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  params?: Record<string, unknown>,
): Response<ApiErrorBody> {
  return res.status(status).json(apiError(code, message, params));
}
