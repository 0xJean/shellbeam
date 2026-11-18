# Ops UI service recovery input regression

[Scheduled run 44003213534](https://github.com/0xJean/shellbeam/actions/runs/44003213534)
on `5f856c6224b45fc756fe4a46d3698e5e14551bf1` timed out waiting
120 seconds for the direct service alert to resolve. The service was active,
the rule was recovering, and its last sample was 17 seconds old. Cleanup and
application exit passed. That report did not retain the saved rule duration
or recovery boundary, so it cannot establish the exact saved value in that run.

## Reproduction

An isolated Ubuntu 22.04 arm64 GTK WebKit 2.50.4 fixture renders the production
`LocalAlertRulesPanel`, store and evaluator, with Wry's scrollbar setting and
the production W3C driver. No native IPC or user profile is substituted into
an installed-app acceptance run; this is a separate synthetic component test.

Without background renders, clearing and typing `0` saves zero correctly.
With local-ops refresh events between the W3C clear and send-keys commands,
React restores the old controlled value: empty becomes `30`, then typing `0`
saves `300`. A controlled 75 ms command boundary with refresh events every
20 ms makes this interleaving reproducible; neither interval is added to the
acceptance harness. The saved rule is `durationMs=0`,
`recoveryDurationMs=300000`. A recovery sample with value `0` at `31000`
starts `recoverySince=31000`; another at `151000` correctly leaves the alert
active/recovering. This reproduces the CI symptom, but is not proof of the
unrecorded value in the original run.

The existing real-key replacement path (Ctrl+A, Backspace, then send keys)
updates React's state when clearing. Under the same controlled render
interleaving both durations remain zero, the first recovery sample resolves
the alert, and the original sample timestamps remain unchanged.

## Change and verification

Only the two acceptance rule-duration inputs use this existing keyboard path.
Before submitting, the journey checks both live values after the severity
selection has blurred the input. After submitting, it checks both persisted
durations exposed by the rule row. Any mismatch fails immediately, with no
resave, retry, notification hook or second-host rule creation.

Rule rows expose their saved durations, original recovery boundary and observed
value as read-only numeric attributes. Failure diagnostics read bounded values
from those rows, never form fields, names, credentials or remote output. Success
events record the verified zero durations. User defaults, evaluation semantics,
timeouts, sampling, identity checks, notification readers/guards and OCR
assertions are unchanged.

Local checks: 311 Node protocol/fixture tests; 15 focused component, evaluator
and persistence tests; production build; changed-file ESLint; `git diff --check`.
The before/after native component reports and screenshots are retained at
`/tmp/shellbeam-ops-recovery-baseline-delayed-refresh.{json,png}` and
`/tmp/shellbeam-ops-recovery-keyboard-delayed-refresh-final.{json,png}`. The isolated
fixture is under ignored `.tmp/ops-recovery-check`; the temporary container
is removed after testing. A complete packaged Ops UI run on the resulting
commit remains required; these component results do not replace it.

## Connection test ordering found by the first PR run

PR run `44219727093` failed one pre-existing English connection-flow test:
it asserted `getKomariMappingState` immediately after the verified-connection
banner appeared. The child mapping panel first awaits `listKomariIntegrations`,
so the banner does not imply that the mapping call has started. The same file
passed all 40 cases in isolation, consistent with the missing asynchronous
boundary rather than a deterministic connection error.

The bilingual test now holds that catalog promise, verifies that completion
is disabled and mapping has not started, then resolves it and awaits the real
node row before checking the original scoped call and completion assertions.
No production connection code or timeout changes. The revised 40 cases and
full macOS frontend suite (2219 passed, 17 skipped), ESLint and diff checks pass.
