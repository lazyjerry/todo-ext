#!/usr/bin/env bash
# 由 resources/icon.svg 產生 Marketplace 用的 128x128 PNG。
# 僅使用 macOS 內建 sips，不引入額外相依。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/resources/icon.svg"
out="$root/resources/icon.png"

if ! command -v sips >/dev/null 2>&1; then
  echo "make-icon: 需要 macOS 的 sips，請改用 rsvg-convert 或 ImageMagick 手動產生 $out" >&2
  exit 1
fi

sips -s format png -z 128 128 "$src" --out "$out" >/dev/null

read -r w h < <(sips -g pixelWidth -g pixelHeight "$out" | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w, h}')
if [ "$w" != "128" ] || [ "$h" != "128" ]; then
  echo "make-icon: 產出尺寸為 ${w}x${h}，Marketplace 需要 128x128" >&2
  exit 1
fi

echo "make-icon: 已產生 $out (${w}x${h})"
