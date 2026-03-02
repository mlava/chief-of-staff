/**
 * parse-utils.js — Pure parsing utilities extracted for testability.
 * No runtime dependencies (no DOM, no Roam API, no injected deps).
 */

/**
 * Extract all top-level balanced JSON objects from a string.
 * Used to detect Gemini concatenating multiple tool calls' arguments into one slot.
 * Returns array of { parsed, start, end } for each valid JSON object found.
 */
export function extractBalancedJsonObjects(raw) {
  if (!raw || typeof raw !== "string") return [];
  const trimmed = raw.trim();
  const results = [];
  let pos = 0;
  while (pos < trimmed.length) {
    // Skip to next '{'
    while (pos < trimmed.length && trimmed[pos] !== "{") pos++;
    if (pos >= trimmed.length) break;
    let depth = 0, inString = false, escape = false;
    let foundEnd = false;
    for (let i = pos; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(trimmed.slice(pos, i + 1));
            results.push({ parsed, start: pos, end: i + 1 });
          } catch { /* skip malformed */ }
          pos = i + 1;
          foundEnd = true;
          break;
        }
      }
    }
    if (!foundEnd) break; // unbalanced, stop
  }
  return results;
}

/**
 * Extract a compact key reference from MCP tool result texts.
 * Scans for "Name (Key: XYZ)" or "Key: XYZ" patterns and builds a
 * compact lookup table that gets appended to the conversation turn.
 */
export function extractMcpKeyReference(mcpResultTexts) {
  if (!Array.isArray(mcpResultTexts) || mcpResultTexts.length === 0) return "";
  const entries = [];
  const seen = new Set();
  for (const text of mcpResultTexts) {
    if (!text) continue;
    // Match patterns like: **Name** (Key: ABC123) or (Key: ABC123) or Key: ABC123
    const keyPattern = /\*{0,2}([^*\n(]+?)\*{0,2}\s*\(Key:\s*([A-Za-z0-9]+)\)/g;
    let match;
    while ((match = keyPattern.exec(text)) !== null) {
      const name = match[1].trim().replace(/^[-*\s]+/, "");
      const key = match[2];
      const id = `${name}::${key}`;
      if (!seen.has(id) && name && key) {
        seen.add(id);
        entries.push(`${name} → ${key}`);
      }
    }
    // Also match "Item Key: XYZ" with nearby title (cap name to 200 chars to limit backtracking)
    const itemKeyPattern = /\*\*(?:Title|Name):\*\*\s*(.{1,200}?)[\n\r].*?\*\*(?:Item Key|Key):\*\*\s*`?([A-Za-z0-9]+)`?/g;
    while ((match = itemKeyPattern.exec(text)) !== null) {
      const name = match[1].trim();
      const key = match[2];
      const id = `${name}::${key}`;
      if (!seen.has(id) && name && key) {
        seen.add(id);
        entries.push(`${name} → ${key}`);
      }
    }
  }
  if (entries.length === 0) return "";
  // Cap at 50 entries — raised from 30 to preserve subcollection keys
  // for libraries like Zotero with 80+ collections
  const capped = entries.slice(0, 50);
  return `[Key reference: ${capped.join("; ")}]`;
}
