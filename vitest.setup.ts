import fc from 'fast-check';

// Property tests draw a fresh seed every run, and fast-check prints it when a property fails.
// To replay that failure exactly: VOLTLINE_SEED=<printed seed> pnpm test
const pinned = process.env['VOLTLINE_SEED'];
if (pinned !== undefined) {
  const seed = Number(pinned);
  if (!Number.isInteger(seed)) {
    throw new Error(`VOLTLINE_SEED must be an integer, got "${pinned}"`);
  }
  fc.configureGlobal({ seed });
}
