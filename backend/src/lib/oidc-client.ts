import * as client from 'openid-client';

// Discovered once at startup against OIDC_ISSUER_URL (Entra today, any
// spec-compliant provider later — see CLAUDE.md "Auth"). No provider-
// specific endpoints are hardcoded; discovery() reads the issuer's
// .well-known/openid-configuration for authorize/token/JWKS URLs.
let config: client.Configuration | undefined;

export async function initOidcClient(): Promise<void> {
  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;

  if (!issuerUrl || !clientId || !clientSecret) {
    throw new Error('OIDC_ISSUER_URL, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET must all be set');
  }

  config = await client.discovery(new URL(issuerUrl), clientId, clientSecret);
}

export function getOidcClient(): client.Configuration | undefined {
  return config;
}

export function getOidcRedirectUri(): string {
  const redirectUri = process.env.OIDC_REDIRECT_URI;
  if (!redirectUri) throw new Error('OIDC_REDIRECT_URI must be set');
  return redirectUri;
}

export function getOidcPostLoginRedirect(): string {
  const redirect = process.env.OIDC_POST_LOGIN_REDIRECT;
  if (!redirect) throw new Error('OIDC_POST_LOGIN_REDIRECT must be set');
  return redirect;
}
