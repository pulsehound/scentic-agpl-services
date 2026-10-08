// sign.scentic.com — the address signers open. Deployed as the Cloudflare Worker "scentic-sign"
// with the custom domain sign.scentic.com (Cloudflare account dashboard, Workers & Pages).
//
// Forwards every request to the OpenSign signing page on Cloud Run, so signers see the firm's
// platform's address rather than a *.run.app one. The signer's own address is passed on as the
// first X-Forwarded-For entry, which is where OpenSign reads it for the audit trail.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = 'scentic-agpl-opensign-wggx6fxmwq-ue.a.run.app';
    url.port = '';
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
    headers.delete('Host');
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    return fetch(url.toString(), {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
    });
  },
};
