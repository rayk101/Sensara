import assert from 'node:assert/strict';
const base = process.env.BASE_URL || 'http://127.0.0.1:3002';
const request = async path => { const r = await fetch(`${base}${path}`); assert.equal(r.status,200,path); return r.json(); };
assert.equal((await request('/api/health')).ready,true);
const { residents } = await request('/api/residents'); assert.ok(Array.isArray(residents));
const { events } = await request('/api/events?limit=100'); assert.ok(Array.isArray(events));
assert.ok(Array.isArray((await request('/api/observations')).patients));
assert.ok(Array.isArray((await request('/api/notifications')).notifications));
assert.ok((await request('/api/settings')).retentionDays > 0);
assert.equal((await fetch(`${base}/api/events?limit=-1`)).status,400);
assert.equal((await fetch(`${base}/api/events`, {method:'POST',headers:{origin:'https://untrusted.invalid','content-type':'application/json'},body:'{}'})).status,403);
for (const file of ['fall-demo.mp4','stable-demo.mp4','wandering-demo.mp4','choking-demo.mp4']) {
  const r = await fetch(`${base}/demo-videos/${file}`, {method:'HEAD'}); assert.equal(r.status,200); assert.ok(Number(r.headers.get('content-length')) > 0);
}
console.log('PASS: live HTTP health, scoped patient/event/notification/monitoring reads, preferences, invalid-input and origin checks, four video assets. No provider sends or data mutations.');
