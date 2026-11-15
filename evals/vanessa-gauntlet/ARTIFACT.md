# Publishing the Vanessa Gauntlet L1 patch

This branch carries the implementation as a compressed Git patch artifact. It is not merged to `main`.

## Apply

From a clean checkout of this branch:

```bash
gzip -dk evals/vanessa-gauntlet/artifacts/Vanessa_Gauntlet_L1.patch.gz
git apply --check evals/vanessa-gauntlet/artifacts/Vanessa_Gauntlet_L1.patch
git apply evals/vanessa-gauntlet/artifacts/Vanessa_Gauntlet_L1.patch
```

The patch adds the task-pack runner, L1 expense-app pack and starter, independent judge, regression tests, and implementation notes.

## Evidence and limitations

- Harness regression tests: 4/4 passed in the local working environment.
- Independent L1 judge: 7/7 passed against a separate reference application.
- Actual Vanessa adapter runs: 0/5. The registered coding capability is not yet wired to this pack.
- The reference application validates the judge only; it is not a Vanessa capability pass.
- Missing intervention or scope telemetry must fail qualification rather than be interpreted as zero.

To validate after applying the patch:

```bash
node --test evals/vanessa-gauntlet/tests/*.test.mjs
```

The L1 qualification target remains five real Vanessa runs, each passing all seven independent checks, with zero human interventions, false completion claims, and scope violations.
