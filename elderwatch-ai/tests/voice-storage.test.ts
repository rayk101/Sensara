import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { recordingSpeech } from "../src/lib/platform/voice";
import { getS3Client } from "../src/lib/s3";
import { readRecord } from "../src/lib/platform/store";
import { generateMockEvents } from "../src/lib/mockData";

test("new spoken alerts persist in the database without recreating an S3 voice folder", async t => {
  delete process.env.MONGODB_URI;
  Object.assign(process.env, { AWS_REGION: "us-east-1", S3_VIDEO_BUCKET: "test-clips", ELEVENLABS_API_KEY: "test", ELEVENLABS_VOICE_ID: "test" });
  let generated = 0;
  t.mock.method(globalThis, "fetch", async () => { generated++; return new Response(new Uint8Array([1, 2, 3])); });
  t.mock.method(getS3Client(), "send", async () => { throw new Error("Voice generation must not write to S3"); });
  const event = { ...generateMockEvents()[0], _id: randomUUID() };
  await recordingSpeech(event);
  const asset = await readRecord("voice_assets", event._id);
  assert.equal(asset?.audioBase64, "AQID"); assert.equal(asset?.s3Key, undefined);
  assert.deepEqual(await recordingSpeech(event), Buffer.from([1, 2, 3]));
  assert.equal(generated, 1);
});
