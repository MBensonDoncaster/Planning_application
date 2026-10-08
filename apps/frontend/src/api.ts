import type { PublicClientApplication } from '@azure/msal-browser';
import type { AuthConfig } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

let client: PublicClientApplication | undefined;
let config: AuthConfig;

export async function initializeAuth(): Promise<AuthConfig> {
  config = await request<AuthConfig>('/auth/config');
  if (config.mode === 'ENTRA') {
    const { PublicClientApplication } = await import('@azure/msal-browser');
    if (window.location.origin !== config.redirectUri) throw new Error('Open the application using its configured address.');
    client = new PublicClientApplication({
      auth: {
        clientId: config.clientId!, authority: `https://login.microsoftonline.com/${config.tenantId}`,
        redirectUri: config.redirectUri, postLogoutRedirectUri: config.redirectUri,
        navigateToLoginRequestUrl: true,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    await client.initialize();
    const result = await client.handleRedirectPromise();
    if (result) client.setActiveAccount(result.account);
    else if (!client.getActiveAccount()) client.setActiveAccount(client.getAllAccounts()[0] ?? null);
  }
  return config;
}

export function hasSession() { return config.mode === 'TEST_USER' || Boolean(client?.getActiveAccount()); }
export async function signIn() { await client?.loginRedirect({ scopes: [config.scope!] }); }
export async function signOut() { await client?.logoutRedirect({ account: client.getActiveAccount() }); }

async function accessToken(): Promise<string | undefined> {
  if (!client) return undefined;
  const account = client.getActiveAccount();
  if (!account) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  try {
    return (await client.acquireTokenSilent({ account, scopes: [config.scope!] })).accessToken;
  } catch (error) {
    const { InteractionRequiredAuthError } = await import('@azure/msal-browser');
    if (error instanceof InteractionRequiredAuthError) {
      await client.acquireTokenRedirect({ account, scopes: [config.scope!] });
    }
    throw error;
  }
}

export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const token = path === '/auth/config' ? undefined : await accessToken();
  const response = await fetch(`/api/v1${path}`, {
    method: options.method ?? 'GET', signal: options.signal,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { code?: string; message?: string };
    throw new ApiError(response.status, error.code ?? 'REQUEST_FAILED', error.message ?? 'The request could not be completed.');
  }
  return response.json() as Promise<T>;
}
