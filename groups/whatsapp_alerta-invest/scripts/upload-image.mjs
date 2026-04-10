#!/usr/bin/env node
// Upload image to Cloudinary and return public URL
// Env: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
// Input (stdin): { imagePath: "/path/to/file.png" }

import { createHash, createHmac } from 'crypto';
import { readFileSync } from 'fs';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  console.log(JSON.stringify({ error: 'Missing CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, or CLOUDINARY_API_SECRET' }));
  process.exit(1);
}

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const { imagePath } = input;

if (!imagePath) {
  console.log(JSON.stringify({ error: 'Missing imagePath' }));
  process.exit(1);
}

try {
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'alerta-invest';
  const paramsToSign = `folder=${folder}&timestamp=${timestamp}`;
  const signature = createHash('sha1').update(paramsToSign + API_SECRET).digest('hex');

  const imageBuffer = readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const formData = new URLSearchParams();
  formData.append('file', `data:image/png;base64,${base64Image}`);
  formData.append('timestamp', timestamp.toString());
  formData.append('api_key', API_KEY);
  formData.append('signature', signature);
  formData.append('folder', folder);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    { method: 'POST', body: formData }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || JSON.stringify(data));

  console.log(JSON.stringify({
    success: true,
    url: data.secure_url,
    public_id: data.public_id,
    width: data.width,
    height: data.height,
  }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
