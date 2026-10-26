import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { renderRecordingWithVoice, inspectLocalMedia } from "../src/lib/platform/recordingMedia";
const run = promisify(execFile);
const executable = process.env.FFMPEG_PATH || ffmpeg || "ffmpeg";

for (const extension of ["webm", "mp4"] as const) {
  test(`${extension}: output preserves source audio and the entire longer alert`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "sensara-media-test-"));
    try {
      const video = join(directory, `source.${extension}`), speech = join(directory, "speech.mp3");
      await run(executable, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=10:d=1", "-f", "lavfi", "-i", "sine=frequency=1000:duration=1",
        "-c:v", extension === "webm" ? "libvpx-vp9" : "libx264", "-c:a", extension === "webm" ? "libopus" : "aac", "-shortest", video]);
      await run(executable, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=500:duration=3", speech]);
      const result = await renderRecordingWithVoice(await readFile(video), await readFile(speech), extension, 1);
      const output = join(directory, `output.${extension}`); await writeFile(output, result.bytes);
      const inspected = await inspectLocalMedia(output);
      assert.equal(inspected.hasVideoTrack, true); assert.equal(inspected.hasAudioTrack, true);
      assert.ok(inspected.durationSeconds >= 3 && inspected.durationSeconds < 3.6);
      assert.equal(result.recordedDurationSeconds, 1);
      // Audio duration alone can hide a truncated video stream on some FFmpeg
      // versions. Decode an actual held frame after the original footage ends.
      const lateFrame = await run(executable, ["-v", "error", "-ss", "2.5", "-i", output,
        "-map", "0:v:0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], { encoding: "buffer" });
      assert.ok(lateFrame.stdout.length > 8, "The final video frame must remain available while the longer alert plays");
      const pcm = join(directory, "audio.raw");
      await run(executable, ["-v", "error", "-i", output, "-vn", "-ac", "1", "-ar", "8000", "-f", "f32le", pcm]);
      const raw = await readFile(pcm);
      const power = (frequency: number, start: number) => {
        let re = 0, im = 0;
        for (let i = 0; i < 2000; i++) { const v = raw.readFloatLE((start + i) * 4), phase = 2 * Math.PI * frequency * i / 8000; re += v * Math.cos(phase); im += v * Math.sin(phase); }
        return Math.hypot(re, im) / 2000;
      };
      assert.ok(power(1000, 2000) > 0.005, "Original audio must remain audible");
      assert.ok(power(500, 2000) > 0.01, "Alert must be mixed into the recording");
      assert.ok(power(500, 20000) > 0.01, "Alert must continue after the video capture ends");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("a silent camera recording gains a playable spoken-alert track", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sensara-silent-test-"));
  try {
    const video = join(directory, "silent.webm"), speech = join(directory, "speech.mp3");
    await run(executable, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x120:r=10:d=2", "-c:v", "libvpx-vp9", video]);
    await run(executable, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=500:duration=1", speech]);
    const result = await renderRecordingWithVoice(await readFile(video), await readFile(speech), "webm", 2);
    assert.equal(result.hasAudioTrack, true); assert.equal(result.hasEmbeddedVoice, true);
    assert.ok(result.durationSeconds >= 2 && result.durationSeconds < 2.5);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
