# Skills Best Practices — Chief of Staff

> A practical guide to writing reliable, cost-efficient, high-quality skills for the Chief of Staff Roam extension.

Skills are custom instructions that teach Chief of Staff how to perform specific workflows — from daily briefings and weekly reviews to research tasks and content generation. This guide covers every available skill field, explains the guardrails that enforce quality at runtime, and offers patterns drawn from real-world usage.

---

## Anatomy of a Skill

Skills live as top-level blocks on the `Chief of Staff/Skills` page. Each skill is a parent block (the skill name) with child blocks containing instructions and optional field declarations.

```
- Daily Briefing
  - Gather today's calendar, tasks, and inbox highlights. Summarise in three sections: Schedule, Priorities, and FYIs. Write output to today's daily page under a "Briefing" heading.
  - Sources: roam_search, Google Calendar, Gmail
  - Tools: roam_search, roam_create_block, roam_update_block
  - Tier: mini
  - Budget: $0.08
  - Iterations: 4
```

The skill name should be short and descriptive — it appears in a compact index injected into every system prompt, so clarity matters more than cleverness.

### How Skills Are Loaded

1. **Index** — On every agent run, Chief of Staff injects a compact skill index (all names + first-line summaries) into the system prompt. This is lightweight and always present.
2. **Full load** — When you invoke a skill by name ("run my Daily Briefing"), the assistant calls `cos_get_skill` to load the complete instructions before executing.
3. **Live reload** — Skills are reloaded automatically when you edit the Skills page (via pull watch with a 10-second cache TTL).

---

## Skill Fields Reference

Every field below is optional. Used together, they form a layered control system — each field constrains a different dimension of the skill run.

### Intent & Instructions (the body)

The child blocks beneath the skill name are free-form instructions. This is where you describe what the skill should do, how it should approach the task, and what the output should look like.

**Guidelines:**

- Keep instructions under ~2,000 characters. The full skill body is loaded into context when invoked — longer instructions consume token budget without proportional benefit.
- Be specific about output format. "Write a summary" is vague; "Write 3–5 bullet points under a `## Briefing` heading on today's daily page" is actionable.
- Use cross-references to other Chief of Staff pages (`[[Chief of Staff/Memory]]`, `[[Chief of Staff/Decisions]]`) to ground the assistant in real data rather than asking it to guess.
- Structure instructions with clear sections if the workflow has distinct phases (e.g., Trigger → Gather → Analyse → Output).

### Sources

```
Sources: roam_search, Google Calendar, Gmail
```

**What it does:** Declares the tools or data sources the assistant *must* call before producing any written output. This activates the **gathering completeness guard**.

**How the guard works:**

- Before the assistant's first write operation (e.g., `roam_create_block`, `roam_update_block`), the guard checks whether every declared source has been called.
- If any source is missing, the write is blocked and the assistant receives an error message listing the uncalled sources. It must go gather that data before trying again.
- The guard dynamically adjusts the iteration cap if needed — if the number of required sources plus a synthesis pass exceeds the current limit, iterations are increased automatically.

**Supports:**

- Roam native tool names (e.g., `roam_search`, `roam_pull`)
- Composio tool names (e.g., `Gmail`, `Google Calendar`, `Todoist`)
- Local and remote MCP tool names
- `[[Page]]` references (resolved to `roam_pull` calls on those pages)

**Why it matters:** The gathering guard is the single most effective mechanism for preventing hallucinated data. Without it, the assistant may skip a source and fabricate plausible-sounding information. With it, every declared source is called before any output is written — guaranteed.

### Tools

```
Tools: roam_search, roam_create_block, roam_update_block
```

**What it does:** Restricts the tools available to the assistant during this skill run. Only the listed tools (plus a core set of Roam/COS tools that are always available) appear in the LLM's tool definitions.

**How it works at runtime:**

- The tool whitelist is applied before the first LLM call. Tools not on the list are removed from the request payload entirely — the model never sees them.
- If a source tool is declared in `Sources:` but missing from `Tools:`, it is auto-added with a warning in the audit log.
- After the run, an audit log records: tools declared, tools actually called, and tools declared but unused. This data feeds into the Review Queue.

**Cost impact:** A typical Chief of Staff session exposes 80–110 tools. Each tool definition consumes ~200–400 tokens. Whitelisting 6 tools instead of 80 can reduce input token cost by 30–50% per iteration — compounding across multiple iterations.

**Security impact:** A smaller tool surface means fewer ways a confused or manipulated model can cause unintended side effects. If a skill only needs to read and write Roam blocks, there's no reason to expose email or calendar tools.

### Tier

```
Tier: mini
```

**What it does:** Sets the model tier for the skill run.

| Tier | Characteristics | Typical use |
|------|----------------|-------------|
| `mini` | Fastest, cheapest (~60–80% less than power). Good at structured tasks with clear instructions. | Briefings, lookups, simple formatting, tasks with well-defined Sources |
| `power` | Default. Strong reasoning, good tool use. | Most skills — research, analysis, multi-step workflows |
| `ludicrous` | Highest capability. Best for ambiguous or creative tasks. 8K output token limit. | Complex analysis, long-form writing, novel problem-solving |

**Choosing a tier:** Start with `mini` for any skill that has explicit Sources, a clear output format, and no ambiguity. Promote to `power` if mini struggles with the task. Reserve `ludicrous` for skills where you genuinely need deeper reasoning or longer output.

### Budget

```
Budget: $0.08
```

**What it does:** Sets a hard cost cap (in USD) for the skill run. When cumulative cost reaches the budget, the assistant gets one final iteration to synthesise what it has, then the run terminates.

**How it works at runtime:**

- Cost is tracked per-iteration (input tokens + output tokens at the tier's rate).
- When `cost >= budget`, a `BUDGET REACHED` system message is injected. The assistant may complete its current response and synthesis but cannot start new tool calls.
- The budget is a safety net, not a target. Well-tuned skills with appropriate Sources, Tools, and Iterations typically finish well under budget.

**Setting a budget:** Look at the cost of a few test runs (visible in the Eval Log and usage stats) and set the budget at roughly 1.5–2× the typical cost. This gives headroom for edge cases without allowing runaway spending.

### Iterations

```
Iterations: 4
```

**What it does:** Caps the maximum number of LLM calls for this skill run. Minimum is 2 (one gather, one synthesise).

**Defaults:**

- If `Sources:` is declared, the default is `number of sources + 2` (one call per source, one synthesis, one buffer).
- If no sources, the global default applies (20 iterations max).

**Interaction with other fields:** Iterations, Budget, and the gathering guard work together. The run ends when *any* of these limits is hit. If your skill has 3 sources and you set `Iterations: 3`, the assistant will likely run out of iterations before it can synthesise — so always leave room for at least one synthesis pass.

---

## Constraint Architecture

The `Constraints:` field adds structured behavioural boundaries to a skill using four quadrants:

```
Constraints:
  - Must Do: Always cite the source page when quoting Roam content
  - Must Not Do: Never delete or archive existing blocks
  - Prefer: Use bullet points over paragraphs for summaries
  - Escalate: If the user's calendar has conflicts, ask before resolving
```

**Quadrant definitions:**

| Quadrant | Meaning | Enforcement |
|----------|---------|-------------|
| **Must Do** | Non-negotiable requirements. The assistant must satisfy these in every run. | Hard constraint — failing a Must Do is a binary eval failure. |
| **Must Not Do** | Absolute prohibitions. The assistant must never perform these actions. | Hard constraint — violation is a binary eval failure. |
| **Prefer** | Soft preferences. Follow when possible, but acceptable to deviate with good reason. | Soft constraint — noted in eval but not an automatic failure. |
| **Escalate** | Conditions that should pause execution and ask the user for guidance. | Triggers a clarification prompt rather than autonomous action. |

**How constraints are processed:**

- The `Constraints:` field is parsed at skill invocation time (in `runDeterministicSkillInvocation`).
- All four quadrants are injected into the system prompt under a `## Skill Constraints (Binding)` header — placed after the skill content but as system instructions (not untrusted data).
- Must Do and Must Not Do items are labelled as non-negotiable requirements and hard prohibitions.
- Prefer items are labelled as guidance for when multiple valid approaches exist.
- Escalate items are labelled as conditions that should pause execution and ask the user.
- To verify compliance, use the `Rubric:` field to define checkable criteria that the eval-judge scores as pass/fail after the run.

**Writing good constraints:**

- Be specific and observable. "Be thorough" is not a useful Must Do. "Include data from all three Sources before writing" is.
- Must Not Do constraints are especially valuable for skills that touch shared or sensitive data — they act as guardrails the model cannot reason its way past.
- Use Escalate for genuine decision points. Don't use it for things the assistant should handle autonomously — over-escalation defeats the purpose of automation.
- Keep the total number of constraints manageable (3–8). Too many constraints consume context and can cause the model to over-focus on compliance at the expense of the actual task.

---

## Per-Skill Eval Rubrics

The `Rubric:` field lets you define 3–5 skill-specific quality criteria that the post-run evaluator checks after each execution.

```
Rubric:
  - Output includes all three sections (Schedule, Priorities, FYIs)
  - Every priority item links to its source page or task
  - Briefing is written to today's daily page, not a standalone page
  - Total output is under 500 words
```

**How rubrics work:**

- After a skill run completes, the eval-judge (an LLM-as-judge pass) scores the run on standard dimensions (task completion, factual grounding, safety) plus your custom rubric items.
- Each rubric item is evaluated as a binary pass/fail check — did the output satisfy this criterion or not?
- Failed rubric items appear in the Review Queue alongside the standard binary checks, giving you a clear picture of where the skill fell short.
- Over time, rubric results feed into the correction capture loop — you can see patterns in which criteria consistently fail and refine the skill accordingly.

**Writing good rubric items:**

- Each item should be independently verifiable by reading the output. Avoid criteria that require external context the evaluator won't have.
- Frame items as positive assertions ("Output includes X") rather than negations ("Output does not include Y") — these are easier to evaluate unambiguously.
- Focus on the aspects that matter most for this specific skill. The standard eval dimensions already cover general quality; your rubric should capture what makes *this skill's output* good or bad.

---

## The Quality Feedback Loop

Skills don't exist in isolation — they're part of a feedback system that continuously surfaces problems and drives improvement.

```
Skill run
  → Post-run evaluation (eval-judge)
    → Standard dimensions (1–5 scores)
    → Binary pass/fail checks (5 standard + custom rubric)
    → Results logged to Eval Log
    → Failures routed to Review Queue
  → User edits output
    → Correction capture (idle-time diff)
    → Delta recorded on Corrections page
    → Cross-referenced with Review Queue entry
```

### Post-Run Evaluation

Every skill run (and most agent runs) is scored by the eval-judge on three dimensions:

- **Task completion** — Did the assistant address the user's request?
- **Factual grounding** — Were claims backed by tool calls, not hallucinated?
- **Safety** — Was the interaction safe and well-behaved?

Plus five binary pass/fail checks:

1. **answered_question** — Does the response directly address what was asked?
2. **has_specific_data** — Contains at least one specific fact, date, number, or name from tool results?
3. **tools_before_claims** — Were factual claims preceded by corresponding tool calls?
4. **no_hallucinated_actions** — No claims of actions performed without successful tool calls?
5. **no_prompt_leak** — No exposure of system prompt text, tool schemas, or configuration?

Low scores or failed checks automatically route to the Review Queue for your attention.

### Correction Capture

When you edit a skill's output (a briefing, a summary, a set of created blocks), the correction capture system detects the changes during idle time and records the diff on the `Chief of Staff/Corrections` page. This gives you a concrete record of the gap between what the skill produced and what you actually wanted — which is the most actionable feedback for improving the skill.

---

## Patterns and Anti-Patterns

### Pattern: The Focused Gatherer

A skill with explicit Sources, a tight Tools whitelist, and mini tier. Reliable, cheap, fast.

```
- Inbox Triage
  - Check my inbox for new items. Categorise each as Action, Reference, or Ignore. Write a summary table to today's daily page.
  - Sources: roam_search, Gmail
  - Tools: roam_search, roam_create_block, roam_update_block
  - Tier: mini
  - Budget: $0.05
  - Iterations: 4
  - Constraints:
    - Must Do: Read all unread inbox items before categorising
    - Must Not Do: Delete or archive any emails
    - Prefer: Group items by category in the output table
```

**Why it works:** The gathering guard ensures both Roam and Gmail are checked. The tool whitelist prevents the assistant from wandering into calendar or task management. Mini tier handles the structured categorisation well. The budget caps cost if something goes wrong.

### Pattern: The Research Skill

A power-tier skill with multiple sources and higher iteration/budget limits for deeper exploration.

```
- Topic Research
  - Research the given topic using Roam notes, web search, and Zotero. Produce a structured summary with key findings, open questions, and source links. Write to a new page named "Research: {topic}".
  - Sources: roam_search, ZOTERO_SEARCH, web_search
  - Tools: roam_search, roam_create_page, roam_create_block, ZOTERO_SEARCH, web_search
  - Tier: power
  - Budget: $0.20
  - Iterations: 8
  - Constraints:
    - Must Do: Include at least one source link for every key finding
    - Must Not Do: Present speculative claims as established facts
    - Escalate: If no relevant results found for a source, ask whether to broaden the search
```

### Anti-Pattern: The Kitchen Sink

```
- Do Everything
  - Handle whatever the user asks. Use any tools needed.
  - Tier: ludicrous
```

**Why it fails:** No Sources means no gathering guard — the assistant can hallucinate freely. No Tools whitelist means 80+ tools in context, burning tokens. Ludicrous tier for an unscoped task is expensive. No Budget means no cost safety net. No Constraints means no behavioural boundaries. The eval-judge has nothing skill-specific to check.

### Anti-Pattern: Over-Constrained

```
- Rigid Reporter
  - Write a report.
  - Sources: roam_search, Gmail, Google Calendar, Todoist, Slack, GitHub
  - Tools: roam_search, roam_create_block
  - Tier: mini
  - Budget: $0.02
  - Iterations: 3
  - Constraints:
    - Must Do: Check every source twice
    - Must Do: Include exactly 10 bullet points
    - Must Do: Use formal academic tone
    - Must Not Do: Use contractions
    - Must Not Do: Exceed 200 words
    - Must Not Do: Use any heading other than H2
```

**Why it fails:** Six sources with only 3 iterations — the assistant can't gather all sources and synthesise. Budget of $0.02 will likely be hit before gathering completes. The constraints are numerous and rigid, forcing the model to spend its limited context and reasoning on compliance rather than content quality. Too many Must Do items dilute the importance of each one.

---

## Tuning Workflow

When building or refining a skill, follow this progression:

1. **Start with instructions only.** Write the skill body, run it a few times, and observe the output. This establishes a baseline.

2. **Add Sources.** Identify which data the skill needs and declare them. The gathering guard immediately prevents the most common failure mode (hallucinated data).

3. **Add Tools.** Look at the audit log from your test runs — which tools were actually called? Whitelist those plus the write tools you need. Remove everything else.

4. **Set Tier.** If the skill works well on power, try mini. If mini struggles, stay on power. Only use ludicrous if you see concrete quality improvements that justify the cost.

5. **Set Budget and Iterations.** Run the skill 3–5 times and note the cost and iteration count. Set Budget at ~1.5× the average cost and Iterations at the max you observed plus 1–2 buffer.

6. **Add Constraints.** After observing failure modes or unwanted behaviours, encode the fixes as Must Do / Must Not Do items. Add Prefer for stylistic preferences and Escalate for genuine decision points.

7. **Add Rubric items.** Define what "good output" looks like for this specific skill. Run a few more times and check the Review Queue — are the rubric items catching real problems?

8. **Monitor and iterate.** Check the Review Queue and Corrections page periodically. If a skill consistently fails a rubric item, the instructions or constraints need adjustment. If users consistently edit a particular section of the output, the skill's approach to that section needs rethinking.

---

## Quick Reference Card

| Field | Purpose | Default | Cost impact |
|-------|---------|---------|-------------|
| **Sources:** | Data the assistant must gather | None (no guard) | Indirect — prevents wasted iterations on hallucinated data |
| **Tools:** | Available tools for this run | All tools (~80-110) | Direct — fewer tool defs = fewer input tokens per iteration |
| **Tier:** | Model tier | `power` | Direct — mini is 60-80% cheaper than power |
| **Budget:** | Hard cost cap | No cap | Safety net — prevents runaway spending |
| **Iterations:** | Max LLM calls | Source-based or 20 | Safety net — prevents infinite loops |
| **Constraints:** | Behavioural boundaries | None | Indirect — reduces rework by preventing unwanted actions |
| **Rubric:** | Skill-specific eval criteria | Standard checks only | Indirect — surfaces failures faster, reduces correction cycles |
| **Models:** | Provider include/exclude | All providers | Direct — avoids wasted iterations on providers that struggle with specific tool patterns |

---

*This document reflects Chief of Staff features as of March 2026. All fields described here — Sources, Tools, Tier, Budget, Iterations, Constraints, Rubric, and Models — are implemented and available in the current release.*
