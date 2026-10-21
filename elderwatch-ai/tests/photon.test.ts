import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhotonAlertSender, isPhotonConfigured, photonErrorMessage } from "../src/lib/photon";
import type { SafetyEvent } from "../src/lib/types";

const event = { residentId: "demo", severity: "urgent", eventType: "possible_fall" } as SafetyEvent;

test("Photon errors explain recipient rejection without exposing provider details", () => {
  assert.match(photonErrorMessage(new Error("Target not allowed for this project")), /Enroll the exact phone number/);
  assert.doesNotMatch(photonErrorMessage(new Error("private token and details")), /private token/);
});

test("Photon skips nonurgent events, suppresses concurrent duplicates, and expires cooldown", async () => {
  let time = 0;
  let calls = 0;
  let complete: () => void = () => {};
  const send = createPhotonAlertSender(async body => {
    calls++;
    assert.match(body, /DEMO urgent alert: possible fall/);
    await new Promise<void>(resolve => { complete = resolve; });
  }, () => time);
  await send({ ...event, severity: "watch" });
  assert.equal(calls, 0);
  const first = send(event);
  await send(event);
  assert.equal(calls, 1);
  complete();
  await first;
  await send(event);
  assert.equal(calls, 1);
  time = 120_000;
  const second = send(event);
  complete();
  await second;
  assert.equal(calls, 2);
});

test("Photon releases failed reservations and keeps resident cooldowns separate", async () => {
  let calls = 0;
  const send = createPhotonAlertSender(async () => {
    if (++calls === 1) throw new Error("offline");
  });
  await assert.rejects(send(event), /offline/);
  await send(event);
  await send({ ...event, residentId: "other-demo" });
  assert.equal(calls, 3);
});

test("Photon requires credentials and an international recipient number", t => {
  const keys = ["SPECTRUM_PROJECT_ID", "SPECTRUM_PROJECT_SECRET", "CAREGIVER_PHONE_NUMBER"] as const;
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  process.env.SPECTRUM_PROJECT_ID = "test-project";
  process.env.SPECTRUM_PROJECT_SECRET = "test-secret";
  process.env.CAREGIVER_PHONE_NUMBER = "5551234567";
  assert.equal(isPhotonConfigured(), false);
  process.env.CAREGIVER_PHONE_NUMBER = "+15551234567";
  assert.equal(isPhotonConfigured(), true);
  delete process.env.SPECTRUM_PROJECT_SECRET;
  assert.equal(isPhotonConfigured(), false);
});
