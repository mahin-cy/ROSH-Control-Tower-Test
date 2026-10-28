import type { FastifyInstance } from 'fastify';
import * as client from 'openid-client';
import { z } from 'zod';
import { prisma } from '../lib/prisma-client.js';
import { getOidcClient, getOidcRedirectUri, getOidcPostLoginRedirect } from '../lib/oidc-client.js';
import { storeOidcFlow, consumeOidcFlow } from '../lib/oidc-flow-store.js';
import { createSession } from '../lib/session-store.js';
import { SESSION_COOKIE_NAME } from '../lib/auth-guard.js';
import { logger } from '../lib/logger.js';

const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

// sub is guaranteed by the OIDC spec; email is not (Entra can omit it
// depending on tenant/user config), so it's validated here rather than
// trusted from the JsonValue-typed claim.
const idTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().email().optional(),
  preferred_username: z.string().email().optional(),
  name: z.string().optional()
});

export async function authOidcRoute(app: FastifyInstance) {
  app.get('/api/v1/auth/oidc/login', async (_request, reply) => {
    const config = getOidcClient();
    if (!config) {
      return reply.code(503).send({
        data: null,
        error: { message: 'sign-in with Microsoft is temporarily unavailable' }
      });
    }

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();
    const nonce = client.randomNonce();

    await storeOidcFlow(state, { codeVerifier, nonce });

    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: getOidcRedirectUri(),
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce
    });

    return reply.redirect(authorizationUrl.toString());
  });

  app.get('/api/v1/auth/oidc/callback', async (request, reply) => {
    const query = request.query as { state?: string };
    const flow = query.state ? await consumeOidcFlow(query.state) : null;
    if (!flow) {
      return reply.code(400).send({
        data: null,
        error: { message: 'invalid or expired login attempt, please try again' }
      });
    }

    // Matches the registered redirect URI's origin+path exactly (what Entra
    // was told during /oidc/login) — openid-client derives the token
    // request's `redirect_uri` from this by stripping the query string, so
    // only the query string (code/state) may come from the raw request.
    const currentUrl = new URL(getOidcRedirectUri());
    currentUrl.search = new URL(request.url, 'http://internal').search;

    const config = getOidcClient();
    if (!config) {
      return reply.code(503).send({
        data: null,
        error: { message: 'sign-in with Microsoft is temporarily unavailable' }
      });
    }

    let tokens;
    try {
      tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: flow.codeVerifier,
        expectedState: query.state,
        expectedNonce: flow.nonce
      });
    } catch (err) {
      logger.warn({ err }, 'oidc token exchange failed');
      return reply
        .code(400)
        .send({ data: null, error: { message: 'sign-in failed, please try again' } });
    }

    const rawClaims = tokens.claims();
    const parsed = idTokenClaimsSchema.safeParse(rawClaims);
    if (!parsed.success) {
      logger.warn({ err: parsed.error }, 'oidc id token missing required claims');
      return reply
        .code(400)
        .send({ data: null, error: { message: 'sign-in failed, please try again' } });
    }
    const claims = parsed.data;
    const email = claims.email ?? claims.preferred_username;
    if (!email) {
      logger.warn({ sub: claims.sub }, 'oidc id token has no usable email claim');
      return reply
        .code(400)
        .send({ data: null, error: { message: 'your account has no email address on file' } });
    }

    let user = await prisma.user.findUnique({ where: { oidcSubject: claims.sub } });

    if (!user) {
      // Falls back to email so an existing password account (e.g. the
      // seeded admin) links to this Entra identity instead of getting a
      // duplicate OPERATOR row — also what makes a future IdP swap
      // non-disruptive, since the new provider's sub won't match either.
      user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { oidcSubject: claims.sub }
        });
      }
    }

    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          name: claims.name ?? null,
          oidcSubject: claims.sub,
          role: 'OPERATOR'
        }
      });
      logger.info({ userId: user.id, email }, 'provisioned new user via oidc login');
    }

    const sessionId = await createSession({ userId: user.id, email: user.email, role: user.role });

    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS
    });

    logger.info({ userId: user.id }, 'oidc login succeeded');
    return reply.redirect(getOidcPostLoginRedirect());
  });
}
