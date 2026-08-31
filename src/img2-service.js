import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { IMAGE_API_TIMEOUT_MS, requestLumioImage as defaultRequestLumioImage } from './img2-client.js';

const DEFAULT_IMAGE_SIZE = '1024x1024';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.resolve(MODULE_DIR, '../.env');
const IMG2_CACHE_ROOT_DIR = path.resolve(MODULE_DIR, '../cache');
const IMG2_OUTPUT_CACHE_DIR = path.resolve(MODULE_DIR, '../cache/img2_outputs');

function readEnvFileKey(name) {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (key !== name) {
        continue;
      }

      return trimmed.slice(separatorIndex + 1).trim();
    }
  } catch {
    return '';
  }

  return '';
}

function getApiKey() {
  const apiKey = process.env.LUMIO_IMAGE_API_KEY || readEnvFileKey('LUMIO_IMAGE_API_KEY');
  if (!apiKey) {
    throw new Error('Missing LUMIO_IMAGE_API_KEY');
  }

  return apiKey;
}

export async function generateImg2({ prompt, imageUrls, size = DEFAULT_IMAGE_SIZE, dependencyOverrides = {} }) {
  const normalizedPrompt = String(prompt ?? '').trim();
  if (!normalizedPrompt) {
    throw new Error('Missing prompt');
  }

  const normalizedImageUrls = Array.isArray(imageUrls)
    ? imageUrls.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    : [];

  const requestLumioImage = dependencyOverrides.requestLumioImage ?? defaultRequestLumioImage;

  return requestLumioImage({
    apiKey: getApiKey(),
    prompt: normalizedPrompt,
    imageUrls: normalizedImageUrls,
    size,
    cacheDirectory: dependencyOverrides.cacheDirectory ?? IMG2_CACHE_ROOT_DIR,
  });
}

export function getImageApiTimeoutSeconds() {
  return IMAGE_API_TIMEOUT_MS / 1000;
}

export function buildImageMessage(outputImage) {
  if (outputImage.type === 'url') {
    return [{ type: 'image', data: { file: outputImage.value } }];
  }

  if (outputImage.type === 'file') {
    let normalizedPath = String(outputImage.value).replace(/\\/g, '/');

    const wslPathMatch = normalizedPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (wslPathMatch) {
      const drive = wslPathMatch[1].toUpperCase();
      const rest = wslPathMatch[2].replace(/\//g, '\\');
      return [{ type: 'image', data: { file: `${drive}:\\${rest}` } }];
    }

    return [{ type: 'image', data: { file: `file:///${normalizedPath}` } }];
  }

  if (outputImage.type === 'base64') {
    return [{ type: 'image', data: { file: `base64://${outputImage.value}` } }];
  }

  throw new Error('Unsupported output image type');
}

export function getImg2CacheDir() {
  return IMG2_OUTPUT_CACHE_DIR;
}

export function persistOutputImage(outputImage, dependencyOverrides = {}) {
  const cacheDirectory = dependencyOverrides.cacheDirectory ?? IMG2_CACHE_ROOT_DIR;
  const outputCacheDir = typeof cacheDirectory === 'object' && cacheDirectory !== null
    ? cacheDirectory.output ?? IMG2_OUTPUT_CACHE_DIR
    : cacheDirectory === IMG2_CACHE_ROOT_DIR ? IMG2_OUTPUT_CACHE_DIR : path.join(cacheDirectory, 'img2_outputs');
  fs.mkdirSync(outputCacheDir, { recursive: true });

  if (outputImage.type === 'url' || outputImage.type === 'file') {
    return outputImage;
  }

  throw new Error('Unsupported output image type');
}
