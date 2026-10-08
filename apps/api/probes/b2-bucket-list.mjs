import { createStorage } from '../src/storage.js';

const s = createStorage({
  dataDir: '/tmp/oca-probe-data',
  storageDriver: 'auto',
  b2: {
    keyId: process.env.B2_KEY_ID,
    applicationKey: process.env.B2_APPLICATION_KEY,
    bucket: process.env.B2_BUCKET_NAME,
  },
});

const list = await s.list('captures/');

console.log(JSON.stringify(
  {
    kind: s.kind,
    describe: s.describe(),
    listed: list.slice(0, 50).map((o) => ({
      key: o.key,
      length: o.length,
      contentType: o.contentType,
      fileId: o.fileId || null,
    })),
    listedCount: list.length,
  },
  null,
  2,
));
