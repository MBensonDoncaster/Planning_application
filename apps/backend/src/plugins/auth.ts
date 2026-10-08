import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config/env.js';
import type { Identity } from '../modules/users/types.js';
import { AppError } from '../modules/users/service.js';

export type VerifyIdentity = (token: string) => Promise<Identity>;

export function identityFromClaims(payload: JWTPayload, config: Config): Identity {
  const scope = config.ENTRA_SCOPE.split('/').at(-1)!;
  if (payload.ver !== '2.0' || payload.tid !== config.ENTRA_TENANT_ID ||
      typeof payload.oid !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.oid) ||
      payload.azp !== config.ENTRA_SPA_CLIENT_ID ||
      typeof payload.scp !== 'string' || !payload.scp.split(' ').includes(scope)) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'The access token is not valid for this application.');
  }
  const email = typeof payload.email === 'string' ? payload.email :
    typeof payload.preferred_username === 'string' ? payload.preferred_username : '';
  const name = typeof payload.name === 'string' ? payload.name : email || payload.oid;
  return { subject: `entra:${payload.tid}:${payload.oid}`, email: email.slice(0, 320), displayName: name.slice(0, 200) };
}

export function createIdentityVerifier(config: Config, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/discovery/v2.0/keys`))): VerifyIdentity {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer: `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/v2.0`,
        audience: config.ENTRA_API_CLIENT_ID,
        algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'nbf', 'tid', 'oid', 'azp', 'scp'],
      });
      return identityFromClaims(payload, config);
    } catch {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Sign in again to obtain a valid access token.');
    }
  };
}
