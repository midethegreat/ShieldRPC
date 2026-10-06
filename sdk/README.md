# @shieldrpc/sdk

TypeScript SDK for ShieldRPC — AI-powered Solana transaction risk scoring.

## Install

```bash
npm install @shieldrpc/sdk
# or
yarn add @shieldrpc/sdk
```

## Usage

```typescript
import { ShieldRPC } from '@shieldrpc/sdk';
import { WalletNotConnectedError } from '@solana/wallet-adapter-base';

const shield = new ShieldRPC({
  apiBaseUrl: 'https://api.your-shieldrpc-instance.com',
});

async function sendTransactionSafely(
  wallet: { signTransaction: any; publicKey: any },
  connection: any,
  transaction: any
) {
  if (!wallet.publicKey) throw new WalletNotConnectedError();

  const analysis = await shield.analyzeTransaction(transaction);
  console.log('Risk score:', analysis.riskScore, '/ 100');
  console.log('Recommendation:', analysis.recommendation);

  if (analysis.recommendation === 'block') {
    alert(`BLOCKED: ${analysis.explanation}`);
    return null;
  }
  if (analysis.recommendation === 'warn') {
    const ok = confirm(`WARNING: ${analysis.explanation}\n\nProceed anyway?`);
    if (!ok) return null;
  }

  const signed = await wallet.signTransaction(transaction);
  const signature = await connection.sendRawTransaction(signed.serialize());
  return signature;
}
```

## Safety behavior on API failure

By default, if the SDK cannot reach the ShieldRPC backend, it **does not**
pretend everything is fine. It instead returns a synthetic `critical` result
with `recommendation: 'warn'` so your UI can show a "could not verify" warning
instead of silently skipping the check. To throw on failure instead, pass
`throwOnFailure: true` to the constructor.
