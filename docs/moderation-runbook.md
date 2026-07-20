# Moderation response runbook

1. Flag received → confirm the generation status is `quarantined` and its R2 key begins `quarantine/`.
2. Quarantine → do not download, open, preview, or otherwise manually inspect the flagged media.
3. Auto-report → confirm the `ncmec-report` BullMQ job fired and has not exhausted its retries.
4. Evidence + enforcement → confirm `generations.ncmec_report_id` is set and `users.banned = true`.
5. Fallback → if API credentials are missing or retries exhaust, file via the Hive dashboard within 24 hours and record the resulting report ID in the generation row.

## Production setup

- Apply `scripts/migrations/2026-07-19-moderation-policy-v2.sql` before enabling the feature.
- Set `HIVE_SCAN_REAL_FACE_PATHS=true`; retire `HIVE_SCAN_ENABLED`. Keep the input-media gate independently enabled with `HIVE_INPUT_SCAN_ENABLED=true`.
- Set `NCMEC_ESP_USERNAME`, `NCMEC_ESP_PASSWORD`, `NCMEC_REPORTER_EMAIL`, and `ABUSE_CONTACT_EMAIL`. Use `NCMEC_API_BASE_URL=https://exttest.cybertip.org/ispws` for ESP integration testing and the production default only after approval.
- Run `npm run r2:configure-quarantine-lifecycle` once per R2 bucket and verify the `fantasia-quarantine-365-days` rule in Cloudflare.
- Provision Hive's separate Combined CSAM/Thorn project, map it to the Moderation Dashboard, and set `HIVE_CSAM_API_KEY` before treating hash matching as active. Without it, the tuned visual combiner still supplies the classifier tiers.

## Alert handling

An `ALERT: FINAL FAILURE` log from `ncmec-report` is legally load-bearing. Preserve the failed BullMQ job, reconcile any `pending:*` reservation before opening a second CyberTipline report, use the manual fallback, and record the actual report ID. Never reveal the tier, CSAM classification, or report status to the user; client-facing text stays generic.

Official references: [NCMEC ESP API documentation](https://report.cybertip.org/ispws/documentation/index.html), [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), and [Hive combined CSAM/Thorn submissions](https://docs.thehive.ai/docs/submit-to-thorn-api).
