# test-fixture (eval harness)

Synthetic fixture used by `eval/harness/scenario.test.ts` to exercise
`loadScenario`, `applyScenario`, and `checkScenario` in isolation.

**Not a real eval scenario.** Real scenarios live in `eval/scenarios/` and
follow the format defined in `docs/eval/04-scenario-corpus.md`.

## Files

- `base.patch` — turns `src/foo.txt` from `"fixed"` to `"buggy"` (the
  canonical reverse-patch shape).
- `task.txt` — placeholder task, never fed to a real model.
- `success.sh` — exits 0 unconditionally. Tests for `checkScenario` that
  need non-zero exit, timeout, or cwd verification use synthesized
  `Scenario` objects pointing at variant scripts in `__fixtures__/scripts/`.
