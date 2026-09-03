import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';

import type { SshEnrollmentInput } from '@/modules/fleet/services/ssh-easy-enroll.service.js';
import { SshEnrollmentError } from '@/modules/fleet/services/ssh-tunnel.service.js';

export type SshEnrollmentRouteService = Readonly<{
  enroll(input: SshEnrollmentInput): Promise<Readonly<{ peerId: string; port: number }>>;
  remove(peerId: string): Promise<void>;
}>;

function requestBody(value: unknown): SshEnrollmentInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SshEnrollmentError('INVALID_SSH_TARGET', 'SSH enrollment request is invalid');
  }
  const keys = Object.keys(value);
  const sshTarget = Reflect.get(value, 'sshTarget');
  const password = Reflect.get(value, 'password');
  const label = Reflect.get(value, 'label');
  if (!keys.includes('sshTarget') || !keys.every((key) => ['sshTarget', 'password', 'label'].includes(key))
    || typeof sshTarget !== 'string'
    || (password !== undefined && typeof password !== 'string')
    || (label !== undefined && (typeof label !== 'string' || label.trim().length === 0 || label.trim().length > 80))) {
    throw new SshEnrollmentError('INVALID_SSH_TARGET', 'SSH enrollment request is invalid');
  }
  return {
    sshTarget,
    ...(password === undefined ? {} : { password }),
    ...(label === undefined ? {} : { label: label.trim() }),
  };
}

function status(code: SshEnrollmentError['code']): number {
  switch (code) {
    case 'INVALID_SSH_TARGET': case 'MALFORMED_REQUEST': case 'SSH_PASSWORD_REQUIRED': return 400;
    case 'SSH_AUTH_FAILED': return 401;
    case 'HOSTKEY_REJECTED': case 'PEER_LIMIT_REACHED': return 409;
    case 'SSH_UNREACHABLE': case 'REMOTE_CLI_FAILED': case 'TOKEN_PARSE_FAILED':
    case 'ENROLL_FAILED': case 'TUNNEL_FAILED': return 502;
  }
}

function sendError(error: unknown, response: Response, next: NextFunction): void {
  if (error instanceof SshEnrollmentError) {
    response.status(status(error.code)).json({ error: { code: error.code, message: error.message } });
    return;
  }
  next(error);
}

export function registerSshEnrollmentRoute(
  router: Router,
  owner: RequestHandler,
  service: SshEnrollmentRouteService,
): void {
  const credentialJson = express.json({ limit: '64kb', type: 'application/json' });
  router.post(
    '/ssh-enroll',
    owner,
    credentialJson,
    (error: unknown, _request: Request, response: Response, next: NextFunction) => {
      if (typeof error === 'object' && error !== null && 'type' in error
        && typeof error.type === 'string' && error.type.startsWith('entity.')) {
        sendError(new SshEnrollmentError('MALFORMED_REQUEST', 'SSH enrollment request is malformed'), response, next);
        return;
      }
      next(error);
    },
    async (request: Request, response: Response, next: NextFunction) => {
      try { response.status(201).json(await service.enroll(requestBody(request.body))); }
      catch (error) { sendError(error, response, next); }
    },
  );
}
