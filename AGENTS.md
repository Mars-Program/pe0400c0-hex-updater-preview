# Preview publication contract

This public repository owns the online Chrome trial site only. Full engineering
source remains in Mars-Program/pe0400c0-hex-updater-source.

- Work in codex/<change>, keep focused commits and use a checked PR.
- The 2026-11-16 user instruction authorizes checked preview candidates before
  feature acceptance. It does not authorize source functional merges or production.
- Publish only manifest-verified runtime assets/notices from a successful exact
  private build. Never include source projects, HEX, QA, logs or credentials.
- Candidate IDs, files and manifests are immutable. A correction gets a new ID.
- Main pushes deploy this repository only after Preview validation succeeds.
  No production credentials or cross-repository deployment secret belongs here.
- Give the user a permanent candidate URL, change summary and honest test scope.
  Approval must identify that candidate; a CI success or agent comment is not it.
- Production must reuse the accepted candidate bytes and its manifest hash.
- Preview and production paths share mars-program.github.io. Preserve journals,
  preferences, serial permissions and cross-tab locks. Never clear or rename
  browser storage to bypass an unresolved update.
- No device operations from CI; hardware, HMI and macOS execution need their own
  evidence. The current baseline preview does not add new device qualification.
