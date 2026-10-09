#!/usr/bin/env bash
# mix-narration.sh — lay the generated narration under the assembled videos.
#
# Each line is a mono WAV placed at its beat with `adelay`; the video itself is
# stream-copied (`-c:v copy`) so the encoded frames are not recompressed. The
# beats match the caption windows burned in by assemble-videos.sh.
set -euo pipefail

MEDIA="/c/Users/HP/Desktop/crucible/docs/media"
N="$MEDIA/narration"
FPS_ARGS=(-c:v copy -c:a aac -b:a 160k -movflags +faststart)

# ── demo ────────────────────────────────────────────────────────────────────
ffmpeg -v error -stats -y \
  -i "$MEDIA/crucible-demo.mp4" \
  -i "$N/demo-01.wav" -i "$N/demo-02.wav" -i "$N/demo-03.wav" -i "$N/demo-04.wav" \
  -i "$N/demo-05.wav" -i "$N/demo-06.wav" -i "$N/demo-07.wav" -i "$N/demo-08.wav" \
  -i "$N/demo-09.wav" -i "$N/demo-10.wav" -i "$N/demo-11.wav" -i "$N/demo-12.wav" \
  -filter_complex "\
    [1:a]adelay=7000[a1];[2:a]adelay=18000[a2];[3:a]adelay=28000[a3];[4:a]adelay=38000[a4];\
    [5:a]adelay=48000[a5];[6:a]adelay=62000[a6];[7:a]adelay=72000[a7];[8:a]adelay=84000[a8];\
    [9:a]adelay=100000[a9];[10:a]adelay=114000[a10];[11:a]adelay=126000[a11];[12:a]adelay=146000[a12];\
    [a1][a2][a3][a4][a5][a6][a7][a8][a9][a10][a11][a12]amix=inputs=12:normalize=0,alimiter=limit=0.95,apad=whole_dur=155.4[aout]" \
  -map 0:v -map "[aout]" -t 155.4 "${FPS_ARGS[@]}" \
  "$MEDIA/crucible-demo-narrated.mp4"

# `apad=whole_dur` pads the narration out to exactly the video length so the
# closing card is fully held; a bare `apad` pads to infinity and the encode
# never ends, and `-shortest` would cut the closing card short instead.

# ── pitch ───────────────────────────────────────────────────────────────────
ffmpeg -v error -stats -y \
  -i "$MEDIA/crucible-pitch.mp4" \
  -i "$N/pitch-01.wav" -i "$N/pitch-02.wav" -i "$N/pitch-03.wav" -i "$N/pitch-04.wav" \
  -i "$N/pitch-05.wav" -i "$N/pitch-06.wav" -i "$N/pitch-07.wav" \
  -filter_complex "\
    [1:a]adelay=700[b1];[2:a]adelay=14700[b2];[3:a]adelay=30700[b3];[4:a]adelay=48700[b4];\
    [5:a]adelay=66700[b5];[6:a]adelay=84700[b6];[7:a]adelay=100700[b7];\
    [b1][b2][b3][b4][b5][b6][b7]amix=inputs=7:normalize=0,alimiter=limit=0.95,apad=whole_dur=112.8[bout]" \
  -map 0:v -map "[bout]" -t 112.8 "${FPS_ARGS[@]}" \
  "$MEDIA/crucible-pitch-narrated.mp4"

# The narrated cuts are the submission files now; keep the silent ones under
# their original names for anyone who prefers them.
mv "$MEDIA/crucible-demo-narrated.mp4" "$MEDIA/crucible-demo.mp4"
mv "$MEDIA/crucible-pitch-narrated.mp4" "$MEDIA/crucible-pitch.mp4"

echo "narrated videos in place:"
for f in "$MEDIA/crucible-demo.mp4" "$MEDIA/crucible-pitch.mp4"; do
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
  s=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$f")
  echo "  $f  ${d}s  audio=$s"
done
