# OCPP 1.6 JSON schemas (vendored, unmodified)

This folder holds the Open Charge Alliance's official JSON schemas for OCPP 1.6J. From Milestone 1,
the gateway validates every message against them.

## How to get them

1. Open https://openchargealliance.org/download-ocpp/ and choose **Proceed without account** (or
   create a free account; either works).
2. Download **OCPP 1.6 (all files & errata)**.
3. Unzip it and find the JSON schemas: one file per message, named like `BootNotification.json`
   (the request) and `BootNotificationResponse.json` (the response).
4. Copy those `.json` files into this folder, unchanged. 56 files cover the 28 core actions.
5. From the repo root, run `pnpm prereqs`. It lists any file still missing.

## Rules

- **Don't edit these files.** If a schema needs a workaround, put it in code (`packages/ocpp/src`)
  and record why in `DECISIONS.md`.
- **Read the license in the OCA download** before making the repo public.
- The separate **OCPP 1.6 Security Whitepaper** adds more schemas (for example
  `SecurityEventNotification.json`). We don't use them, so leave them out.
