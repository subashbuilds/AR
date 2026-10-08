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

const name = s.keyFor('captures/test-upload-photo-1.jpg');
const presigned = await s.presign({ key: 'captures/test-upload-photo-1.jpg', contentType: 'image/jpeg' });

console.log(JSON.stringify(
  {
    kind: s.kind,
    supportsDirectUploads: s.supportsDirectUploads,
    describe: s.describe(),
    warnings: s.warnings || null,
    objectKey: name,
    presigned: presigned
      ? {
          url: presigned.url,
          headers: {
            authorization: (presigned.headers?.authorization || '').slice(0, 16) + '…',
            'x-bz-file-name': presigned.headers?.['x-bz-file-name'],
            'content-type': presigned.headers?.['content-type'],
          },
        }
      : null,
  },
  null,
  2,
));
