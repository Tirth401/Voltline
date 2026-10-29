/**
 * Runs Voltline the way you would by hand, then checks the bill.
 *
 * Seeds the demo data, starts the real gateway process, runs one simulated session through the
 * simulator's CLI, compares the stored energy with the charger's ground truth, and stops the
 * gateway with SIGTERM. Needs `pnpm db:up` and `pnpm db:migrate` first. Run with: pnpm smoke
 *
 * The same seed always produces the same session, so running it twice shows the second run's
 * StartTransaction landing on the first run's session (D-006).
 */
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPool, DEMO, seedDemo } from '../packages/db/src/index.ts';

const port = Number(process.env['SMOKE_PORT'] ?? 19_220);
const seed = process.env['SMOKE_SEED'] ?? '7';
const root = new URL('..', import.meta.url);

const pool = createPool({ max: 2 });
await seedDemo(pool);

const gateway = spawn(process.execPath, ['services/gateway/src/main.ts'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

try {
  await waitForPort(port, 10_000);
  const output = execFileSync(
    process.execPath,
    [
      'simulator/src/cli.ts',
      ...['--url', `ws://127.0.0.1:${port}/ocpp`],
      ...['--charger', DEMO.chargePointIds[0], '--tag', DEMO.idTag, '--seed', seed],
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const truth = JSON.parse(output) as {
    transactionId: number;
    physicalWh: number;
    evidencedWh: number;
  };
  const { rows } = await pool.query<{ state: string; energy_wh: number | null }>(
    'SELECT state, energy_wh FROM transactions WHERE transaction_id = $1',
    [truth.transactionId],
  );
  const billed = rows[0];
  console.log(`charger:  ${truth.physicalWh} Wh flowed, ${truth.evidencedWh} Wh evidenced`);
  console.log(
    `database: transaction ${truth.transactionId} is ${billed?.state ?? 'missing'}, billed ${billed?.energy_wh ?? 'nothing'} Wh`,
  );
  if (billed?.energy_wh === truth.evidencedWh) {
    console.log('Billed exactly what the charger evidenced.');
  } else {
    console.error('MISMATCH between the bill and the charger.');
    process.exitCode = 1;
  }
} finally {
  gateway.kill('SIGTERM');
  const [code] = (await once(gateway, 'exit')) as [number | null];
  console.log(`gateway stopped on SIGTERM (exit code ${String(code)})`);
  await pool.end();
}

async function waitForPort(target: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(target, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        resolve(false);
      });
    });
    if (open) return;
    await sleep(100);
  }
  throw new Error(`gateway did not start listening on port ${target} within ${timeoutMs} ms`);
}
