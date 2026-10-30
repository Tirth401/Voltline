// Brings the whole system up in a local Kubernetes cluster: pnpm kind:up (D-036)
//
// Creates the kind cluster if it doesn't exist, builds the voltline image, loads every image into
// the kind node, starts Postgres and Redis, runs the migrations, then starts the gateways, the API,
// the charging controller and the settlement CronJob, and waits until each one is ready. Safe to
// run again: unchanged things stay as they are, and the services restart only if the image changed.
import { existsSync } from 'node:fs';
import {
  CLUSTER,
  clusterExists,
  DEPENDENCY_IMAGES,
  IMAGE,
  kubectl,
  kubectlSkew,
  loadImage,
  nodeHasImage,
  run,
  runVisible,
  step,
  succeeds,
} from './kind.ts';

const MANIFESTS = 'deploy/k8s';
const DEPLOYMENTS = ['gateway', 'api', 'charging-controller'];
const started = performance.now();

if (!existsSync('deploy/Dockerfile')) {
  throw new Error('run this from the repository root: pnpm kind:up');
}
if (!succeeds('docker', ['info'])) throw new Error('Docker is not running: start Docker Desktop');
for (const tool of ['kind', process.env['KUBECTL'] ?? 'kubectl']) {
  if (!succeeds(tool, ['version', '--client'].slice(0, tool === 'kind' ? 1 : 2))) {
    throw new Error(`${tool} not found: brew install ${tool === 'kind' ? 'kind' : 'kubectl'}`);
  }
}

step(`Cluster "${CLUSTER}"`);
if (clusterExists()) {
  console.log('  already running');
} else {
  runVisible('kind', ['create', 'cluster', '--config', 'deploy/kind/cluster.yaml', '--wait', '3m']);
}
const skew = kubectlSkew();
console.log(`  Kubernetes ${skew.server}, kubectl ${skew.client}`);
if (skew.minorsApart > 1) {
  console.log(
    `  note: kubectl is ${skew.minorsApart} minor versions away from the cluster. Kubernetes only\n` +
      '  promises one. Everything here uses stable APIs, but if a kubectl command misbehaves,\n' +
      '  install a matching kubectl (brew install kubectl) and run with KUBECTL=/opt/homebrew/bin/kubectl.',
  );
}

step(`Image ${IMAGE}`);
run('docker', ['build', '--quiet', '--file', 'deploy/Dockerfile', '--tag', IMAGE, '.']);
const imageId = run('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}']).trim();
console.log(`  built ${imageId.slice(0, 19)}`);

step('Loading images into the kind node');
for (const image of DEPENDENCY_IMAGES) {
  if (!succeeds('docker', ['image', 'inspect', image])) runVisible('docker', ['pull', image]);
}
for (const image of [IMAGE, ...DEPENDENCY_IMAGES]) {
  // The other images have exact version tags, so one the node already has is the right one. Ours
  // is always voltline:dev, so it goes in every time (it is small).
  if (image !== IMAGE && nodeHasImage(image)) {
    console.log(`  ${image}: already there`);
    continue;
  }
  loadImage(image);
  console.log(`  ${image}: loaded`);
}

step('Postgres and Redis');
kubectl(['apply', '--filename', `${MANIFESTS}/namespace.yaml`]);
for (const file of ['postgres.yaml', 'redis.yaml', 'simulator-rbac.yaml']) {
  kubectl(['apply', '--filename', `${MANIFESTS}/${file}`]);
}
for (const statefulSet of ['postgres', 'redis']) {
  kubectl(['rollout', 'status', `statefulset/${statefulSet}`, '--timeout=5m']);
  console.log(`  ${statefulSet}: ready`);
}

step('Migrations');
kubectl(['delete', 'job', 'migrate', '--ignore-not-found', '--wait']);
kubectl(['apply', '--filename', `${MANIFESTS}/migrate.yaml`]);
try {
  kubectl(['wait', '--for=condition=complete', 'job/migrate', '--timeout=3m']);
} finally {
  const logs = kubectl(['logs', 'job/migrate']).trim();
  console.log(logs.replaceAll(/^/gm, '  '));
}

step('Gateways, API, charging controller and settlement');
for (const file of ['gateway.yaml', 'api.yaml', 'controller.yaml', 'settlement.yaml']) {
  kubectl(['apply', '--filename', `${MANIFESTS}/${file}`]);
}
// The tag stays voltline:dev, so Kubernetes can't tell a new build from the old one. Stamping the
// image's id on the pod template restarts the pods exactly when the image changed.
const stamp = JSON.stringify({
  spec: { template: { metadata: { annotations: { 'voltline.dev/image-id': imageId } } } },
});
for (const deployment of DEPLOYMENTS) {
  kubectl(['patch', `deployment/${deployment}`, '--patch', stamp]);
}
for (const deployment of DEPLOYMENTS) {
  kubectl(['rollout', 'status', `deployment/${deployment}`, '--timeout=5m']);
  console.log(`  ${deployment}: ready`);
}

step('Running');
console.log(kubectl(['get', 'pods', '--output', 'wide']).trim().replaceAll(/^/gm, '  '));
console.log(
  [
    '',
    `Up in ${((performance.now() - started) / 1000).toFixed(0)} s.`,
    '  try it by hand:   curl http://localhost:19230/chargers/CP-DEMO-1',
    '                    pnpm sim --url ws://localhost:19220/ocpp --charger CP-DEMO-1 --tag TAG-DEMO-1',
    '  result 1:         pnpm kind:faults --sessions 5000 --chargers 100 --chaos --seed 1',
    '  tear it down:     pnpm kind:down',
  ].join('\n'),
);
