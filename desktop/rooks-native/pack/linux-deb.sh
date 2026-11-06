#!/bin/bash
# A .deb for Ubuntu and Debian. The window needs the usual desktop libraries; it does not need Chrome.
set -euo pipefail
bin=${1:?binary}
out=${2:?deb}
here=$(cd "$(dirname "$0")" && pwd)
icon_src=${ROOKS_ICON:-"$here/../assets/app-icon.png"}
root=$(mktemp -d)
mkdir -p "$root/usr/bin" "$root/usr/share/applications" "$root/usr/share/icons/hicolor/256x256/apps" "$root/DEBIAN"
install -m 0755 "$bin" "$root/usr/bin/rooks-native"
if [[ -f "$icon_src" ]]; then
  if command -v convert >/dev/null; then
    convert "$icon_src" -resize 256x256 "$root/usr/share/icons/hicolor/256x256/apps/rooks-native.png"
  elif command -v sips >/dev/null; then
    sips -z 256 256 "$icon_src" --out "$root/usr/share/icons/hicolor/256x256/apps/rooks-native.png" >/dev/null
  else
    cp "$icon_src" "$root/usr/share/icons/hicolor/256x256/apps/rooks-native.png"
  fi
fi
cat > "$root/usr/share/applications/rooks-native.desktop" <<'EOF'
[Desktop Entry]
Name=Rooks
Comment=A personal assistant on this computer
Exec=rooks-native
Icon=rooks-native
Terminal=false
Type=Application
Categories=Utility;
EOF
cat > "$root/DEBIAN/control" <<'EOF'
Package: rooks-native
Version: 0.3.0
Section: utils
Priority: optional
Architecture: amd64
Depends: libxkbcommon0, libxkbcommon-x11-0, libxcb1, libx11-6, libwayland-client0
Maintainer: Inclined88888 <dev@localhost>
Description: Rooks, on this computer
 The new Rooks window. It talks to the Rooks service already running on this computer.
 It does not use Chrome for its own window.
EOF
chmod -R a+rX "$root"
dpkg-deb --build --root-owner-group "$root" "$out"
rm -rf "$root"
