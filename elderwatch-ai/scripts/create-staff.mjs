// Prints a password hash account entry only; the password is read from stdin.
import { randomBytes, scryptSync } from 'node:crypto';
const [id, name, role = 'caregiver', ids = ''] = process.argv.slice(2);
if (!id || !name || !['admin','caregiver','viewer'].includes(role)) throw new Error('Usage: node scripts/create-staff.mjs ID NAME ROLE patientId,patientId < private-password-file');
let password = ''; for await (const chunk of process.stdin) password += chunk;
password = password.trimEnd(); if (password.length < 12) throw new Error('Use at least 12 characters');
const salt = randomBytes(16).toString('hex');
console.log(JSON.stringify({ id, name, role, patientIds: ids.split(',').filter(Boolean), passwordHash: `${salt}:${scryptSync(password,salt,64).toString('hex')}`, active: true }));
