import { test } from "node:test";
import assert from "node:assert/strict";
import { transcribeAudioWithElevenLabs, classifyAudioTranscript } from "../src/lib/elevenlabs";

test("Scribe audio-event words reach distress classification", async (t) => {
  const previousKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test-only";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = previousKey;
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const form = init.body as FormData;
    assert.equal(form.get("model_id"), "scribe_v2");
    assert.equal(form.get("timestamps_granularity"), "word");
    assert.equal((form.get("file") as File).name, "audio.wav");
    return Response.json({ text: "", words: [
      { type: "audio_event", text: "(Coughing)" },
      { type: "audio_event", text: "(Coughing)" },
      { type: "word", text: "hello" },
    ] });
  });
  const result = await transcribeAudioWithElevenLabs(Buffer.from("test audio"), "audio/wav");
  assert.deepEqual(result.audioTags, ["(coughing)"]);
  assert.equal(classifyAudioTranscript(result.transcript, result.audioTags).eventType, "possible_distress_sound");
});

test("provider failures do not include the provider response body", async (t) => {
  const previousKey = process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_API_KEY = "test-only";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = previousKey;
  });
  t.mock.method(globalThis, "fetch", async () => new Response("private provider details", { status: 401 }));
  await assert.rejects(transcribeAudioWithElevenLabs(Buffer.from("test"), "audio/webm"),
    { message: "ElevenLabs STT request failed (HTTP 401)" });
});
