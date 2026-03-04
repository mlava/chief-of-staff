# Excalidraw Diagram

Skill for the Chief of Staff/Skills page. Copy the content below into a top-level block named **Excalidraw Diagram** on your `Chief of Staff/Skills` page, with each `- ` line as a child block.

---

## Skill block structure (paste into Roam)

**Top-level block:** `Excalidraw Diagram`

**Children:**

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
- Element template reference (for quick copy when building JSON):
  - Rectangle with label:
    ```
    Shape: { id, type: "rectangle", x, y, width, height, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "<color>", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, roundness: {type:3}, seed, version: 1, versionNonce, isDeleted: false, boundElements: [{id: "<text-id>", type: "text"}], updated: 1, link: null, locked: false, groupIds: [], frameId: null }
    Text: { id, type: "text", x: shape.x+10, y: shape.y + shape.height/2 - 10, width: shape.width-20, height: 20, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, roundness: null, seed, version: 1, versionNonce, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, text: "<label>", fontSize: 16, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: "<shape-id>", originalText: "<label>", autoResize: true, lineHeight: 1.25, groupIds: [], frameId: null }
    ```
  - Arrow between shapes:
    ```
    { id, type: "arrow", x: startCenterX, y: startCenterY, width: abs(dx), height: abs(dy), angle: 0, strokeColor: "#868e96", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, roundness: {type:2}, seed, version: 1, versionNonce, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, points: [[0,0],[dx,dy]], startBinding: {elementId: "<start-shape-id>", focus: 0, gap: 5, fixedPoint: null}, endBinding: {elementId: "<end-shape-id>", focus: 0, gap: 5, fixedPoint: null}, lastCommittedPoint: null, startArrowhead: null, endArrowhead: "arrow", groupIds: [], frameId: null, elbowed: false }
    ```
