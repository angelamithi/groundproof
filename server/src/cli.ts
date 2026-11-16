// Admin CLI:
//   npm run cli -- create-key "Acme Agents" [--max-reward 5] [--daily 100] [--webhook https://…]
//   npm run cli -- list-keys
//   npm run cli -- set-webhook <key id> <url|none>
//   npm run cli -- disable-key <key id>
//   npm run cli -- operator          (prints the operator address to register as a verifier)
import { createApiKey, disableKey, listApiKeys, setWebhook } from './accounts.ts';
import { operator } from './sui.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

switch (cmd) {
  case 'create-key': {
    const name = rest[0];
    if (!name) throw new Error('usage: create-key <name> [--max-reward 5] [--daily 100] [--webhook url]');
    const k = createApiKey({
      name,
      maxRewardUsdc: flag('max-reward'),
      dailyLimitUsdc: flag('daily'),
      webhookUrl: flag('webhook'),
    });
    console.log(JSON.stringify(k, null, 2));
    console.log('\nStore the apiKey and webhookSecret now; the API key cannot be shown again.');
    console.log(`Fund the wallet ${k.walletAddress} with USDC (and SUI for gas if sponsorship is off).`);
    break;
  }
  case 'list-keys':
    console.table(listApiKeys());
    break;
  case 'set-webhook':
    setWebhook(rest[0], rest[1] === 'none' ? null : rest[1]);
    console.log('ok');
    break;
  case 'disable-key':
    disableKey(rest[0]);
    console.log('ok');
    break;
  case 'operator':
    console.log(operator().toSuiAddress());
    break;
  default:
    console.log('commands: create-key, list-keys, set-webhook, disable-key, operator');
}
