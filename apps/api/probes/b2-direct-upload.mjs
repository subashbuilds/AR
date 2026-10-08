import { createServer } from '../src/server.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = path.join(here, '..', 'data', 'probes', 'b2-direct-upload-test');
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });

const server = createServer({ dataDir: tmpRoot });
const port = 8790;
const base = `http://127.0.0.1:${port}`;
await new Promise((resolve) => server.listen({ port, host: '127.0.0.1' }, resolve));
console.log('PROBE_BASE=' + base);

const cookies = [];

async function request(method, url, body, { extraHeaders = {} } = {}) {
  const reqHeaders = {};
  if (cookies.length) reqHeaders.cookie = cookies.join('; ');
  if (body !== undefined && body !== null) reqHeaders['content-type'] = 'application/json';
  const res = await fetch(base + url, {
    method,
    headers: reqHeaders,
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  for (const raw of res.headers.getSetCookie()) {
    const idx = raw.indexOf('=');
    cookies.push(raw.slice(0, idx) + '=' + raw.slice(idx + 1));
  }
  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  console.log(`${method} ${url} → ${res.status}`, payload && payload.error ? payload.error.message : JSON.stringify(payload).slice(0, 220));
  return { status: res.status, payload, text };
}

const existingSignup = await request('POST', '/api/auth/signup', {
  email: 'probe+b2-direct@example.test',
  password: 'probe-direct-upload-password',
  name: 'B2 Direct Probe',
});
console.log('SIGNUP_STATUS=' + existingSignup.status);

const health = (await request('GET', '/api/health')).payload;
console.log('STORAGE=' + JSON.stringify(health.storage));
console.log('RETENTION=' + JSON.stringify(health.retention));

const direct = await request('POST', '/api/captures/uploads', {
  name: 'b2-direct-probe-' + Date.now(),
  images: [
    { contentType: 'image/png', bytes: 67 },
    { contentType: 'image/png', bytes: 67 },
  ],
  scale_calibration: { value: 1.0, unit: 'm', source: 'probe' },
});
const captureId = direct.payload?.id;
console.log('CAPTURE_ID=' + captureId);

if (direct.status === 201 && captureId && Array.isArray(direct.payload?.uploads)) {
  const manifest = direct.payload.uploads;
  console.log('UPLOADS=' + JSON.stringify(manifest));

  // B2 only verifies length + sha1 for these probe uploads, so a tiny valid PNG
  // header is enough to make the object non-empty and served later.
  const png = (len) => {
    const buf = Buffer.alloc(Math.max(67, len));
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    return buf;
  };

  const payloads = [png(67), png(67)];

  for (let i = 0; i < manifest.length; i++) {
    const target = manifest[i];
    if (!target?.url) {
      console.log(`UPLOAD_${i}: no url`);
      continue;
    }
    const sha1 = crypto.createHash('sha1').update(payloads[i]).digest('hex');
    const uploadHeaders = {
      ...(target.headers || {}),
      'x-bz-content-sha1': sha1,
      'content-length': String(payloads[i].length),
    };
    const uploadRes = await fetch(target.url, {
      method: 'POST',
      headers: uploadHeaders,
      body: payloads[i],
    });
    const uploadText = await uploadRes.text();
    console.log(`UPLOAD_${i} → ${uploadRes.status} ${uploadText.slice(0, 120)}`);
  }

  const complete = await request('POST', `/api/captures/${captureId}/uploads/complete`, {
    images: manifest.map((target, i) => ({
      key: target.key || `captures/${captureId}/photo_${i + 1}.png`,
      size: payloads[i].length,
      sha1: crypto.createHash('sha1').update(payloads[i]).digest('hex'),
    })),
  });
  console.log('COMPLETE_STATUS=' + complete.status);
}

await new Promise((resolve) => server.close(resolve));
console.log('PROBE_DONE');
