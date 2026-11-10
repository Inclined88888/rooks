#!/bin/bash
# Turn the Rooks binary into a disk image. Unsigned: the person right-clicks and chooses Open the first time.
set -euo pipefail
bin=${1:?binary}
out=${2:?dmg}
here=$(cd "$(dirname "$0")" && pwd)
icon_src=${ROOKS_ICON:-"$here/../assets/app-icon.png"}
stage=$(mktemp -d)
app="$stage/Rooks.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin" "$app/Contents/MacOS/rooks-native"
chmod +x "$app/Contents/MacOS/rooks-native"
icon_plist=""
if [[ -f "$icon_src" ]] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
  iconset_dir=$(mktemp -d)
  iconset="$iconset_dir/Rooks.iconset"
  mkdir -p "$iconset"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$icon_src" --out "$iconset/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$icon_src" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"
  rm -rf "$iconset_dir"
  icon_plist='  <key>CFBundleIconFile</key><string>AppIcon</string>'
fi
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Rooks</string>
  <key>CFBundleDisplayName</key><string>Rooks</string>
  <key>CFBundleIdentifier</key><string>com.inclined88888.rooks.native</string>
  <key>CFBundleVersion</key><string>0.4.0</string>
  <key>CFBundleShortVersionString</key><string>0.4.0</string>
  <key>CFBundleExecutable</key><string>rooks-native</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
${icon_plist}
</dict></plist>
EOF
hdiutil create -volname Rooks -srcfolder "$stage" -ov -format UDZO "$out"
rm -rf "$stage"
