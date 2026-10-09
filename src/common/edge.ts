import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from '../config/config';

/*
 * The API is meant to be reached through a reverse proxy (TLS, the visitor's real address). Its own
 * address is public too, so with EDGE_SECRET set it refuses whatever didn't come through the proxy:
 * otherwise the rate limits, which count by visitor address, could be dodged by going around it.
 */

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/** True when no secret is configured, or the request carries it. */
export function fromEdge(config: Pick<Config, 'EDGE_SECRET'>, headers: IncomingHttpHeaders): boolean {
  if (!config.EDGE_SECRET) return true;
  const sent = headers['x-edge-secret'];
  // Compared as digests: equal length, so the comparison takes the same time whatever was sent.
  return typeof sent === 'string' && timingSafeEqual(digest(sent), digest(config.EDGE_SECRET));
}

/** Refuses requests that didn't come through the proxy, and takes the visitor's address from it. */
export function edgeOnly(config: Config) {
  const header = config.CLIENT_IP_HEADER?.toLowerCase();
  return (req: Request, res: Response, next: NextFunction): void => {
    // The platform's health checks reach the container directly.
    if (!req.path.startsWith('/health/') && !fromEdge(config, req.headers)) {
      res.status(404).type('application/problem+json').json({ type: 'about:blank', title: 'Not found', status: 404, instance: req.originalUrl });
      return;
    }
    const address = header ? req.headers[header] : undefined;
    if (typeof address === 'string' && address) Object.defineProperty(req, 'ip', { value: address, configurable: true });
    next();
  };
}
