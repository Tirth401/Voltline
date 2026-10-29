// Usage: node packages/db/src/cli.ts migrate|seed-demo   (or: pnpm db:migrate, pnpm db:seed)
import { migrate } from './migrate.ts';
import { createPool } from './pool.ts';
import { DEMO, seedDemo } from './seed.ts';

const [command] = process.argv.slice(2);
if (command !== 'migrate' && command !== 'seed-demo') {
  console.error('usage: node packages/db/src/cli.ts migrate|seed-demo');
  process.exit(2);
}

const pool = createPool({ max: 1 });
try {
  if (command === 'migrate') {
    const ran = await migrate(pool);
    console.log(ran.length === 0 ? 'Database is up to date.' : `Applied: ${ran.join(', ')}`);
  } else {
    await seedDemo(pool);
    console.log(
      `Seeded site ${DEMO.siteId}, chargers ${DEMO.chargePointIds.join(', ')}, id tag ${DEMO.idTag}.`,
    );
  }
} finally {
  await pool.end();
}
