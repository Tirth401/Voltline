// Deletes the kind cluster and everything in it, database included: pnpm kind:down
import { CLUSTER, clusterExists, runVisible } from './kind.ts';

if (clusterExists()) runVisible('kind', ['delete', 'cluster', '--name', CLUSTER]);
else console.log(`No kind cluster called "${CLUSTER}".`);
