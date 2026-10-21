import { spawn } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import assert from 'node:assert/strict';
if (process.env.SENSARA_LIVE_TESTS !== '1' || !process.env.MONGODB_DB?.startsWith('sensara_verification_')) throw new Error('Isolated verification database required');
const password = randomBytes(24).toString('hex'), salt = randomBytes(16).toString('hex');
const account = {id:'test-caregiver',name:'Test Caregiver',role:'caregiver',patientIds:['resident_001'],passwordHash:`${salt}:${scryptSync(password,salt,64).toString('hex')}`};
const origin = 'http://127.0.0.1:3004';
const server = spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3004'],{env:{...process.env,LOCAL_DEMO_MODE:'false',NOTIFICATION_WORKER_ENABLED:'false',APP_ORIGIN:origin,AUTH_SESSION_SECRET:randomBytes(32).toString('hex'),STAFF_ACCOUNTS_JSON:JSON.stringify([account,{...account,id:'test-viewer',role:'viewer'}])},stdio:'ignore'});
try {
  let ready=false; for(let i=0;i<20;i++){try{if((await fetch(`${origin}/api/health`)).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,500));} assert.ok(ready);
  assert.equal((await fetch(`${origin}/api/residents`)).status,401);
  const login=async id=>{const r=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({id,password})});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
  const cookie=await login('test-caregiver');
  const patients=await (await fetch(`${origin}/api/residents`,{headers:{cookie}})).json();assert.deepEqual(patients.residents.map(p=>p.id),['resident_001']);
  assert.equal((await fetch(`${origin}/api/residents/resident_002`,{headers:{cookie}})).status,404);
  assert.equal((await fetch(`${origin}/api/settings`,{method:'PATCH',headers:{cookie,origin,'content-type':'application/json'},body:'{}'})).status,403);
  const viewer=await login('test-viewer');
  assert.equal((await fetch(`${origin}/api/events`,{method:'POST',headers:{cookie:viewer,origin,'content-type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(`${origin}/api/events`,{headers:{cookie:`${cookie}tampered`}})).status,401);
  console.log('PASS: real HTTP sign-in, signed cookie, patient scope, admin/viewer restrictions and tamper rejection with local bypass disabled.');
} finally {server.kill('SIGTERM');}
