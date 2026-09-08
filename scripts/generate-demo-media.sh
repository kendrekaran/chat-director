#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/fixtures/demo/clips"
mkdir -p "$OUT"

FONT=""
if [[ -f /System/Library/Fonts/Supplemental/Georgia.ttf ]]; then
  FONT="/System/Library/Fonts/Supplemental/Georgia.ttf"
elif [[ -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf ]]; then
  FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
fi

make_clip() {
  local name="$1"
  local color="$2"
  local title="$3"
  local freq="$4"
  local vf="null"
  if [[ -n "$FONT" ]]; then
    vf="drawtext=fontfile=${FONT}:text='${title}':fontcolor=0xF3E6CF:fontsize=64:x=(w-text_w)/2:y=(h-text_h)/2"
  fi
  ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=${color}:s=1920x1080:d=4" \
    -f lavfi -i "sine=frequency=${freq}:sample_rate=48000:duration=4" \
    -vf "$vf" \
    -c:v libx264 -pix_fmt yuv420p -c:a aac -ac 2 -shortest -movflags +faststart \
    "$OUT/${name}.mp4"
}

make_clip "01-lantern-grove" "0x1A120C" "Lantern Grove" 220
make_clip "02-rain-courtyard" "0x121820" "Rain Courtyard" 330
make_clip "03-river-spirit" "0x102018" "River Spirit" 440

echo "Wrote demo clips to $OUT"
