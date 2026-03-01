// supergateway-script.js — Platform-specific install script generator for Local MCP servers
// Generates bash (macOS LaunchAgents / Linux systemd) or PowerShell (Windows Task Scheduler)
// scripts that wrap stdio MCP servers in supergateway SSE proxies.
//
// DI: call buildSupergatewayScript({ validEntries, warnings, ports, platform })
// Returns: { script, portsList, setupStepsHtml, scriptExt, platform }

// --- Shared helper: build the stdio command string for an entry ---
function buildStdioCmd(entry) {
  const { command, args } = entry;
  const isUvx = command === "uvx";
  const parts = isUvx ? args : [command, ...args];
  return parts.map(a => {
    if (/[\s"'\\$`!#&|;()<>]/.test(String(a))) {
      return '"' + String(a).replace(/["\\$`]/g, "\\$&") + '"';
    }
    return String(a);
  }).join(" ");
}

// ================================================================
// macOS script generator (LaunchAgents + launchctl)
// ================================================================
function buildMacosScript(validEntries, warnings, ports, needsUvx) {
  const L = [];
  L.push("#!/bin/bash");
  L.push("set -e");
  L.push("");
  L.push('echo "Chief of Staff — MCP Installer (macOS)"');
  L.push('echo "========================================="');
  L.push('echo ""');
  L.push("");

  // Node / npx detection
  L.push("# ── Detect node / npx ─────────────────────────────────────────────");
  L.push('NODE_BIN="$(which npx 2>/dev/null | xargs dirname)"');
  L.push('NPX="$NODE_BIN/npx"');
  L.push("");
  L.push('if [ -z "$NODE_BIN" ]; then');
  L.push('  echo "Node.js not found. Please install Node.js first: https://nodejs.org"');
  L.push("  exit 1");
  L.push("fi");
  L.push('echo "Node found at: $NODE_BIN"');
  L.push('echo ""');
  L.push("");

  // Supergateway install
  L.push("# ── Install supergateway if missing ────────────────────────────────");
  L.push("if ! command -v supergateway &> /dev/null; then");
  L.push('  echo "Installing supergateway..."');
  L.push("  npm install -g supergateway");
  L.push("else");
  L.push('  echo "supergateway already installed"');
  L.push("fi");
  L.push('echo ""');
  L.push("");

  if (needsUvx) {
    L.push("# ── Check uvx ─────────────────────────────────────────────────────");
    L.push('UVX="/opt/homebrew/bin/uvx"');
    L.push('if ! command -v "$UVX" &> /dev/null; then');
    L.push('  UVX="$(which uvx 2>/dev/null || true)"');
    L.push("fi");
    L.push("");
    L.push('if [ -z "$UVX" ]; then');
    L.push('  echo "uvx not found — some servers require it."');
    L.push('  echo "  Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"');
    L.push("  SKIP_UVX=true");
    L.push("else");
    L.push('  echo "uvx found at: $UVX"');
    L.push("  SKIP_UVX=false");
    L.push("fi");
    L.push('echo ""');
    L.push("");
  }

  if (warnings.length) {
    L.push("# Warnings: " + warnings.join("; "));
    L.push("");
  }

  // Stop existing COS services
  L.push("# ── Stop existing COS supergateway services ────────────────────────");
  L.push('echo "Stopping any existing COS supergateway services..."');
  L.push("for label in $(launchctl list 2>/dev/null | grep -E 'com\\.cos\\.' | awk '{print $3}'); do");
  L.push('  launchctl bootout gui/$(id -u)/$label 2>/dev/null && echo "  stopped: $label" || true');
  L.push("done");
  L.push('echo ""');
  L.push("sleep 2");
  L.push("");

  // write_plist helper function
  L.push("# ── Create LaunchAgents ────────────────────────────────────────────");
  L.push('echo "Creating LaunchAgents..."');
  L.push('echo ""');
  L.push("");
  L.push('BASE_PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"');
  L.push("");
  L.push("write_plist() {");
  L.push('  local label="$1"');
  L.push('  local port="$2"');
  L.push('  local cmd="$3"');
  L.push('  local env_block="$4"');
  L.push('  local slug="${label#com.cos.supergateway.}"');
  L.push("");
  L.push("  cat > ~/Library/LaunchAgents/${label}.plist << EOF");
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
  L.push('<plist version="1.0">');
  L.push("<dict>");
  L.push("    <key>Label</key>");
  L.push("    <string>${label}</string>");
  L.push("    <key>ProgramArguments</key>");
  L.push("    <array>");
  L.push("        <string>/bin/sh</string>");
  L.push("        <string>-c</string>");
  L.push('        <string>$NPX supergateway --port ${port} --cors --stdio "${cmd}"</string>');
  L.push("    </array>");
  L.push("    <key>EnvironmentVariables</key>");
  L.push("    <dict>");
  L.push("        <key>PATH</key>");
  L.push("        <string>${BASE_PATH}</string>");
  L.push("${env_block}");
  L.push("    </dict>");
  L.push("    <key>RunAtLoad</key>");
  L.push("    <true/>");
  L.push("    <key>KeepAlive</key>");
  L.push("    <true/>");
  L.push("    <key>StandardOutPath</key>");
  L.push("    <string>/tmp/cos-mcp-${slug}.log</string>");
  L.push("    <key>StandardErrorPath</key>");
  L.push("    <string>/tmp/cos-mcp-${slug}.err</string>");
  L.push("</dict>");
  L.push("</plist>");
  L.push("EOF");
  L.push("}");
  L.push("");

  // Per-server write_plist calls
  for (const entry of validEntries) {
    const { name, slug, port, command, env } = entry;
    const isUvx = command === "uvx";
    const stdioCmd = buildStdioCmd(entry);

    // Build plist env block (key/string XML pairs)
    const envXmlParts = Object.entries(env).map(([k, v]) => {
      const safeVal = String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return "        <key>" + k + "</key><string>" + safeVal + "</string>";
    });
    const envBlock = envXmlParts.join("\n");

    const label = "com.cos.supergateway." + slug;
    const pad = Math.max(1, 26 - name.length);
    const indent = isUvx ? "  " : "";

    L.push("# " + name + " → port " + port);
    if (isUvx) {
      L.push('if [ "$SKIP_UVX" = false ]; then');
    }
    const cmdPrefix = isUvx ? "$UVX " : "$NPX -y ";
    L.push(indent + 'write_plist "' + label + '" "' + port + '" \\');
    L.push(indent + '  "' + cmdPrefix + stdioCmd.replace(/"/g, '\\"') + '" \\');
    if (envBlock) {
      L.push(indent + "  '" + envBlock.replace(/'/g, "'\\''") + "'");
    } else {
      L.push(indent + '  ""');
    }
    L.push(indent + 'echo "  ' + name + new Array(pad).join(" ") + " → port " + port + '"');
    if (isUvx) {
      L.push("else");
      L.push('  echo "  ' + name + new Array(pad).join(" ") + " → skipped (uvx not found)" + '"');
      L.push("fi");
    }
    L.push("");
  }

  // Bootstrap & start
  L.push("# ── Bootstrap & start ─────────────────────────────────────────────");
  L.push('echo ""');
  L.push('echo "Loading and starting services..."');
  L.push('echo ""');
  L.push("");
  L.push("for plist in ~/Library/LaunchAgents/com.cos.supergateway.*.plist; do");
  L.push('  label=$(/usr/libexec/PlistBuddy -c "Print :Label" "$plist")');
  L.push("  launchctl bootout gui/$(id -u)/$label 2>/dev/null || true");
  L.push('  launchctl bootstrap gui/$(id -u) "$plist"');
  L.push("  launchctl kickstart -kp gui/$(id -u)/$label");
  L.push('  echo "  started: $label"');
  L.push("done");
  L.push("");

  // Summary
  L.push("# ── Summary ───────────────────────────────────────────────────────");
  L.push('echo ""');
  L.push('echo "Done! MCP servers running:"');
  L.push('echo ""');
  for (const entry of validEntries) {
    const pad = Math.max(1, 26 - entry.name.length);
    L.push('echo "   ' + entry.name + new Array(pad).join(" ") + " → http://localhost:" + entry.port + '/sse"');
  }
  L.push('echo ""');
  L.push('echo "Logs:   tail -f /tmp/cos-mcp-*.log"');
  L.push('echo "Errors: tail -f /tmp/cos-mcp-*.err"');
  L.push('echo ""');
  L.push('echo "Set Local MCP Server Ports in COS settings to: ' + ports.join(",") + '"');
  return L.join("\n");
}

// ================================================================
// Linux script generator (systemd user services)
// ================================================================
function buildLinuxScript(validEntries, warnings, ports, needsUvx) {
  const L = [];
  L.push("#!/bin/bash");
  L.push("set -e");
  L.push("");
  L.push('echo "Chief of Staff — MCP Installer (Linux)"');
  L.push('echo "========================================="');
  L.push('echo ""');
  L.push("");

  // Node / npx detection
  L.push("# ── Detect node / npx ─────────────────────────────────────────────");
  L.push('NODE_BIN="$(dirname "$(which npx 2>/dev/null)" 2>/dev/null || true)"');
  L.push('NPX="${NODE_BIN:+$NODE_BIN/npx}"');
  L.push("");
  L.push('if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then');
  L.push('  echo "Node.js not found. Please install Node.js first: https://nodejs.org"');
  L.push("  exit 1");
  L.push("fi");
  L.push('echo "Node found at: $NODE_BIN"');
  L.push('echo ""');
  L.push("");

  // Supergateway install
  L.push("# ── Install supergateway if missing ────────────────────────────────");
  L.push("if ! command -v supergateway &> /dev/null; then");
  L.push('  echo "Installing supergateway..."');
  L.push("  npm install -g supergateway");
  L.push("else");
  L.push('  echo "supergateway already installed"');
  L.push("fi");
  L.push('echo ""');
  L.push("");

  if (needsUvx) {
    L.push("# ── Check uvx ─────────────────────────────────────────────────────");
    L.push('UVX="$(which uvx 2>/dev/null || true)"');
    L.push("");
    L.push('if [ -z "$UVX" ]; then');
    L.push('  echo "uvx not found — some servers require it."');
    L.push('  echo "  Install with: curl -LsSf https://astral.sh/uv/install.sh | sh"');
    L.push("  SKIP_UVX=true");
    L.push("else");
    L.push('  echo "uvx found at: $UVX"');
    L.push("  SKIP_UVX=false");
    L.push("fi");
    L.push('echo ""');
    L.push("");
  }

  if (warnings.length) {
    L.push("# Warnings: " + warnings.join("; "));
    L.push("");
  }

  // Ensure systemd user dir exists
  L.push("# ── Prepare systemd user directory ─────────────────────────────────");
  L.push('UNIT_DIR="$HOME/.config/systemd/user"');
  L.push('mkdir -p "$UNIT_DIR"');
  L.push("");

  // Stop existing COS services
  L.push("# ── Stop existing COS supergateway services ────────────────────────");
  L.push('echo "Stopping any existing COS supergateway services..."');
  L.push('for svc in $(systemctl --user list-units --type=service --all --no-legend 2>/dev/null | grep "cos-supergateway-" | awk \'{print $1}\'); do');
  L.push('  systemctl --user stop "$svc" 2>/dev/null && echo "  stopped: $svc" || true');
  L.push('  systemctl --user disable "$svc" 2>/dev/null || true');
  L.push("done");
  L.push('echo ""');
  L.push("");

  // write_unit helper function
  L.push("# ── Create systemd user services ──────────────────────────────────");
  L.push('echo "Creating systemd user services..."');
  L.push('echo ""');
  L.push("");
  L.push('BASE_PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"');
  L.push("");
  L.push("write_unit() {");
  L.push('  local svc_name="$1"');
  L.push('  local port="$2"');
  L.push('  local cmd="$3"');
  L.push('  local env_lines="$4"');
  L.push('  local description="$5"');
  L.push("");
  L.push('  cat > "$UNIT_DIR/${svc_name}.service" << EOF');
  L.push("[Unit]");
  L.push("Description=COS MCP: ${description}");
  L.push("After=network.target");
  L.push("");
  L.push("[Service]");
  L.push("Type=simple");
  L.push('ExecStart=/bin/sh -c \'$NPX supergateway --port ${port} --cors --stdio "${cmd}"\'');
  L.push("Restart=always");
  L.push("RestartSec=5");
  L.push("Environment=PATH=${BASE_PATH}");
  L.push("${env_lines}");
  L.push("StandardOutput=file:/tmp/cos-mcp-${svc_name#cos-supergateway-}.log");
  L.push("StandardError=file:/tmp/cos-mcp-${svc_name#cos-supergateway-}.err");
  L.push("");
  L.push("[Install]");
  L.push("WantedBy=default.target");
  L.push("EOF");
  L.push("}");
  L.push("");

  // Per-server write_unit calls
  for (const entry of validEntries) {
    const { name, slug, port, command, env } = entry;
    const isUvx = command === "uvx";
    const stdioCmd = buildStdioCmd(entry);

    // Build env lines for systemd (Environment=KEY=VALUE)
    const envLines = Object.entries(env).map(([k, v]) =>
      "Environment=" + k + "=" + String(v)
    ).join("\\n");

    const svcName = "cos-supergateway-" + slug;
    const pad = Math.max(1, 26 - name.length);
    const indent = isUvx ? "  " : "";

    L.push("# " + name + " → port " + port);
    if (isUvx) {
      L.push('if [ "$SKIP_UVX" = false ]; then');
    }
    const cmdPrefix = isUvx ? "$UVX " : "$NPX -y ";
    L.push(indent + 'write_unit "' + svcName + '" "' + port + '" \\');
    L.push(indent + '  "' + cmdPrefix + stdioCmd.replace(/"/g, '\\"') + '" \\');
    L.push(indent + '  "' + envLines + '" \\');
    L.push(indent + '  "' + name.replace(/"/g, '\\"') + '"');
    L.push(indent + 'echo "  ' + name + new Array(pad).join(" ") + " → port " + port + '"');
    if (isUvx) {
      L.push("else");
      L.push('  echo "  ' + name + new Array(pad).join(" ") + " → skipped (uvx not found)" + '"');
      L.push("fi");
    }
    L.push("");
  }

  // Reload, enable & start
  L.push("# ── Reload, enable & start ────────────────────────────────────────");
  L.push('echo ""');
  L.push('echo "Starting services..."');
  L.push('echo ""');
  L.push("");
  L.push("systemctl --user daemon-reload");
  L.push("");
  L.push('for svc in "$UNIT_DIR"/cos-supergateway-*.service; do');
  L.push('  svc_name="$(basename "$svc" .service)"');
  L.push('  systemctl --user enable "$svc_name" 2>/dev/null');
  L.push('  systemctl --user restart "$svc_name"');
  L.push('  echo "  started: $svc_name"');
  L.push("done");
  L.push("");

  // Enable lingering so user services survive logout
  L.push("# ── Enable lingering (services persist after logout) ───────────────");
  L.push("if command -v loginctl &> /dev/null; then");
  L.push("  loginctl enable-linger $(whoami) 2>/dev/null || true");
  L.push("fi");
  L.push("");

  // Summary
  L.push("# ── Summary ───────────────────────────────────────────────────────");
  L.push('echo ""');
  L.push('echo "Done! MCP servers running:"');
  L.push('echo ""');
  for (const entry of validEntries) {
    const pad = Math.max(1, 26 - entry.name.length);
    L.push('echo "   ' + entry.name + new Array(pad).join(" ") + " → http://localhost:" + entry.port + '/sse"');
  }
  L.push('echo ""');
  L.push('echo "Logs:    journalctl --user -u cos-supergateway-* -f"');
  L.push('echo "         or: tail -f /tmp/cos-mcp-*.log"');
  L.push('echo "Errors:  tail -f /tmp/cos-mcp-*.err"');
  L.push('echo "Status:  systemctl --user status cos-supergateway-*"');
  L.push('echo ""');
  L.push('echo "Set Local MCP Server Ports in COS settings to: ' + ports.join(",") + '"');
  return L.join("\n");
}

// ================================================================
// Windows script generator (PowerShell + Task Scheduler)
// ================================================================
function buildWindowsScript(validEntries, warnings, ports, needsUvx) {
  const L = [];
  L.push("# Chief of Staff — MCP Installer (Windows)");
  L.push("# Run in PowerShell as your normal user (not elevated)");
  L.push("# If needed: Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned");
  L.push('$ErrorActionPreference = "Stop"');
  L.push("");
  L.push('Write-Host "Chief of Staff - MCP Installer (Windows)" -ForegroundColor Cyan');
  L.push('Write-Host ("=" * 48)');
  L.push('Write-Host ""');
  L.push("");

  // Node / npx detection
  L.push("# -- Detect node / npx ---------------------------------------------");
  L.push("$npxCmd = Get-Command npx -ErrorAction SilentlyContinue");
  L.push("if (-not $npxCmd) {");
  L.push('    Write-Host "Node.js not found. Please install Node.js first: https://nodejs.org" -ForegroundColor Red');
  L.push("    exit 1");
  L.push("}");
  L.push('$NPX = $npxCmd.Source');
  L.push('$NODE_BIN = Split-Path $NPX');
  L.push('Write-Host "Node found at: $NODE_BIN"');
  L.push('Write-Host ""');
  L.push("");

  // Supergateway install
  L.push("# -- Install supergateway if missing --------------------------------");
  L.push("$sgCmd = Get-Command supergateway -ErrorAction SilentlyContinue");
  L.push("if (-not $sgCmd) {");
  L.push('    Write-Host "Installing supergateway..."');
  L.push("    npm install -g supergateway");
  L.push("} else {");
  L.push('    Write-Host "supergateway already installed"');
  L.push("}");
  L.push('Write-Host ""');
  L.push("");

  if (needsUvx) {
    L.push("# -- Check uvx -----------------------------------------------------");
    L.push("$uvxCmd = Get-Command uvx -ErrorAction SilentlyContinue");
    L.push("$SKIP_UVX = $true");
    L.push("if ($uvxCmd) {");
    L.push('    $UVX = $uvxCmd.Source');
    L.push('    Write-Host "uvx found at: $UVX"');
    L.push("    $SKIP_UVX = $false");
    L.push("} else {");
    L.push('    Write-Host "uvx not found - some servers require it." -ForegroundColor Yellow');
    L.push('    Write-Host "  Install with: irm https://astral.sh/uv/install.ps1 | iex"');
    L.push("}");
    L.push('Write-Host ""');
    L.push("");
  }

  if (warnings.length) {
    L.push("# Warnings: " + warnings.join("; "));
    L.push("");
  }

  // Ensure log directory
  L.push("# -- Prepare log directory ------------------------------------------");
  L.push('$LogDir = "$env:TEMP\\cos-mcp"');
  L.push("if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }");
  L.push("");

  // Remove existing COS scheduled tasks
  L.push("# -- Stop & remove existing COS tasks -------------------------------");
  L.push('Write-Host "Stopping any existing COS supergateway tasks..."');
  L.push('Get-ScheduledTask -TaskPath "\\COS\\" -ErrorAction SilentlyContinue | ForEach-Object {');
  L.push('    Unregister-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath -Confirm:$false');
  L.push('    Write-Host "  removed: $($_.TaskName)"');
  L.push("}");
  L.push('Write-Host ""');
  L.push("");

  // Per-server task creation
  L.push("# -- Create scheduled tasks -----------------------------------------");
  L.push('Write-Host "Creating scheduled tasks..."');
  L.push('Write-Host ""');
  L.push("");

  for (const entry of validEntries) {
    const { name, slug, port, command, env } = entry;
    const isUvx = command === "uvx";
    const stdioCmd = buildStdioCmd(entry);

    // Build the full supergateway command for Windows
    const cmdPrefix = isUvx ? "$UVX " : "$NPX -y ";
    const fullStdioCmd = (cmdPrefix + stdioCmd).replace(/'/g, "''");
    const taskName = "cos-sg-" + slug;
    const pad = Math.max(1, 26 - name.length);

    // Build env var assignments for the wrapper script
    const envSetLines = Object.entries(env).map(([k, v]) => {
      const safeV = String(v).replace(/'/g, "''");
      return "$env:" + k + " = '" + safeV + "'";
    });

    L.push("# " + name + " → port " + port);
    if (isUvx) {
      L.push("if (-not $SKIP_UVX) {");
    }
    const indent = isUvx ? "    " : "";

    // Create a small wrapper .ps1 that sets env vars and launches supergateway
    L.push(indent + "$wrapperContent = @'");
    if (envSetLines.length > 0) {
      for (const el of envSetLines) {
        L.push(indent + el);
      }
    }
    L.push(indent + "& npx supergateway --port " + port + " --cors --stdio '" + fullStdioCmd.replace(/'/g, "''") + "'");
    L.push(indent + "'@");
    L.push(indent + '$wrapperPath = "$LogDir\\' + taskName + '.ps1"');
    L.push(indent + "$wrapperContent | Set-Content -Path $wrapperPath -Encoding UTF8");
    L.push(indent + "");
    L.push(indent + '$action = New-ScheduledTaskAction -Execute "powershell.exe" `');
    L.push(indent + '    -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File $wrapperPath" `');
    L.push(indent + '    -WorkingDirectory "$NODE_BIN"');
    L.push(indent + '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME');
    L.push(indent + "$settings = New-ScheduledTaskSettingsSet `");
    L.push(indent + "    -AllowStartIfOnBatteries `");
    L.push(indent + "    -DontStopIfGoingOnBatteries `");
    L.push(indent + "    -RestartCount 999 `");
    L.push(indent + "    -RestartInterval (New-TimeSpan -Seconds 10) `");
    L.push(indent + "    -ExecutionTimeLimit (New-TimeSpan -Days 365)");
    L.push(indent + 'Register-ScheduledTask -TaskName "' + taskName + '" -TaskPath "\\COS\\" `');
    L.push(indent + "    -Action $action -Trigger $trigger -Settings $settings `");
    L.push(indent + '    -Description "COS MCP: ' + name.replace(/"/g, '`"') + '" | Out-Null');
    L.push(indent + "");
    L.push(indent + "# Start the task immediately");
    L.push(indent + 'Start-ScheduledTask -TaskPath "\\COS\\" -TaskName "' + taskName + '"');
    L.push(indent + 'Write-Host "  ' + name + new Array(pad).join(" ") + " → port " + port + '"');

    if (isUvx) {
      L.push("} else {");
      L.push('    Write-Host "  ' + name + new Array(pad).join(" ") + " → skipped (uvx not found)" + '" -ForegroundColor Yellow');
      L.push("}");
    }
    L.push("");
  }

  // Summary
  L.push("# -- Summary -------------------------------------------------------");
  L.push('Write-Host ""');
  L.push('Write-Host "Done! MCP servers running:" -ForegroundColor Green');
  L.push('Write-Host ""');
  for (const entry of validEntries) {
    const pad = Math.max(1, 26 - entry.name.length);
    L.push('Write-Host "   ' + entry.name + new Array(pad).join(" ") + " → http://localhost:" + entry.port + '/sse"');
  }
  L.push('Write-Host ""');
  L.push('Write-Host "Task status: Get-ScheduledTask -TaskPath \\COS\\"');
  L.push('Write-Host "Logs:        $LogDir"');
  L.push('Write-Host ""');
  L.push('Write-Host "Set Local MCP Server Ports in COS settings to: ' + ports.join(",") + '"');
  return L.join("\n");
}

// ================================================================
// Setup instructions HTML (platform-specific)
// ================================================================
function buildSetupStepsHtml(platform) {
  if (platform === "windows") {
    return '<div style="margin:10px 0 6px;padding:8px 10px;background:var(--cos-bg-tertiary,#eef);border-radius:4px;font-size:11.5px;line-height:1.5;color:var(--cos-text-primary,#333);">'
      + '<strong>Setup steps (Windows):</strong>'
      + '<ol style="margin:4px 0 0;padding-left:18px;">'
      + '<li>Click <strong>Download Script</strong> below to save <code>start-mcp.ps1</code> to your Downloads folder (or use <strong>Copy Script</strong> and paste into Notepad)</li>'
      + '<li>Right-click <code>start-mcp.ps1</code> → <strong>Run with PowerShell</strong><br>'
      + '<span style="font-size:10.5px;color:var(--cos-text-secondary,#888);">If blocked, first run: <code>Set-ExecutionPolicy -Scope CurrentUser RemoteSigned</code></span></li>'
      + '<li style="margin-top:2px;"><span style="font-size:10.5px;color:var(--cos-text-secondary,#888);">The script auto-installs supergateway, creates Windows Scheduled Tasks for each server '
      + '(they persist across reboots &amp; auto-restart on failure)</span></li>'
      + '<li>Click <strong>Set Ports in Settings</strong> below (or enter them manually)</li>'
      + '<li>Use the <strong>Connect Local MCP</strong> command in Roam to connect</li>'
      + '</ol>'
      + '</div>';
  }
  if (platform === "linux") {
    return '<div style="margin:10px 0 6px;padding:8px 10px;background:var(--cos-bg-tertiary,#eef);border-radius:4px;font-size:11.5px;line-height:1.5;color:var(--cos-text-primary,#333);">'
      + '<strong>Setup steps (Linux):</strong>'
      + '<ol style="margin:4px 0 0;padding-left:18px;">'
      + '<li>Click <strong>Download Script</strong> below to save <code>start-mcp.sh</code> (or use <strong>Copy Script</strong> and save to a file)</li>'
      + '<li>Make it executable: <code>chmod +x ~/start-mcp.sh</code></li>'
      + '<li>Run it: <code>~/start-mcp.sh</code><br>'
      + '<span style="font-size:10.5px;color:var(--cos-text-secondary,#888);">The script auto-installs supergateway, creates systemd user services for each server '
      + '(they persist across reboots &amp; auto-restart on failure), and logs to <code>/tmp/cos-mcp-*.log</code></span></li>'
      + '<li>Click <strong>Set Ports in Settings</strong> below (or enter them manually)</li>'
      + '<li>Use the <strong>Connect Local MCP</strong> command in Roam to connect</li>'
      + '</ol>'
      + '</div>';
  }
  // macOS (default)
  return '<div style="margin:10px 0 6px;padding:8px 10px;background:var(--cos-bg-tertiary,#eef);border-radius:4px;font-size:11.5px;line-height:1.5;color:var(--cos-text-primary,#333);">'
    + '<strong>Setup steps (macOS):</strong>'
    + '<ol style="margin:4px 0 0;padding-left:18px;">'
    + '<li>Click <strong>Download Script</strong> below to save <code>start-mcp.sh</code> to your Downloads folder (or use <strong>Copy Script</strong> and <code>pbpaste > ~/start-mcp.sh</code>)</li>'
    + '<li>Make it executable: <code>chmod +x ~/start-mcp.sh</code></li>'
    + '<li>Run it: <code>~/start-mcp.sh</code><br>'
    + '<span style="font-size:10.5px;color:var(--cos-text-secondary,#888);">The script auto-installs supergateway if needed, creates macOS LaunchAgents for each server '
    + '(they persist across reboots &amp; auto-restart on failure), and logs to <code>/tmp/cos-mcp-*.log</code></span></li>'
    + '<li>Click <strong>Set Ports in Settings</strong> below (or enter them manually)</li>'
    + '<li>Use the <strong>Connect Local MCP</strong> command in Roam to connect</li>'
    + '</ol>'
    + '</div>';
}

// ================================================================
// Main entry point — DI-friendly
// ================================================================
export function buildSupergatewayScript({ validEntries, warnings, ports, platform }) {
  const needsUvx = validEntries.some(e =>
    e.command === "uvx" || (e.command === "npx" && e.args.some(a => String(a).includes("uvx")))
  );

  const script = platform === "windows" ? buildWindowsScript(validEntries, warnings, ports, needsUvx)
               : platform === "linux"   ? buildLinuxScript(validEntries, warnings, ports, needsUvx)
               :                          buildMacosScript(validEntries, warnings, ports, needsUvx);

  const portsList = ports.join(",");
  const scriptExt = platform === "windows" ? ".ps1" : ".sh";
  const setupStepsHtml = buildSetupStepsHtml(platform);

  return { script, portsList, scriptExt, setupStepsHtml, platform };
}
