import type { NextFunction, Request, Response } from "express";

/** The window's page and its assets may load only the app's own scripts, styles, fonts and images
 * (plus data: and blob: images, blob: audio and the voice worklet), connect only to this API, and be
 * framed by nothing. No inline or evaluated script: injected markup (a model's answer, a page an agent
 * read) cannot run. Inline style attributes stay allowed: the UI sets widths and colours with them. */
export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "style-src-attr 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self'", "connect-src 'self'", "media-src 'self' blob:", "worker-src 'self'", "manifest-src 'none'", "object-src 'none'",
  "frame-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
].join("; ");

/** Set on the UI's responses (index.html and /assets), not on the API's. */
export const uiSecurityHeaders = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader("Content-Security-Policy", UI_CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
};
