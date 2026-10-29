// Runs one simulated charging session against a gateway and prints the charger's ground truth.
// Usage: pnpm sim --url ws://localhost:9220/ocpp --charger CP-DEMO-1 --tag TAG-DEMO-1 --seed 42
import { parseArgs } from 'node:util';
import { createV16Validator } from '@voltline/ocpp';
import { runSession } from './charger.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://localhost:9220/ocpp' },
    charger: { type: 'string', default: 'CP-DEMO-1' },
    tag: { type: 'string', default: 'TAG-DEMO-1' },
    seed: { type: 'string', default: '1' },
  },
});

const seed = Number(values.seed);
if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
  console.error(`--seed must be an integer in [0, 2^32), got "${values.seed}"`);
  process.exit(2);
}

const truth = await runSession({
  gatewayUrl: values.url,
  chargePointId: values.charger,
  idTag: values.tag,
  seed,
  validator: createV16Validator(),
});

const { startRequest, meterValuesRequests, stopRequest, ...summary } = truth;
console.log(JSON.stringify(summary, null, 2));
