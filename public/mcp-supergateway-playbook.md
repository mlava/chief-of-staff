# MCP → Supergateway → Roam Extension Playbook

This guide covers getting local MCP servers running as SSE endpoints accessible from Chief of Staff in Roam Research. It works on **macOS, Linux, and Windows**.

---

## Overview

Many MCP servers communicate over **stdio** (stdin/stdout). Browsers — including the Roam desktop app — cannot speak stdio directly. **Supergateway** bridges this gap by wrapping each stdio MCP server and exposing it as an HTTP/SSE endpoint.

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

- **Node.js** installed (via nvm, system install, or the Node.js installer)
- **MCP servers already configured** and working in Claude Desktop (`claude_desktop_config.json`)
- **One of:** macOS, Linux, or Windows

---

## Automated Setup (Recommended)

Chief of Staff includes a built-in script generator that reads your Claude Desktop MCP configuration and produces a platform-specific install script.

### Step 1: Generate the Script

1. Open Roam → Command Palette → **Chief of Staff: Create MCP Script**
2. COS reads your `claude_desktop_config.json`, finds all stdio MCP servers, assigns ports (starting from 8001), and detects your operating system
3. A dialog appears showing the servers found, assigned ports, and setup instructions for your platform
4. Click **Download Script** to save it, or **Copy Script** to clipboard

### Step 2: Run the Script

**macOS / Linux:**
```bash
chmod +x ~/Downloads/start-mcp.sh
~/Downloads/start-mcp.sh
```

**Windows (PowerShell):**
```powershell
# If needed first: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Right-click start-mcp.ps1 → Run with PowerShell
```

The script automatically:
- Detects your node/npx paths (and uvx if any servers need it)
- Installs supergateway globally if not present
- Stops any previously created COS supergateway services
- Creates persistent services for each MCP server:
  - **macOS:** LaunchAgents in `~/Library/LaunchAgents/com.cos.supergateway.*.plist`
  - **Linux:** systemd user services in `~/.config/systemd/user/cos-supergateway-*.service` (with lingering enabled)
  - **Windows:** Scheduled Tasks under `\COS\` in Task Scheduler
- Starts all services immediately
- Prints a summary with URLs and the ports string to paste into settings

### Step 3: Connect in COS

1. Click **Set Ports in Settings** in the dialog (or manually enter the comma-separated port numbers in COS settings → Local MCP Server Ports)
2. Command Palette → **Chief of Staff: Connect Local MCP**
3. Verify: toast should show each server's name and tool count

### What the Persistent Services Do

All three platforms create services that:
- **Start on boot/login** — no manual action needed after a reboot
- **Auto-restart on crash** — if the server process dies, it comes back within seconds
- **Log to /tmp** (macOS/Linux) or `%TEMP%\cos-mcp` (Windows) — check these if a server fails to start

---

## Verifying the Setup

### Check ports are listening

**macOS / Linux:**
```bash
lsof -i :8001 -i :8002 -i :8003
```

> macOS maps some port numbers to obscure service names (`vcom-tunnel`, `teradataordbms`). This is cosmetic — the ports are functioning normally.

**Windows (PowerShell):**
```powershell
Get-NetTCPConnection -LocalPort 8001,8002,8003 -ErrorAction SilentlyContinue
```

### Check logs if something fails

**macOS / Linux:**
```bash
cat /tmp/cos-mcp-servername.err
cat /tmp/cos-mcp-servername.log
```

**Windows:**
```powershell
Get-Content "$env:TEMP\cos-mcp\cos-sg-servername.ps1"   # wrapper script
# Also: Task Scheduler → \COS\ → right-click task → View History
```

### Common failure causes
- Wrong binary path → `No such file or directory`
- `--stdio` not wrapped in `/bin/sh -c` → `EX_CONFIG (exit code 78)` (macOS/Linux)
- Port already in use → another server or previous run still bound to that port
- uvx not installed → servers that use `uvx` commands will be skipped (with a warning)

---

## Quick Reference

### Managing Services

**macOS (LaunchAgents):**

| Action | Command |
|--------|---------|
| List COS services | `launchctl print gui/$(id -u) \| grep cos.supergateway` |
| Status | `launchctl print gui/$(id -u)/com.cos.supergateway.servername` |
| Restart | `launchctl kickstart -kp gui/$(id -u)/com.cos.supergateway.servername` |
| Stop & unload | `launchctl bootout gui/$(id -u)/com.cos.supergateway.servername` |
| Re-load after edit | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cos.supergateway.servername.plist` |

**Linux (systemd):**

| Action | Command |
|--------|---------|
| List COS services | `systemctl --user list-units 'cos-supergateway-*'` |
| Status | `systemctl --user status cos-supergateway-servername` |
| Restart | `systemctl --user restart cos-supergateway-servername` |
| Stop | `systemctl --user stop cos-supergateway-servername` |
| Logs (journalctl) | `journalctl --user -u cos-supergateway-servername -f` |

**Windows (Task Scheduler):**

| Action | Command |
|--------|---------|
| List COS tasks | `Get-ScheduledTask -TaskPath '\COS\'` |
| Start | `Start-ScheduledTask -TaskPath '\COS\' -TaskName 'cos-sg-servername'` |
| Stop | `Stop-ScheduledTask -TaskPath '\COS\' -TaskName 'cos-sg-servername'` |
| Remove | `Unregister-ScheduledTask -TaskPath '\COS\' -TaskName 'cos-sg-servername'` |

### Log locations

| Platform | stdout | stderr |
|----------|--------|--------|
| macOS | `/tmp/cos-mcp-servername.log` | `/tmp/cos-mcp-servername.err` |
| Linux | `/tmp/cos-mcp-servername.log` (also journalctl) | `/tmp/cos-mcp-servername.err` |
| Windows | `%TEMP%\cos-mcp\` | Task Scheduler History |

---

## Manual Setup

If you prefer not to use the automated script, or need to set up a single server manually, follow these steps.

### 1. Find your binary paths

Service managers don't inherit your shell PATH, so you need absolute paths.

```bash
which node   # e.g. /Users/yourname/.nvm/versions/node/v20.19.0/bin/node
which npx    # e.g. /Users/yourname/.nvm/versions/node/v20.19.0/bin/npx
which uvx    # e.g. /opt/homebrew/bin/uvx  (if using uv-based servers)
```

### 2. Install supergateway

```bash
npm install -g supergateway
```

### 3. Test manually first

The `--cors` flag is required for browser-based clients like Roam.

```bash
npx -y supergateway --port 8001 --cors --stdio "npx -y your-mcp-server"
```

You should see:
```
[supergateway] Listening on port 8001
[supergateway] SSE endpoint: http://localhost:8001/sse
[supergateway] POST messages: http://localhost:8001/message
```

### 4. Create a persistent service

Choose the section for your platform:

#### macOS — LaunchAgent plist

```bash
mkdir -p ~/Library/LaunchAgents
```

Create `~/Library/LaunchAgents/com.cos.supergateway.servername.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cos.supergateway.servername</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>/path/to/npx supergateway --port 8001 --cors --stdio "/path/to/npx -y your-mcp-server"</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/path/to/nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/cos-mcp-servername.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/cos-mcp-servername.err</string>
</dict>
</plist>
```

> **Important:** The `--stdio` value must be a single shell string with the full command inside quotes. The `/bin/sh -c` wrapper handles the shell interpretation.

Load and start:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cos.supergateway.servername.plist
launchctl kickstart -kp gui/$(id -u)/com.cos.supergateway.servername
```

#### Linux — systemd user service

```bash
mkdir -p ~/.config/systemd/user
```

Create `~/.config/systemd/user/cos-supergateway-servername.service`:

```ini
[Unit]
Description=COS MCP: Server Name
After=network.target

[Service]
Type=simple
ExecStart=/bin/sh -c '/path/to/npx supergateway --port 8001 --cors --stdio "/path/to/npx -y your-mcp-server"'
Restart=always
RestartSec=5
Environment=PATH=/path/to/node/bin:/usr/local/bin:/usr/bin:/bin
StandardOutput=file:/tmp/cos-mcp-servername.log
StandardError=file:/tmp/cos-mcp-servername.err

[Install]
WantedBy=default.target
```

Enable and start:
```bash
systemctl --user daemon-reload
systemctl --user enable cos-supergateway-servername
systemctl --user start cos-supergateway-servername
loginctl enable-linger $(whoami)   # services persist after logout
```

#### Windows — Task Scheduler

Create a wrapper script `start-mcp-servername.ps1`:
```powershell
$env:YOUR_API_KEY = "your-value"
& npx supergateway --port 8001 --cors --stdio "npx -y your-mcp-server"
```

Register as a scheduled task (run in PowerShell):
```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File C:\path\to\start-mcp-servername.ps1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) `
    -ExecutionTimeLimit (New-TimeSpan -Days 365)
Register-ScheduledTask -TaskName "cos-sg-servername" -TaskPath "\COS\" `
    -Action $action -Trigger $trigger -Settings $settings `
    -Description "COS MCP: Server Name"
Start-ScheduledTask -TaskPath "\COS\" -TaskName "cos-sg-servername"
```

### 5. Connect in COS settings

Enter the port number(s) in COS settings → Local MCP Server Ports, then use the **Connect Local MCP** command.

---

## Notes

- **CORS:** The `--cors` flag on supergateway is required for browser-based clients. Without it all requests will be blocked.
- **nvm paths:** If using nvm, binary paths are version-specific (e.g. `/Users/yourname/.nvm/versions/node/v20.19.0/bin/npx`). The automated script detects these automatically; for manual setup, run `which npx` to confirm.
- **Stale connections:** If running test code in the Roam console multiple times, reload the page (`Cmd+R` / `Ctrl+R`) before re-running to clear stale EventSource connections that can intercept new sessions.
- **Session IDs:** Each SSE connection gets a unique session ID. You must POST to the same port and session ID — mixing ports and session IDs causes 503 errors.
- **Warm-up:** Supergateway takes ~3 seconds to start the underlying MCP server process on first connection. The initial `ERR_EMPTY_RESPONSE` is normal and the connection retries automatically.
