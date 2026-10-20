// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scentic's AuthLoginAsMail — signs a signer in with the code emailed to them. Replaces OpenSign's
// cloud/parsefunction/AuthLoginAsMail.js at image build (deploy/opensign-server-patches.mjs).
//
// Upstream accepted a code any number of times, for as long as it was the latest, with no limit on
// wrong guesses. Here a code works once, until it expires (SendMailOTPv1.js), and five wrong tries
// spend it. The attempt is counted before the code is compared, in one atomic write, so guesses
// sent all at once cannot get past the limit between a read and a save.
//
// The answers the signing page understands are kept: 'Invalid Otp', 'user not found!', or the
// session. Signing in is by Parse's /loginAs with the master key, as upstream: no password is
// involved, and password sign-in is closed to signers' accounts (patches, cloud/main.js).
import axios from 'axios';
import { cloudServerUrl, serverAppId } from '../../Utils.js';

const MAX_ATTEMPTS = 5;
const normalise = value => String(value || '').toLowerCase().replace(/\s/g, '');

async function AuthLoginAsMail(request) {
  const email = normalise(request.params.email);
  const otp = parseInt(String(request.params.otp ?? '').trim(), 10);
  try {
    const row = await new Parse.Query('defaultdata_Otp').equalTo('Email', email).first({ useMasterKey: true });
    if (!row) return 'user not found!';

    row.increment('Attempts');
    await row.save(null, { useMasterKey: true });
    const attempts = row.get('Attempts') || 0;
    const expiresAt = row.get('ExpiresAt')?.getTime?.() ?? 0;
    const code = row.get('OTP');

    if (code == null || expiresAt <= Date.now() || attempts > MAX_ATTEMPTS || !Number.isFinite(otp) || code !== otp) {
      return 'Invalid Otp';
    }

    // Spent.
    row.unset('OTP');
    row.unset('ExpiresAt');
    await row.save(null, { useMasterKey: true });

    const user = await new Parse.Query(Parse.User).equalTo('email', email).first({ useMasterKey: true });
    if (!user) return 'user not found!';

    const res = await axios({
      method: 'POST',
      url: `${cloudServerUrl}/loginAs`,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'X-Parse-Application-Id': serverAppId,
        'X-Parse-Master-Key': process.env.MASTER_KEY,
      },
      params: { userId: user.id },
    });
    const session = res.data;
    if (!session?.sessionToken) return 'user not found!';

    // The signing page checks that the address was verified; it just was.
    if (!user.get('emailVerified')) {
      user.set('emailVerified', true);
      await user.save(null, { useMasterKey: true });
      session.emailVerified = true;
    }
    return session;
  } catch (err) {
    console.log('err in AuthLoginAsMail', err?.message || err);
    return 'Result not found';
  }
}
export default AuthLoginAsMail;
