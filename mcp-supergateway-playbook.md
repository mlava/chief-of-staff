# MCP → Supergateway → Roam Extension Playbook

This guide covers everything from having MCP servers configured in Claude desktop to exposing them as SSE endpoints accessible from a Roam Research extension.

---

## Overview

Claude's MCP servers communicate over **stdio** (stdin/stdout). Browsers — including the Roam desktop app — cannot speak stdio directly. **Supergateway** bridges this gap by wrapping each stdio MCP server and exposing it as an HTTP/SSE endpoint.

```
Claude MCP config (stdio)
        ↓
   Supergateway
        ↓
  HTTP SSE endpoint (localhost:800x)
        ↓
  Roam extension (EventSource + fetch)
```

---

## Prerequisites

- Node.js installed via **nvm** (or system node)
- MCP servers already configured and working in Claude desktop
- macOS (this guide uses LaunchAgents for boot persistence)

---

## Step 1: Find Your Binary Paths

LaunchAgents do not inherit your shell PATH, so you need absolute paths to all binaries.

```bash
which node   # e.g. /Users/yourname/.nvm/versions/node/v20.19.0/bin/node
which npx    # e.g. /Users/yourname/.nvm/versions/node/v20.19.0/bin/npx
which uvx    # e.g. /opt/homebrew/bin/uvx  (if using uv-based servers)
```

Note these down — you will use them in every plist.

---

## Step 2: Install Supergateway

```bash
npm install -g supergateway
```

### Verify it works manually first

Before creating any LaunchAgent, test each server manually. The `--cors` flag is required for browser-based clients like Roam.

```bash
/Users/yourname/.nvm/versions/node/v20.19.0/bin/npx -y supergateway \
  --port 8001 \
  --cors \
  --stdio "/Users/yourname/.nvm/versions/node/v20.19.0/bin/npx -y your-mcp-server"
```

You should see:
```
[supergateway] Listening on port 8001
[supergateway] SSE endpoint: http://localhost:8001/sse
[supergateway] POST messages: http://localhost:8001/message
```

---

## Step 3: Assign Ports

Each MCP server gets its own port. Choose a range that doesn't conflict with other local services — 8001–8009 works well.

| Server | Port |
|--------|------|
| your-server-1 | 8001 |
| your-server-2 | 8002 |
| your-server-3 | 8003 |

---

## Step 4: Create LaunchAgent Plists

LaunchAgents live in `~/Library/LaunchAgents/`. This folder may be hidden in Finder — use **Cmd+Shift+G** and type `~/Library/LaunchAgents` to navigate to it, or use the terminal.

```bash
mkdir -p ~/Library/LaunchAgents
```

Create one plist per server. The key requirements are:

- Use `/bin/sh -c` as the program so the `--stdio` argument is interpreted as a shell command
- Use **absolute paths** for all binaries
- Set `KeepAlive` to true so the service restarts if it crashes
- Pass `ROAM_API_TOKEN`, `PATH`, and any other required env vars explicitly

### Template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yourname.supergateway.servername</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>/path/to/npx -y supergateway --port 8001 --cors --stdio "/path/to/npx -y your-mcp-server"</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>YOUR_ENV_VAR</key>
        <string>your-value</string>
        <key>PATH</key>
        <string>/path/to/nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/supergateway-servername.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/supergateway-servername.err</string>
</dict>
</plist>
```

> **Important:** The `--stdio` value must be a single shell string with the full command inside quotes, not split into separate array elements. The `/bin/sh -c` wrapper handles the shell interpretation.

---

## Step 5: Load the LaunchAgents

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yourname.supergateway.servername.plist
```

Then kick it to start immediately (it may be in `spawn scheduled` state):

```bash
launchctl kickstart -kp gui/$(id -u)/com.yourname.supergateway.servername
```

### Verify it loaded

```bash
launchctl print gui/$(id -u)/com.yourname.supergateway.servername | head -20
```

Look for `program = /bin/sh` and `state = running`.

### Verify ports are listening

```bash
lsof -i :8001 -i :8002 -i :8003
```

> macOS maps some port numbers to obscure service names (`vcom-tunnel`, `teradataordbms`). This is cosmetic — the ports are functioning normally.

### Check logs if something fails

```bash
cat /tmp/supergateway-servername.err
cat /tmp/supergateway-servername.log
```

Common failure causes:
- Wrong binary path → `No such file or directory`
- `--stdio` not wrapped in `/bin/sh -c` → `EX_CONFIG (exit code 78)`
- Server already registered → `Bootstrap failed: 5` (bootout first)

---

## Step 6: Reload After Config Changes

```bash
# Unload
launchctl bootout gui/$(id -u)/com.yourname.supergateway.servername

# Re-load
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yourname.supergateway.servername.plist

# Kick
launchctl kickstart -kp gui/$(id -u)/com.yourname.supergateway.servername
```

---

## Step 7: Test from the Roam Dev Console

Open Roam, press **F12** to open the dev console, and paste:

```javascript
const port = 8001;
const source = new EventSource(`http://localhost:${port}/sse`);
let sessionId;
source.addEventListener('endpoint', (e) => {
  sessionId = new URL(`http://localhost:${port}` + e.data).searchParams.get('sessionId');
  console.log('Got session:', sessionId);
  fetch(`http://localhost:${port}/message?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  }).then(r => console.log('POST status:', r.status));
});
source.onmessage = (e) => console.log('Response:', JSON.parse(e.data));
source.onerror = (e) => console.error('SSE error:', e);
```

Expected output:
```
Got session: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
POST status: 202
Response: {result: {tools: Array(n)}, jsonrpc: '2.0', id: 1}
```

> An initial `ERR_EMPTY_RESPONSE` on first connection is normal — the server takes ~3 seconds to warm up and the connection recovers automatically.

> **Important:** Each SSE connection generates a session ID that is only valid while that connection is open. Always use the session ID from the current connection when posting messages.

---

## Step 8: Server Discovery Function

Use this in your extension to discover all running servers and their tools dynamically. Each MCP server self-identifies via the `initialize` handshake — no hardcoded names needed.

```javascript
async function discoverServer(port) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(`port ${port} timed out`), 15000);
    let sessionId, serverInfo, settled = false;

    function done(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    function tryConnect() {
      const source = new EventSource(`http://localhost:${port}/sse`);

      source.addEventListener('endpoint', async (e) => {
        sessionId = new URL(`http://localhost:${port}` + e.data).searchParams.get('sessionId');
        await fetch(`http://localhost:${port}/message?sessionId=${sessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'your-extension', version: '1.0' }
            }
          })
        });
      });

      source.onmessage = async (e) => {
        const data = JSON.parse(e.data);
        if (data.id === 1 && data.result?.serverInfo) {
          serverInfo = data.result.serverInfo;
          await fetch(`http://localhost:${port}/message?sessionId=${sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
          });
        }
        if (data.id === 2 && data.result?.tools) {
          source.close();
          done({
            port,
            server: {
              name: serverInfo?.name,
              version: serverInfo?.version,
            },
            tools: data.result.tools.map(t => ({
              name: t.name,
              description: t.description,
              params: Object.entries(t.inputSchema?.properties || {}).map(([name, schema]) => ({
                name,
                type: schema.type,
                description: schema.description,
                required: (t.inputSchema?.required || []).includes(name),
              }))
            }))
          });
        }
      };

      source.onerror = () => {
        source.close();
        if (!settled) setTimeout(tryConnect, 3000);
      };
    }

    tryConnect();
  });
}

// Discover all servers
const ports = [8001, 8002, 8003];
const results = await Promise.allSettled(ports.map(discoverServer));
console.log(JSON.stringify(
  results.filter(r => r.status === 'fulfilled').map(r => r.value),
  null, 2
));
```

The discovery function:
- Connects via SSE
- Sends `initialize` to get the server's name and version
- Sends `tools/list` to get all tools with descriptions and parameter schemas
- Retries automatically on the initial warm-up error
- Closes the connection cleanly when done

Each tool in the result looks like:
```json
{
  "name": "formatCitation",
  "description": "Format academic citations from identifiers...",
  "params": [
    { "name": "text", "type": "string", "description": "...", "required": true },
    { "name": "style", "type": "string", "description": "...", "required": false }
  ]
}
```

---

## Step 9: Calling a Tool

Each tool call requires its own SSE connection with a fresh session ID.

```javascript
async function callTool(port, toolName, args) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(`tool call timed out`), 15000);
    let sessionId, settled = false;

    function done(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    }

    function tryConnect() {
      const source = new EventSource(`http://localhost:${port}/sse`);

      source.addEventListener('endpoint', async (e) => {
        sessionId = new URL(`http://localhost:${port}` + e.data).searchParams.get('sessionId');

        // Initialize first
        await fetch(`http://localhost:${port}/message?sessionId=${sessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'your-extension', version: '1.0' }
            }
          })
        });
      });

      source.onmessage = async (e) => {
        const data = JSON.parse(e.data);

        // After initialize, call the tool
        if (data.id === 1) {
          await fetch(`http://localhost:${port}/message?sessionId=${sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 2, method: 'tools/call',
              params: { name: toolName, arguments: args }
            })
          });
        }

        // Return the tool result
        if (data.id === 2) {
          source.close();
          done(data.result);
        }
      };

      source.onerror = () => {
        source.close();
        if (!settled) setTimeout(tryConnect, 3000);
      };
    }

    tryConnect();
  });
}

// Example: format a citation
const result = await callTool(8003, 'formatCitation', {
  text: '10.1056/nejmoa2033700',
  style: 'apa'
});
console.log(result);
```

---

## Quick Reference

### LaunchAgent commands

| Action | Command |
|--------|---------|
| Load | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.x.plist` |
| Start | `launchctl kickstart -kp gui/$(id -u)/com.x.service` |
| Stop & unload | `launchctl bootout gui/$(id -u)/com.x.service` |
| Status | `launchctl print gui/$(id -u)/com.x.service` |
| List all | `launchctl print gui/$(id -u) \| grep supergateway` |

### Ports

| What | Port | SSE URL |
|------|------|---------|
| Your server 1 | 8001 | `http://localhost:8001/sse` |
| Your server 2 | 8002 | `http://localhost:8002/sse` |
| Your server 3 | 8003 | `http://localhost:8003/sse` |

### Logs

```bash
cat /tmp/supergateway-servername.log   # stdout
cat /tmp/supergateway-servername.err   # stderr
```

---

## Notes

- **CORS:** The `--cors` flag on supergateway is required for browser-based clients. Without it all requests will be blocked.
- **nvm paths:** If using nvm, binary paths are version-specific (e.g. `/Users/yourname/.nvm/versions/node/v20.19.0/bin/npx`). Run `which npx` to confirm.
- **Stale connections:** If running test code in the Roam console multiple times, reload the page (`Cmd+R`) before re-running to clear stale EventSource connections that can intercept new sessions.
- **Session IDs:** Each SSE connection gets a unique session ID. You must POST to the same port and session ID — mixing ports and session IDs causes 503 errors.
- **Warm-up:** Supergateway takes ~3 seconds to start the underlying MCP server process on first connection. The initial `ERR_EMPTY_RESPONSE` is normal and the connection retries automatically.
