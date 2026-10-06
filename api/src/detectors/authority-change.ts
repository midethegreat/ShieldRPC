/**
 * Detector #2: Authority change to unfamiliar address
 *
 * Flags `setAuthority` instructions that transfer any of the following
 * authority types to an address that is NOT:
 *   - the current transaction's fee payer (i.e. user rotating to another
 *     key they control is plausible, though still high-risk)
 *   - the existing current-authority pubkey (no-ops, or self-transfers)
 *   - an empty / revoked authority (newAuthority == null => user is
 *     removing an authority, which is *safe*)
 *
 * Heuristically, any setAuthority to a third-party address is extremely
 * suspicious — even if a user "understands" what's happening, it's almost
 * always the right call to warn.
 */

import type { ParsedTransaction } from '../lib/types.js';
import type { DetectionResult } from './types.js';

/**
 * Authority types that, if changed, represent a HIGH or CRITICAL risk.
 *   - MintTokens / FreezeAccount on a mint → you're giving up mint control
 *   - AccountOwner / CloseAccount on an ATA → you're giving someone your
 *     token account (drainer pattern)
 */
const HIGH_RISK_TYPES = new Set<string>([
  'AccountOwner',
  'CloseAccount',
  'MintTokens',
  'FreezeAccount',
]);

export function detectAuthorityChange(tx: ParsedTransaction): DetectionResult | null {
  const hits: Array<{
    index: number;
    authorityType: string;
    account: string | null;
    newAuthority: string | null;
    currentAuthority: string | null;
  }> = [];

  for (const ix of tx.instructions) {
    if (ix.instructionType !== 'setAuthority') continue;
    const newAuth = ix.args.newAuthority as string | null | undefined;

    // Revoking authority (setting to None) = not a risk transfer
    if (!newAuth) continue;

    const currentAuthority = ix.args.currentAuthority as string | null | undefined;
    const account = ix.args.account as string | null | undefined;
    const authType = (ix.args.authorityType as string) ?? 'unknown';

    // Self-transfer (to current authority, to fee payer) is still high risk
    // but slightly more explicable. We flag ALL transfers, and let the
    // severity ladder encode the delta.
    const looksLikeSelfTransfer =
      newAuth === tx.feePayer || newAuth === currentAuthority;

    if (looksLikeSelfTransfer) {
      // User explicitly rotating to their own key. Still a warnable event,
      // but at lower severity.
      hits.push({
        index: ix.index,
        authorityType: authType,
        account: account ?? null,
        newAuthority: newAuth,
        currentAuthority: currentAuthority ?? null,
      });
      continue;
    }

    hits.push({
      index: ix.index,
      authorityType: authType,
      account: account ?? null,
      newAuthority: newAuth,
      currentAuthority: currentAuthority ?? null,
    });
  }

  if (hits.length === 0) return null;

  // Severity: worst hit wins
  let worstSeverity: DetectionResult['severity'] = 'medium';
  for (const h of hits) {
    const isSelf = h.newAuthority === tx.feePayer || h.newAuthority === h.currentAuthority;
    if (HIGH_RISK_TYPES.has(h.authorityType)) {
      worstSeverity = isSelf ? 'high' : 'critical';
      break;
    } else {
      worstSeverity = isSelf ? 'medium' : 'high';
    }
  }

  const first = hits[0]!;
  const detail =
    hits.length === 1
      ? `setAuthority (${first.authorityType}) transfers control to ${first.newAuthority}${
          first.account ? ` on account ${first.account}` : ''
        }`
      : `${hits.length} setAuthority instructions transfer account/program control`;

  return {
    type: 'authority_change',
    severity: worstSeverity,
    detail,
    metadata: { changes: hits },
  };
}
