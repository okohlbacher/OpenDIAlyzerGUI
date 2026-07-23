#!/bin/bash
# Renders the application icon from the OpenMS mark.
#
# The icon is the logo's spectrum — the peak sticks and their gradient, without
# the wordmark, which is illegible below about 128 px. That is also the honest
# choice: this application draws spectra, and the peaks are the part of the
# OpenMS identity that says so.
#
# Maintainer-only: the outputs are committed, so contributors never need these
# tools. Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick);
# iconutil ships with macOS.
set -euo pipefail
cd "$(dirname "$0")/.."
for t in rsvg-convert magick; do
  command -v $t >/dev/null || { echo "need $t (brew install librsvg imagemagick)"; exit 1; }
done

PLATE=1024        # full icon canvas
INSET=92          # macOS masks to a squircle; leave it room
ART=720           # longest edge of the artwork inside the plate
RADIUS=188

mkdir -p build
node scripts/icon-svg.mjs > build/icon-art.svg
rsvg-convert -w 2048 build/icon-art.svg -o build/icon-art.png

# Trim to the art's true bounds, then centre it — the source path's bounding box
# includes space for a wordmark we are not drawing, so its own coordinates are
# not a usable guide.
magick build/icon-art.png -trim +repage -resize "${ART}x${ART}" build/icon-art-trim.png

magick -size ${PLATE}x${PLATE} xc:none \
  -fill '#171514' -draw "roundrectangle ${INSET},${INSET} $((PLATE-INSET)),$((PLATE-INSET)) ${RADIUS},${RADIUS}" \
  build/icon-art-trim.png -gravity center -composite \
  build/icon.png
echo "wrote build/icon.png"

if [[ "$(uname)" == "Darwin" ]]; then
  set="build/icon.iconset"; rm -rf "$set"; mkdir -p "$set"
  for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
              "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
              "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    px=${spec%% *}; nm=${spec##* }
    magick build/icon.png -resize ${px}x${px} "$set/$nm.png"
  done
  iconutil -c icns "$set" -o build/icon.icns
  rm -rf "$set"
  echo "wrote build/icon.icns"
fi
rm -f build/icon-art.svg build/icon-art.png build/icon-art-trim.png
