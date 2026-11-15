# PE0400C0 HEX Updater online preview

[Open the Chrome preview site](https://mars-program.github.io/pe0400c0-hex-updater-preview/)

The top bar identifies the exact trial candidate. New updater work is tried here
before user acceptance and production publication. Existing production remains at
https://mars-program.github.io/pe0400c0-hex-updater/ until separately approved.

Each candidate has a permanent URL and a hash-bound candidate.json. Runtime files
come unchanged from the verified private ZIP; the preview banner is a separate
outer page. Production promotion copies those same runtime bytes without rebuilding.
Compiled trial assets are publicly accessible. Full source, local ZIPs, HEX files,
developer QA and raw diagnostics are not included.

Preview and production use different repositories and deployment workflows.
Their GitHub Pages paths share one browser origin, so existing settings, update
journals, serial permissions and the device lock are shared. Use one updater at
a time. Resolve an uncertain device update in the original tool.

## Maintainer flow

1. Wait for the private source PR's CI to pass. Download its ZIP and BUILD_IDENTITY.json.
2. Create a branch here and run scripts/manage_preview.py stage with --zip,
   --identity, --candidate (for example 0.1.6-20261116-001), and --summary.
3. Run scripts/manage_preview.py validate and open a PR. After Preview validation
   passes, merge. Main deploys this preview only; wait for deployment success.
4. Verify the permanent candidate URL and give it to the user with validation limits.
5. After exact candidate acceptance, use the production repository's
   scripts/promote_preview.py. Its separate manual deployment gate remains required.

The stable entry follows the latest trial; use the permanent candidate link when
accepting a build. Already open pages never switch themselves to another candidate.
Old candidates stay immutable. An existing production version cannot be overwritten.

Initial 0.1.5 is the retained baseline package, published to verify this trial site.
No new updater feature or hardware qualification is implied.

## 0.1.6 engine-loading trial

The 0.1.6 candidate adds bounded, integrity-checked engine downloads and explicit startup failures/timeouts. It is a preview only; the private source PR remains open for user acceptance and production remains 0.1.5. Older 0.1.5 candidates stay immutable as diagnostic evidence. The new engine-loader.js runtime module is explicitly allowlisted. Future production promotion must add this reviewed module to its asset allowlist when that candidate is accepted.
