#!/usr/bin/env bash
# assemble-videos.sh — cut the screen recording into the two submission videos.
#
#   demo  (≤3 min): title card → the live-product recording → closing card, with
#         brand-typed caption bars burned in. The footage is the real app driven
#         by scripts/record-demo.mjs — the demo rules say "show the live product,
#         not a slide deck", so there is no mocked UI anywhere in this file.
#   pitch (≤2 min): seven drawn cards introducing the builder and the reasoning.
#
# Every card and caption is rendered by scripts/make-video-cards.py from the
# vendored fonts and the token colours, so the videos and the app are the same
# design rather than the same vibe.
#
#   bash scripts/assemble-videos.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MEDIA="$ROOT/docs/media"
CARDS="$MEDIA/cards"
RAW="$MEDIA/raw"
OUT="$MEDIA"
FPS=25
ENC=(-c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r "$FPS")
SILENT=(-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100)

RECORDING=$(ls "$RAW"/*.webm | head -1)
echo "recording: $RECORDING"

# The second crossfade's offset is measured from the start of the first
# (title+recording) segment. Hardcoding it once shipped a video whose closing
# card never rendered: the offset sat past the segment's real end, so the
# output stopped at the recording. Measure, then subtract the two 0.6s
# transitions so the closing card lands exactly as the footage ends.
REC_SECONDS=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RECORDING")
CLOSE_OFFSET=$(node -e "const r=Number(process.argv[1]);console.log((6.0+r-1.2).toFixed(3))" "$REC_SECONDS")
echo "recording is ${REC_SECONDS}s; closing card starts at ${CLOSE_OFFSET}s"

# ── the demo ────────────────────────────────────────────────────────────────
# Title (6.6s) and closing (10s) carry a slow push; the recording is upscaled to
# match the cards. xfade of 0.6s means the footage's own timeline still starts at
# exactly 6.0s, which is what the caption windows below are timed against.
ffmpeg -v error -stats -y \
  -loop 1 -t 6.6 -i "$CARDS/demo-title.png" \
  -i "$RECORDING" \
  -loop 1 -t 10.6 -i "$CARDS/demo-closing.png" \
  "${SILENT[@]}" \
  -i "$CARDS/caption-01.png" -i "$CARDS/caption-02.png" -i "$CARDS/caption-03.png" \
  -i "$CARDS/caption-04.png" -i "$CARDS/caption-05.png" -i "$CARDS/caption-06.png" \
  -i "$CARDS/caption-07.png" -i "$CARDS/caption-08.png" -i "$CARDS/caption-09.png" \
  -i "$CARDS/caption-10.png" -i "$CARDS/caption-11.png" \
  -filter_complex "\
    [0:v]scale=1920:1080,zoompan=z='1+0.05*on/165':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=$FPS,setsar=1[title];\
    [1:v]scale=1920:1080,fps=$FPS,setsar=1[rec];\
    [2:v]scale=1920:1080,zoompan=z='1+0.04*on/250':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=$FPS,setsar=1[close];\
    [title][rec]xfade=transition=fadeblack:duration=0.6:offset=6.0[first];\
    [first][close]xfade=transition=fadeblack:duration=0.6:offset=$CLOSE_OFFSET[base];\
    [base][4:v]overlay=0:864:enable='between(t,7,17)'[v1];\
    [v1][5:v]overlay=0:864:enable='between(t,18,27)'[v2];\
    [v2][6:v]overlay=0:864:enable='between(t,28,37)'[v3];\
    [v3][7:v]overlay=0:864:enable='between(t,38,47)'[v4];\
    [v4][8:v]overlay=0:864:enable='between(t,48,56)'[v5];\
    [v5][9:v]overlay=0:864:enable='between(t,62,70)'[v6];\
    [v6][10:v]overlay=0:864:enable='between(t,72,81)'[v7];\
    [v7][11:v]overlay=0:864:enable='between(t,84,94)'[v8];\
    [v8][12:v]overlay=0:864:enable='between(t,100,110)'[v9];\
    [v9][13:v]overlay=0:864:enable='between(t,114,124)'[v10];\
    [v10][14:v]overlay=0:864:enable='between(t,126,136)',format=yuv420p[vout]" \
  -map "[vout]" -map 3:a -shortest "${ENC[@]}" \
  "$OUT/crucible-demo.mp4"

# ── the pitch ───────────────────────────────────────────────────────────────
# Seven cards, 0.7s crossfades: 112s of card time less 4.2s of overlap.
ffmpeg -v error -stats -y \
  -loop 1 -t 14.7 -i "$CARDS/pitch-1-team.png" \
  -loop 1 -t 16.7 -i "$CARDS/pitch-2-problem.png" \
  -loop 1 -t 18.7 -i "$CARDS/pitch-3-what.png" \
  -loop 1 -t 18.7 -i "$CARDS/pitch-4-mechanism.png" \
  -loop 1 -t 18.7 -i "$CARDS/pitch-5-why.png" \
  -loop 1 -t 16.7 -i "$CARDS/pitch-6-next.png" \
  -loop 1 -t 12.7 -i "$CARDS/pitch-7-close.png" \
  "${SILENT[@]}" \
  -filter_complex "\
    [0:v][1:v]xfade=transition=fade:duration=0.7:offset=14.0[x1];\
    [x1][2:v]xfade=transition=fade:duration=0.7:offset=30.0[x2];\
    [x2][3:v]xfade=transition=fade:duration=0.7:offset=48.0[x3];\
    [x3][4:v]xfade=transition=fade:duration=0.7:offset=66.0[x4];\
    [x4][5:v]xfade=transition=fade:duration=0.7:offset=84.0[x5];\
    [x5][6:v]xfade=transition=fade:duration=0.7:offset=100.0,format=yuv420p[vout]" \
  -map "[vout]" -map 7:a -shortest "${ENC[@]}" \
  "$OUT/crucible-pitch.mp4"

echo "written:"
echo "  $OUT/crucible-demo.mp4"
echo "  $OUT/crucible-pitch.mp4"
