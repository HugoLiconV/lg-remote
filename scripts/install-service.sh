#!/bin/sh
# Run the remote as a macOS background service: starts at login, restarts if it crashes.
# Uninstall: launchctl bootout gui/$(id -u)/com.lg-remote && rm ~/Library/LaunchAgents/com.lg-remote.plist
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
PLIST="$HOME/Library/LaunchAgents/com.lg-remote.plist"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.lg-remote</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/lg-remote.log</string>
  <key>StandardErrorPath</key><string>/tmp/lg-remote.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/com.lg-remote" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Logs: /tmp/lg-remote.log"
echo "Open: http://$(scutil --get LocalHostName 2>/dev/null || hostname).local:8080"
