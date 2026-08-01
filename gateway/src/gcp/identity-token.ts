/**
 * Google-issued identity tokens, for calling a service that sits behind Cloud
 * Run's IAM check.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Kimai runs on Cloud Run with internal ingress and an IAM policy. Those are
 * two separate controls and satisfying one does nothing for the other:
 *
 *   ingress decides which *networks* may reach the service — the gateway is in
 *   the VPC, so it passes;
 *
 *   IAM decides which *identity* may invoke it, and reads only a Google-issued
 *   token in the Authorization header.
 *
 * Kimai's own credentials — X-AUTH-USER and X-AUTH-TOKEN — are read by Kimai,
 * which never runs, because Cloud Run rejects the request first. The symptom is
 * a 403 the Kimai client reports as "auth failed", so it looks like the Kimai
 * token is wrong when nothing has authenticated to Kimai at all.
 *
 * Off Google this returns null and the caller sends no such header: in
 * docker-compose Kimai is a container on the same network with nothing in front
 * of it.
 */

const METADATA_IDENTITY_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/** Short: this sits on the path of a request that is already waiting. */
const METADATA_TIMEOUT_MS = 3_000;

/** Refresh early. A token that expires in flight is a 403 that looks like a missing grant. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** When the token parses but carries no readable expiry. Well inside the hour they last. */
const FALLBACK_LIFETIME_MS = 45 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/** Keyed by audience: a token minted for one service is refused by another. */
const cache = new Map<string, CachedToken>();

function expiryFromJwt(token: string): number | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * An identity token for `audience`, or null where there is no Google identity
 * to present.
 *
 * Null is an ordinary answer, not a failure: it is what a developer's machine
 * and the contract tests return, and there the target has no IAM check to
 * satisfy.
 */
export async function getIdentityToken(audience: string): Promise<string | null> {
  const cached = cache.get(audience);
  if (cached && cached.expiresAtMs > Date.now() + EXPIRY_MARGIN_MS) return cached.token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), METADATA_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(audience)}&format=full`,
      { headers: { 'Metadata-Flavor': 'Google' }, signal: controller.signal },
    );
    if (!response.ok) return null;

    const token = (await response.text()).trim();
    if (!token) return null;

    cache.set(audience, {
      token,
      expiresAtMs: expiryFromJwt(token) ?? Date.now() + FALLBACK_LIFETIME_MS,
    });
    return token;
  } catch {
    // Not on Google, or metadata unreachable. No identity to present.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The audience Cloud Run expects: the service origin, with no path.
 *
 * Kimai's base URL carries one in some configurations, and a token minted for
 * `https://host/api` is refused with a 403 identical to having no grant at all.
 */
export function audienceFor(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

/** Exposed for tests, which must not inherit another case's cached token. */
export function clearIdentityTokenCache(): void {
  cache.clear();
}
