# Verify Summary

Branch: `e3d-pilot/impl-5802bc1f2fe4-repo-20260918102643`

Worktree: `/var/folders/vn/jrwn6x0579v_26grcpvwp_200000gn/T//e3d-pilot.impl-5802bc1f2fe4-repo-20260918102643.dhBOID`

## Command 1

Command: `npm install`

Exit Status: `0`

## Command 2

Command: `node --check bin/e3d-corp`

Exit Status: `0`

## Command 3

Command: `node --test --test-skip-pattern='real knowledge-base results|records evidence for the repo lookup|real integration returns real repos' $(find test -name '*.test.js' ! -name 'e3dTradeAcceptance.test.js')`

Exit Status: `0`

