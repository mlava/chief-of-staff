# Eval Review Playbook

Weekly review cadence for the eval flywheel. Takes 10–20 minutes once the queue is running.

---

## 1. Check the Review Queue

Open **Chief of Staff/Review Queue** in Roam.

For each **pending** entry:

- [ ] Read the prompt and concern
- [ ] Check: was the concern valid?
  - **Yes, real defect** → mark status `reviewed-defect`, then go to Step 4
  - **No, false positive** → mark status `reviewed-ok`, note why (e.g. "judge penalised partial response but user asked for partial")
  - **Led to a threshold/guard change** → mark status `reviewed-tuned`

Track your false-positive count. If > 30% of entries are false positives, the eval prompt needs tuning (Step 6).

---

## 2. Scan the Eval Log

Open **Chief of Staff/Eval Log** in Roam.

- [ ] Eyeball the score distribution. Most runs should be TC:4-5, FG:4-5, S:5.
- [ ] Look for clusters: same model consistently scoring lower? Same dimension always docked?
- [ ] Any TC:1-2 entries that didn't land in the review queue? (Would mean the review threshold is too high.)

No action needed if scores look healthy. This is a 2-minute scan.

---

## 3. Check Guard Accuracy

Open **Chief of Staff/Usage Stats** in Roam.

- [ ] Look at the `guard accuracy:` line at the end of today's/this week's entry
- [ ] Any guard with TP rate below 60%? That guard's patterns are too aggressive — investigate which prompts triggered it (check Review Queue entries with that guard name)
- [ ] Any guard with 0 firings? Expected for most users — injection and fabrication guards should rarely fire in normal use

---

## 4. Convert Defects to Regression Tests

For each `reviewed-defect` entry:

- [ ] Identify the failure category:
  - **Wrong tier** → add a `computeRoutingScore()` test to `tests/eval-regression.test.mjs`
  - **Missed injection** → add a `detectInjectionPatterns()` or `detectMemoryInjection()` test
  - **Claimed action** → add a `detectClaimedActionWithoutToolCall()` test
  - **Guard false positive** → add a test that verifies the legitimate prompt is NOT flagged
  - **Other** → capture as a `capture_thought` in Open Brain for context

- [ ] Fix the underlying guard/pattern/threshold
- [ ] Run `npm test` — confirm the new test passes and no existing tests break
- [ ] Run `npm run test:stress` — confirm 69/69 still holds
- [ ] Run `npm run build`

---

## 5. Optionally Add New Stress Scenarios

If the defect came from a novel framing or attack surface not covered by the existing 4 scenarios:

- [ ] Create a new scenario JSON in `tests/stress/scenarios/`
- [ ] Follow the existing format: `baseIntent` (array), `framings` (array with label + template), `expectedBehaviour`
- [ ] Run `npm run test:stress` to establish a baseline
- [ ] Fix any gaps found, add regression tests

---

## 6. Tune the Eval Judge (monthly or when FP rate > 30%)

Open **Chief of Staff/Review Queue** and filter for `reviewed-ok` entries.

- [ ] Do false positives cluster around a pattern? Common ones:
  - Judge penalises partial responses when user asked for partial
  - Judge marks TC:3-4 on queries that were answered but not acted on (read-only intent)
  - Judge flags truncation on responses that end with a question (intentional)

- [ ] For each cluster, add an exemption clause to the eval prompt in `src/eval-judge.js` (`EVAL_SYSTEM_PROMPT` constant). Example:
  ```
  Note: if the user explicitly asked for a partial or limited response,
  do not penalise task_completion for omitting the rest.
  ```

- [ ] Run a few agent interactions with eval enabled to verify the tuning reduces false positives

---

## Cadence Summary

| What | When | Time |
|------|------|------|
| Review Queue scan | Weekly | 10 min |
| Eval Log scan | Weekly | 2 min |
| Guard accuracy check | Weekly | 2 min |
| Defect → regression test | As found | 10-15 min each |
| New stress scenarios | When novel attack surfaces appear | 20 min |
| Judge prompt tuning | Monthly or when FP > 30% | 15 min |
| Stress harness full run | After guard/threshold changes | 1 min (automated) |

---

## Commands Reference

```bash
npm test                # All 324 unit + regression tests
npm run test:eval       # Regression tests only
npm run test:stress     # Factorial stress harness (4 scenarios, 69 cases)
npm run build           # Webpack bundle
```
