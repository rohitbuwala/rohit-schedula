import type { Request, Response, NextFunction } from 'express';

export interface SecurityHeadersOptions {
  isProduction?: boolean;
}

export function createSecurityHeadersMiddleware(
  options?: SecurityHeadersOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const isProduction = options?.isProduction ?? process.env.NODE_ENV === 'production';

  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    res.removeHeader('X-Powered-By');
    next();
  };
}
