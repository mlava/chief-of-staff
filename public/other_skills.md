# Other Skills — Inspiration & Reference

> Skills removed from the default bootstrap set. These are available as inspiration for users who want to create custom skills tailored to their workflows. Copy any skill definition into your `[[Chief of Staff/Skills]]` page to activate it.

---

## Context Prep

- **Trigger:** user is about to talk to someone, work on a project, or make a decision and wants a quick briefing on everything relevant. Phrases like 'brief me on [X]', 'what do I need to know about [person/project/topic]', 'prep me for [thing]'.
- If the entity is ambiguous (e.g. a name that could be a person or project), ask one clarifying question.
- **Sources** — cast a wide net: bt_search (query: [ENTITY]) for related tasks. bt_get_projects if entity is a project. bt_search (assignee: [PERSON]) if entity is a person. the available calendar tools (Local MCP or Composio) for meetings involving entity. roam_search_text or roam_get_backlinks for [[ENTITY]] in the graph. [[Chief of Staff/Decisions]] and [[Chief of Staff/Memory]] for stored context.
- **Output** — deliver in chat panel (do not write to DNP unless asked): Summary (one paragraph: who/what, current status, why it matters now). Recent History (last 2–4 interactions with dates). Open Items (tasks, waiting-for, unresolved questions). Upcoming (meetings, deadlines, next steps). Key Context (from memory, decisions, notes). Suggested Talking Points or Focus Areas.
- **Fallback:** if any tool call fails, include section header with '⚠️ Could not retrieve [source] — [error reason]' rather than skipping silently.
- **Tool availability:** works best with Better Tasks + Google Calendar. If BT unavailable, use roam_search_todos for task context. If calendar unavailable, skip that section and note it. Never fabricate data from unavailable tools.
- **Rules:** keep it concise — prep brief, not a report. Distinguish facts from inferences (mark with [INFERRED]). If very little data exists, say so explicitly. Include source links for key claims.

---

## Daily Page Triage

- **Trigger:** user asks to triage today's daily page, 'clean up today's page', 'process today's blocks', 'triage my DNP'. Can also be triggered as part of End-of-Day Reconciliation.
- This is a mechanical routing skill, not a reflective one. Goal: classify every loose block on today's daily page and move or file it.
- **Sources:** roam_get_block_children on today's daily page. bt_get_attributes for valid attribute names. bt_get_projects (status: active) for project assignment suggestions.
- **Process:** read all blocks on today's page. Skip blocks under structured COS headings (Daily Briefing, Weekly Plan, etc.). For each loose block, classify as: Task → bt_create (or roam_create_todo). Waiting-for → bt_create with assignee (or roam_create_todo with prefix). Decision → [[Chief of Staff/Decisions]]. Reference/note → leave in place or suggest destination. Inbox → [[Chief of Staff/Inbox]]. Junk/duplicate → flag for deletion (never delete without confirmation).
- **Output:** present triage summary in chat — one line per block: '[text snippet] → [category] → [destination]'. Ask for confirmation before executing. End with count: 'Triaged [N] blocks: [X] tasks, [Y] inbox, [Z] decisions, [W] left in place.'
- **Tool availability:** works best with Better Tasks for rich task creation. If BT unavailable, use roam_create_todo for tasks. Never fabricate data from unavailable tools.
- **Rules:** never delete without confirmation. Never modify blocks under structured headings. Default ambiguous blocks to Inbox. Preserve original text when creating tasks. Always present plan before executing — confirmation-first.

---

## Decision Review

- **Trigger:** user asks for recommendation between options.
- **Approach:** before recommending, ask clarifying questions about constraints, timeline, reversibility, and what 'good enough' looks like. Then compare options on tradeoffs, risks, and reversibility.
- **Output format:** recommendation + rationale + next action.
- **Routing:** log the decision to [[Chief of Staff/Decisions]] via roam_create_block if the user confirms a choice. Create follow-up task via bt_create (or roam_create_todo if BT unavailable) if the decision implies an action.
- **Tool availability:** this skill is primarily Roam-native. Better Tasks enhances it with task creation for follow-ups. If BT unavailable, use roam_create_todo. Never fabricate data from unavailable tools.

---

## Delegation

- **Trigger:** user wants to hand off a task. Phrases like 'delegate [X] to [person]', 'hand this off', 'assign this to [person]'.
- If user hasn't specified who, ask. If the task is vague, run Intention Clarifier first.
- **Sources:** bt_search for existing context on the task topic. bt_get_projects for project assignment. bt_search (assignee: [PERSON], status: TODO/DOING) to check the delegate's current load. the available calendar tools (Local MCP or Composio) for upcoming meetings with delegate. [[Chief of Staff/Memory]] for communication preferences.
- **Output:** Task definition (verb-first, enough context to act without questions). Success criteria (2–3 concrete conditions). Boundaries (in/out of scope, decisions they can vs. can't make). Deadline (hard or soft). Check-in points (intermediate milestones for tasks >1 day). Handoff message draft (ready to send via Slack/email). Load check (flag if delegate has many open items).
- **Routing:** create BT task via bt_create with assignee, project, due date. Create check-in task for myself if needed. Offer to send handoff message.
- **Tool availability:** works best with Better Tasks (assignee tracking, load checking) + Google Calendar. If BT unavailable, use roam_create_todo with 'Delegated to [person]:' prefix and note that load checking is unavailable. Never fabricate data from unavailable tools.
- **Rules:** always define success criteria. Always include a deadline. Flag heavy load on delegate. Never frame delegation as dumping.

---

## End-of-Day Reconciliation

- **Trigger:** user wants to close out the day. Phrases like 'end of day', 'wrap up', 'reconcile today'.
- **Gather context:** active projects and today's tasks via bt_get_projects + bt_search (due: today). Waiting-for items via bt_search (assignee ≠ me). Unprocessed [[Chief of Staff/Inbox]]. Recent [[Chief of Staff/Decisions]]. Today's calendar via the available calendar tools (Local MCP or Composio). Today's daily page content.
- If you don't have enough information, ask questions until you do.
- **Fallback:** if any tool call fails, include section header with '⚠️ Could not retrieve [source]' rather than skipping.
- Ask the user: What did you actually work on today? Anything captured in notes/inbox that needs processing? Any open loops bothering you?
- **Output** — write to today's daily page using roam_batch_write with markdown under an 'End-of-Day Reconciliation' heading. Sections: What Got Done Today (update BT tasks to DONE via bt_modify where confirmed). What Didn't Get Done (and why). Updates Made (projects, waiting-for, decisions, inbox items processed). Open Loops Closed + Open Loops Remaining. Tomorrow Setup: top 3 priorities, first task tomorrow morning, commitments/meetings tomorrow, anything to prep tonight.
- **Tool availability:** works best with Better Tasks + Google Calendar. If BT unavailable, use roam_search_todos to review tasks and roam_modify_todo to mark complete. If calendar unavailable, skip that section. Never fabricate data from unavailable tools.
- End with: 'Tomorrow is set up. Anything else on your mind, capture it now or let it go until morning.'

---

## Excalidraw Diagram

- Generates Excalidraw diagrams and embeds them directly into Roam blocks using the `roam_excalidraw_embed` tool.
- Triggers: "draw a diagram", "excalidraw", "visualize", "architecture diagram", "flowchart", "mind map", "create a diagram", "diagram of", "map of", "sketch"
- Sources
    - roam_excalidraw_embed — embeds Excalidraw JSON into a Roam block as a rendered diagram
    - roam_create_block — creates a target block if needed
    - roam_search — finds existing blocks/pages for context
- Instructions
    - Step 1: Understand the user's request. Identify what should be visualized — architecture, relationships, flow, hierarchy, mind map, etc.
    - Step 2: Gather data if needed. Use roam_search or roam_get_page to pull information from the graph that should appear in the diagram.
    - Step 3: Plan the layout. Choose a layout pattern:
        - **Hub-and-spoke**: Central node with radiating connections (good for showing relationships to a core concept)
        - **Flowchart**: Top-to-bottom or left-to-right with sequential arrows (good for processes)
        - **Grid/Matrix**: Rows and columns (good for categorization)
        - **Hierarchy**: Tree structure (good for org charts, taxonomies)
    - Step 4: Build the Excalidraw JSON. Generate a valid Excalidraw object with these requirements:
        - Top-level structure: `{ "type": "excalidraw", "version": 2, "source": "https://excalidraw.com", "elements": [...], "appState": { "viewBackgroundColor": "#ffffff" }, "files": {} }`
        - **CRITICAL — Bound text elements**: Text inside shapes MUST use the containerId/boundElements binding pattern. For every rectangle (or ellipse/diamond) that should display a label:
            - The shape element must include `"boundElements": [{"id": "<text-element-id>", "type": "text"}]`
            - A separate text element must have `"containerId": "<shape-element-id>"`, `"textAlign": "center"`, `"verticalAlign": "middle"`
        - Do NOT put a `"text"` property directly on rectangle/ellipse/diamond elements — this will NOT render in Roam's Excalidraw.
        - Every element must include all required properties: `id`, `type`, `x`, `y`, `width`, `height`, `angle` (0), `strokeColor`, `backgroundColor`, `fillStyle` ("solid"), `strokeWidth` (2), `strokeStyle` ("solid"), `roughness` (1), `opacity` (100), `seed` (random integer), `version` (1), `versionNonce` (random integer), `isDeleted` (false), `boundElements` (array or null), `updated` (1), `link` (null), `locked` (false), `groupIds` ([]), `frameId` (null)
        - Text elements additionally need: `text`, `fontSize`, `fontFamily` (1), `textAlign`, `verticalAlign`, `containerId` (or null if standalone), `originalText`, `autoResize` (true), `lineHeight` (1.25), `roundness` (null)
        - Arrow elements need: `points` (array of [x,y] offsets), `startBinding` and `endBinding` (with `elementId`, `focus`, `gap`, `fixedPoint`), `startArrowhead` (null), `endArrowhead` ("arrow"), `roundness` ({"type": 2}), `elbowed` (false)
        - Rectangle/ellipse elements need: `roundness` ({"type": 3})
    - Step 5: Use consistent color palette. Recommended Excalidraw pastel fills:
        - Blue: `#a5d8ff`
        - Green: `#b2f2bb`
        - Yellow: `#ffec99`
        - Red/Pink: `#ffc9c9`
        - Purple: `#d0bfff`
        - Light blue (center/primary): `#e7f5ff`
        - Stroke color: `#1e1e1e` (dark) for shapes, `#868e96` (gray) for arrows
    - Step 6: Generate unique IDs. Each element needs a unique `id` string. Use 8-10 random alphanumeric characters. Never reuse IDs across elements.
    - Step 7: Call roam_excalidraw_embed with the complete Excalidraw object and either a `target_uid` (existing block) or `parent_uid` (create new block under a parent). The tool will set the block to `{{excalidraw}}` and store the diagram data in block props.
    - Step 8: Confirm to the user that the diagram has been embedded and tell them the block UID so they can navigate to it.
- Element template reference
    - Rectangle with label: Shape needs `boundElements: [{id: "<text-id>", type: "text"}]`. Text needs `containerId: "<shape-id>"`, `textAlign: "center"`, `verticalAlign: "middle"`. Position text at `x: shape.x+10`, `y: shape.y + shape.height/2 - 10`, `width: shape.width-20`, `height: 20`.
    - Arrow between shapes: Set `points: [[0,0],[dx,dy]]` where dx/dy is the offset from source center to target center. Use `startBinding: {elementId: "<start-id>", focus: 0, gap: 5, fixedPoint: null}` and `endBinding` similarly. Set `endArrowhead: "arrow"`.

---

## Follow-up Drafter

- **Trigger:** user asks to follow up on a waiting-for item, 'nudge [person] about [thing]', 'draft a follow-up', 'chase up [task]'. Also triggered when other skills surface stale delegations.
- If user doesn't specify who/what, search for stale waiting-for items via bt_search (assignee ≠ me, status: TODO/DOING) and present candidates.
- **Sources:** bt_search for the specific task being followed up. the available calendar tools (Local MCP or Composio) for meetings with the person. roam_search_text or roam_get_backlinks for recent interactions. [[Chief of Staff/Memory]] for communication preferences.
- **Output:** Context summary (what was delegated, when, days waiting). Suggested approach (channel + tone based on wait time and relationship). Draft message (short, specific, easy to reply to — includes what was asked, when, what's needed, suggested deadline). Alternative approach (escalation path if overdue >14 days).
- **Routing:** create follow-up BT task via bt_create with due date today/tomorrow. Update original task via bt_modify if needed. If upcoming meeting exists, suggest adding to meeting prep instead.
- **Tool availability:** works best with Better Tasks (delegation tracking) + Google Calendar. If BT unavailable, use roam_search_todos to find TODO items mentioning the person. Never fabricate data from unavailable tools.
- **Rules:** default tone is friendly and professional, never passive-aggressive. Always include specific context — no vague 'just checking in'. Make it easy to respond (yes/no question or clear next step). Flag items waiting >14 days. Never send messages without explicit confirmation.

---

## Intention Clarifier

- **Trigger:** user expresses a vague intention, nagging thought, or half-formed idea that needs clarifying before action.
- If you don't have enough information, ask questions until you do.
- **Phase 1 — Reflect back:** the core desire, the underlying tension or problem, 2–3 possible goals hiding in this. Ask: 'Is any of this wrong or missing something important?'
- **Phase 2 — Targeted questions** (ask up to 7 relevant ones): Clarifying the WHAT (if resolved, what would be different? starting/changing/stopping? multiple things tangled?). Clarifying the WHY (why now? cost of inaction? want vs. should?). Clarifying the HOW (already tried? what would make it easy? scariest part?). Clarifying CONSTRAINTS (good enough? can't change? deadline?).
- **Clarified output:** The Real Goal (one clear sentence). Why This, Why Now. What Success Looks Like. What's Actually In the Way. The First Concrete Step (next 24 hours). What This Unlocks.
- **Routing:** Ready to act → bt_create (or roam_create_todo) with due date today/tomorrow. Needs breakdown → run Brain Dump. Needs delegation → bt_create with assignee (or roam_create_todo). Needs more thinking → bt_create 'Think through [topic]' + add to [[Chief of Staff/Inbox]]. Not important → confirm with user, then drop.
- **Tool availability:** this skill is primarily Roam-native. Better Tasks enhances routing with richer task creation. If BT unavailable, use roam_create_todo. Never fabricate data from unavailable tools.
- If still stuck: What would need to be true for this to feel clear? Is this actually one thing or multiple? What are you afraid of discovering?

---

## Mermaid Diagram

- Generates Mermaid diagrams and embeds them directly into Roam blocks using the `roam_mermaid_embed` tool.
- Triggers: "mermaid diagram", "mermaid", "flowchart", "sequence diagram", "gantt chart", "class diagram", "state diagram", "er diagram", "mindmap", "timeline", "draw a chart"
- Sources
    - roam_mermaid_embed — embeds Mermaid code into a Roam block as a rendered diagram
    - roam_create_block — creates a target block if needed
    - roam_search — finds existing blocks/pages for context
- Instructions
    - Step 1: Understand the user's request. Identify the diagram type that best fits:
        - `graph TD` or `graph LR` — general flowcharts (top-down or left-right)
        - `sequenceDiagram` — interactions between actors over time
        - `classDiagram` — classes, properties, and relationships
        - `stateDiagram-v2` — state machines and transitions
        - `erDiagram` — entity-relationship models
        - `gantt` — project timelines
        - `mindmap` — hierarchical brainstorms
        - `timeline` — chronological events
        - `flowchart TD` — enhanced flowchart with subgraphs
    - Step 2: Gather data if needed. Use roam_search or roam_get_page to pull information from the graph that should appear in the diagram.
    - Step 3: Write valid Mermaid syntax. Key rules:
        - First line must be the diagram type declaration (e.g. `graph TD`, `sequenceDiagram`)
        - Node IDs must be alphanumeric (no spaces or special chars in IDs)
        - Use square brackets for box nodes: `A[Label Text]`
        - Use round brackets for rounded nodes: `A(Label Text)`
        - Use curly braces for diamond/decision nodes: `A{Label Text}`
        - Use `-->` for arrows, `---` for lines, `-.->` for dotted arrows
        - Use `-->|label|` for labeled edges
        - Use `subgraph Title ... end` to group nodes
        - Use `style` or `classDef` for colors: `style A fill:#a5d8ff,stroke:#1e1e1e`
        - Each connection or declaration should be on its own line
        - Do NOT wrap in 
          ```mermaid fences — pass raw Mermaid code to the tool
    - Step 4: Call roam_mermaid_embed with the mermaid_code string and either target_uid or parent_uid. The tool handles splitting lines into child blocks and setting the block to {{mermaid}}.
    - Step 5: Confirm to the user that the diagram has been embedded and tell them the block UID.
- Recommended color palette for styled nodes:
    - Blue: `fill:#a5d8ff,stroke:#1e1e1e,color:#1e1e1e`
    - Green: `fill:#b2f2bb,stroke:#1e1e1e,color:#1e1e1e`
    - Yellow: `fill:#ffec99,stroke:#1e1e1e,color:#1e1e1e`
    - Red/Pink: `fill:#ffc9c9,stroke:#1e1e1e,color:#1e1e1e`
    - Purple: `fill:#d0bfff,stroke:#1e1e1e,color:#1e1e1e`
    - Light blue: `fill:#e7f5ff,stroke:#1e1e1e,color:#1e1e1e`

---

## Project Status

- **Trigger:** user asks for a project status update. If a project is named, report on that one. If none specified, report on all active projects.
- **Sources:** bt_get_projects (status: active, include_tasks: true). bt_search by project for open tasks, completed tasks, overdue items, delegated items. [[Chief of Staff/Decisions]] for project-related decisions. the available calendar tools (Local MCP or Composio) for upcoming project meetings.
- **Fallback:** if any tool call fails, include section header with '⚠️ Could not retrieve [source]' rather than skipping.
- Write output to today's daily page using roam_batch_write with markdown under a 'Project Status — [NAME]' heading.
- **Output sections:** Status at a Glance (ON TRACK / AT RISK / BLOCKED / COMPLETED + confidence level). Recent Progress (past 7 days). Current Focus (active work, next steps, target dates). Blockers and Risks. Resource Status. Upcoming Milestones (next 3–5 with dates). Decisions Needed. Attention Required.
- **Tool availability:** works best with Better Tasks (project tracking, task counts) + Google Calendar. If BT unavailable, use roam_search_todos and roam_search_text for project-related blocks. Never fabricate data from unavailable tools.
- **Rules:** base assessment on documented evidence only. Flag outdated (30+ day) sources with [STALE]. Distinguish documented facts from inferences. Don't minimise risks. Include 'Last updated' dates for sources.

---

## Retrospective

- **Trigger:** a project completed, milestone reached, or something went wrong and user wants to learn from it. Phrases like 'retro on [project]', 'post-mortem', 'what did we learn from [X]'.
- This is event-triggered and deeper than Weekly Review. Looks at a specific project/event holistically.
- If user doesn't specify what to retrospect on, ask.
- **Sources:** bt_search by project for completed/open/cancelled tasks. bt_get_projects for metadata. [[Chief of Staff/Decisions]] for project decisions. roam_search for project references. the available calendar tools (Local MCP or Composio) for timeline reconstruction.
- Write output to today's daily page using roam_batch_write with markdown under a 'Retrospective — [PROJECT/EVENT]' heading.
- **Output:** Timeline (key milestones and dates). What Went Well. What Didn't Go Well. Key Decisions Reviewed (which held up? which would you change?). What Was Dropped (cancelled items — right call?). Lessons to Carry Forward (3–5 concrete, actionable). Unfinished Business (open tasks, loose ends — continue, delegate, or drop?).
- **Routing:** lessons → [[Chief of Staff/Memory]]. Unfinished items to continue → bt_create / bt_modify (or roam_create_todo). Items to delegate → run Delegation skill. Decision revisions → [[Chief of Staff/Decisions]]. Complete project → suggest updating status via bt_modify.
- **Tool availability:** works best with Better Tasks (project history, task status tracking) + Google Calendar. If BT unavailable, use roam_search_todos and roam_search_text for project-related blocks. Never fabricate data from unavailable tools.
- **Rules:** be honest, not kind — retros are for learning. Lessons must be specific and actionable. Distinguish systemic issues from one-off problems. Base claims on evidence, mark inferences with [INFERRED]. If documentation is sparse, say so.

---

## Template Instantiation

- **Trigger:** user asks to create something from a template. Phrases like 'create a new project from my template', 'stamp out [template name]', 'use my [X] template'.
- **Process:** ask which template page to use (or suggest from known template pages in the graph). Read the template page via roam_fetch_page. Ask the user for variable values (project name, dates, people, etc.). Create a new page with the template structure, replacing variables.
- **Output:** new page created with filled-in template. Summary of what was created and any variables that weren't filled.
- **Tool availability:** this skill is primarily Roam-native (page reads + block creation). Better Tasks enhances it by auto-creating tasks found in the template. If BT unavailable, tasks in templates become plain {{[[TODO]]}} blocks via roam_create_todo. Never fabricate data from unavailable tools.
- **Rules:** never modify the source template page. Always confirm variable substitutions before creating. Preserve the template's structure exactly — only replace marked variables.

---

## Weekly Planning

- **Trigger:** user asks for planning or prioritisation for the week.
- **Approach:** gather upcoming tasks via bt_search (due: this-week and upcoming), overdue tasks via bt_search (due: overdue), active projects via bt_get_projects (status: active, include_tasks: true), and calendar commitments via the available calendar tools (Local MCP or Composio) for next 7 days. Check for stale delegations. 'Blockers' means: overdue tasks, waiting-for with no response, unresolved decisions, external dependencies.
- Write output to today's daily page using roam_batch_write with markdown under a 'Weekly Plan' heading.
- **Output sections:** This Week's Outcomes (3–5 concrete, tied to projects). Priority Actions (sequenced with due dates, urgency then importance). Blockers & Waiting-For (who owns them, suggested nudge/escalation). Calendar Load (meeting hours, flag days >4 hours as capacity-constrained). Not This Week (explicit deprioritisations with rationale). Monday First Action (single task to start with).
- **Tool availability:** works best with Better Tasks + Google Calendar. If BT unavailable, use roam_search_todos for open tasks and skip project/delegation analysis. If calendar unavailable, skip Calendar Load section. Never fabricate data from unavailable tools.
- Keep each section concise. Prefer tool calls over guessing.
