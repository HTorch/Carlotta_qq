import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE_API_TIMEOUT_MS = 600000;

const MAX_UPSTREAM_RETRIES = 2;
const UPSTREAM_RETRY_DELAY_MS = 2000;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const IMG2_CACHE_ROOT_DIR = path.resolve(MODULE_DIR, '../cache');
const IMG2_REFERENCE_CACHE_DIR = path.resolve(MODULE_DIR, '../cache/img2_references');
const IMG2_OUTPUT_CACHE_DIR = path.resolve(MODULE_DIR, '../cache/img2_outputs');
const LUMIO_GENERATE_URL = 'https://example.invalid/image-api/v1/images/generations';
const LUMIO_EDITS_URL = 'https://example.invalid/image-api/v1/images/edits';
const LUMIO_MODEL = 'gpt-image-2';
const QQ_INTERNAL_IMAGE_HOSTS = new Set(['media.example.invalid', 'media.example.invalid']);

function resolveCacheDirectories(cacheDirectory = IMG2_CACHE_ROOT_DIR) {
  if (typeof cacheDirectory === 'object' && cacheDirectory !== null) {
    return {
      reference: cacheDirectory.reference ?? IMG2_REFERENCE_CACHE_DIR,
      output: cacheDirectory.output ?? IMG2_OUTPUT_CACHE_DIR,
    };
  }

  if (cacheDirectory === IMG2_CACHE_ROOT_DIR) {
    return {
      reference: IMG2_REFERENCE_CACHE_DIR,
      output: IMG2_OUTPUT_CACHE_DIR,
    };
  }

  return {
    reference: path.join(String(cacheDirectory), 'img2_references'),
    output: path.join(String(cacheDirectory), 'img2_outputs'),
  };
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function shouldUseRemoteReference(imageUrls) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return false;
  }

  for (const imageUrl of imageUrls) {
    if (!isHttpUrl(imageUrl)) {
      return false;
    }

    try {
      const host = new URL(imageUrl).hostname.toLowerCase();
      if (QQ_INTERNAL_IMAGE_HOSTS.has(host)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

function getContentTypeMime(contentType) {
  return String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
}

function getImageExtension(contentType) {
  const mimeType = getContentTypeMime(contentType);
  if (mimeType.includes('jpeg')) {
    return 'jpg';
  }

  const slashIndex = mimeType.indexOf('/');
  return slashIndex === -1 ? 'png' : mimeType.slice(slashIndex + 1) || 'png';
}

function buildJsonRequest({ apiKey, prompt, size, imageUrls }) {
  const payload = {
    model: LUMIO_MODEL,
    prompt,
    size,
  };

  if (imageUrls.length > 0) {
    payload.reference_images = imageUrls;
  }

  return {
    url: LUMIO_GENERATE_URL,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  };
}

async function fetchWithTimeout(fetchImpl, url, init) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_API_TIMEOUT_MS);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    const message = String(error?.message ?? error ?? '');
    if (error?.name === 'AbortError' || /aborted|timed out/i.test(message)) {
      throw new Error(`Image API request timed out after ${IMAGE_API_TIMEOUT_MS / 1000}s`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function downloadReferenceImage(fetchImpl, imageUrl, index, referenceCacheDir) {
  const response = await fetchWithTimeout(fetchImpl, imageUrl, {});
  if (!response.ok) {
    throw new Error(`Failed to download reference image: HTTP ${response.status}`);
  }

  const contentType = getContentTypeMime(response.headers.get('content-type')) || 'image/png';
  const filePath = path.join(referenceCacheDir, `reference-${index}.${getImageExtension(contentType)}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  await mkdir(referenceCacheDir, { recursive: true });
  await writeFile(filePath, buffer);

  return {
    filePath,
    contentType,
    buffer,
  };
}

async function buildMultipartRequest({ fetchImpl, apiKey, prompt, size, imageUrls, referenceCacheDir }) {
  const formData = new FormData();
  formData.append('model', LUMIO_MODEL);
  formData.append('prompt', prompt);
  formData.append('size', size);

  for (const [index, imageUrl] of imageUrls.entries()) {
    const { filePath, contentType, buffer } = await downloadReferenceImage(fetchImpl, imageUrl, index, referenceCacheDir);
    formData.append('image[]', new Blob([buffer], { type: contentType }), path.basename(filePath));
  }

  return {
    url: LUMIO_EDITS_URL,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    },
  };
}

async function buildRequest({ fetchImpl, apiKey, prompt, size, imageUrls, referenceCacheDir }) {
  if (imageUrls.length === 0 || shouldUseRemoteReference(imageUrls)) {
    return buildJsonRequest({ apiKey, prompt, size, imageUrls });
  }

  return buildMultipartRequest({ fetchImpl, apiKey, prompt, size, imageUrls, referenceCacheDir });
}

async function readErrorMessage(response) {
  const text = await response.text();
  if (!text.trim()) {
    return `Image API HTTP ${response.status}`;
  }

  try {
    const payload = JSON.parse(text);
    return payload?.error?.message || payload?.message || `Image API HTTP ${response.status}`;
  } catch {
    return text.slice(0, 500);
  }
}

async function persistBinaryOutput(response, outputCacheDir) {
  const contentType = getContentTypeMime(response.headers.get('content-type')) || 'application/octet-stream';
  const filePath = path.join(outputCacheDir, `${randomUUID()}.${getImageExtension(contentType)}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  await mkdir(outputCacheDir, { recursive: true });
  await writeFile(filePath, buffer);

  return {
    type: 'file',
    value: filePath,
  };
}

async function persistBase64Output(base64Value, outputCacheDir) {
  const filePath = path.join(outputCacheDir, `${randomUUID()}.png`);
  const buffer = Buffer.from(base64Value, 'base64');

  await mkdir(outputCacheDir, { recursive: true });
  await writeFile(filePath, buffer);

  return {
    type: 'file',
    value: filePath,
  };
}

async function readSuccessOutput(response, outputCacheDir) {
  const contentType = getContentTypeMime(response.headers.get('content-type'));
  if (contentType.startsWith('image/')) {
    return persistBinaryOutput(response, outputCacheDir);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error('Image API returned empty response');
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Image API returned non-JSON success response: ${text.slice(0, 200)}`);
  }

  const data = payload?.data;
  const firstData = Array.isArray(data) ? data[0] : data;
  if (firstData && typeof firstData === 'object') {
    if (typeof firstData.url === 'string' && firstData.url) {
      return { type: 'url', value: firstData.url };
    }

    if (typeof firstData.b64_json === 'string' && firstData.b64_json) {
      return persistBase64Output(firstData.b64_json, outputCacheDir);
    }
  }

  if (typeof payload?.url === 'string' && payload.url) {
    return { type: 'url', value: payload.url };
  }

  if (typeof payload?.b64_json === 'string' && payload.b64_json) {
    return persistBase64Output(payload.b64_json, outputCacheDir);
  }

  throw new Error('Image API returned unsupported payload');
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function requestLumioImage({ apiKey, prompt, imageUrls, size, cacheDirectory = IMG2_CACHE_ROOT_DIR }) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this runtime');
  }

  let lastError = null;
  const cacheDirectories = resolveCacheDirectories(cacheDirectory);

  for (let attempt = 0; attempt <= MAX_UPSTREAM_RETRIES; attempt += 1) {
    try {
      const request = await buildRequest({
        fetchImpl,
        apiKey,
        prompt,
        size,
        imageUrls,
        referenceCacheDir: cacheDirectories.reference,
      });
      const response = await fetchWithTimeout(fetchImpl, request.url, request.init);

      if (!response.ok) {
        const message = await readErrorMessage(response);
        if (/Upstream request failed/i.test(message) && attempt < MAX_UPSTREAM_RETRIES) {
          await sleep(UPSTREAM_RETRY_DELAY_MS);
          continue;
        }

        throw new Error(message);
      }

      return await readSuccessOutput(response, cacheDirectories.output);
    } catch (error) {
      lastError = error;
      const message = String(error?.message ?? error ?? '');
      if (attempt < MAX_UPSTREAM_RETRIES && (/Failed to download reference image/i.test(message) || /fetch failed/i.test(message) || /timed out/i.test(message))) {
        await sleep(UPSTREAM_RETRY_DELAY_MS);
        continue;
      }

      break;
    }
  }

  throw lastError ?? new Error('img2 failed');
}
