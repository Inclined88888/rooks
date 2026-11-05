#!/bin/bash
# Turn the Rooks binary into a disk image. Unsigned: the person right-clicks and chooses Open the first time.
set -euo pipefail
bin=${1:?binary}
out=${2:?dmg}
stage=$(mktemp -d)
app="$stage/Rooks.app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/rooks-native"
chmod +x "$app/Contents/MacOS/rooks-native"
cat > "$app/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Rooks</string>
  <key>CFBundleDisplayName</key><string>Rooks</string>
  <key>CFBundleIdentifier</key><string>com.inclined88888.rooks.native</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>rooks-native</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF
hdiutil create -volname Rooks -srcfolder "$stage" -ov -format UDZO "$out"
rm -rf "$stage"
