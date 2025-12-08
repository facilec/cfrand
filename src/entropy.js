import { sha3_512 as nobleSha3_512 } from '@noble/hashes/sha3';

const encoder = new TextEncoder();
const REQUEST_TIMEOUT_MS = 5000;
const RADAR_TOP_LIMITS = [512, 256, 128];
const CF_CRYPTO_BYTES = 64; // 512 bits

export async function generateEntropyResponse(env, { logger = console } = {}) {
  const fetchers = buildSourceFetchers(env);
  const results = await Promise.all(fetchers.map((fn) => fn(logger)));

  const drandOk = results.some((r) => r.id === 'drand' && r.ok);
  const cfCryptoOk = results.some((r) => r.id === 'cf_crypto_random_512' && r.ok);
  const radarOk = results.some((r) => r.tags?.includes('radar') && r.ok);
  const errorCount = results.filter((r) => !r.ok).length;
  const successChunks = results.filter((r) => r.ok && r.data instanceof Uint8Array);

  const baseResponse = {
    error_source_count: errorCount,
    sources: results.map(({ data, retryable, ...rest }) => rest),
  };

  if (!cfCryptoOk && !drandOk) {
    return {
      status: 500,
      body: { ...baseResponse, error: 'Core entropy sources are unavailable' },
    };
  }

  if (!radarOk) {
    return {
      status: 500,
      body: { ...baseResponse, error: 'Cloudflare Radar entropy is unavailable' },
    };
  }

  if (errorCount >= 3 || successChunks.length === 0) {
    return {
      status: 500,
      body: { ...baseResponse, error: 'Too many entropy sources failed' },
    };
  }

  const combined = concatByteArrays(successChunks.map((item) => item.data));
  const { bytes: digest, provider: hashProvider } = await computeDigest(combined, env);
  const responseBody = {
    ...baseResponse,
    hash_sha3_512: toHex(digest),
    hash_base64: toBase64(digest),
    hash_provider: hashProvider,
  };
  logger?.log?.('hash-provider', { provider: hashProvider });

  return {
    status: 200,
    body: responseBody,
  };
}

function buildSourceFetchers(env) {
  const fetchers = [];

  fetchers.push((logger) =>
    generateLocalEntropy({
      id: 'cf_crypto_random_512',
      length: CF_CRYPTO_BYTES,
      logger,
      tags: ['cf_crypto'],
    })
  );

  fetchers.push((logger) =>
    executeFetch({
      id: 'drand',
      url: 'https://api.drand.sh/public/latest',
      logger,
      required: true,
    })
  );

  fetchers.push(...buildRadarFetchers(env));

  fetchers.push((logger) =>
    executeFetch({
      id: 'openstreetmap_changesets',
      url: 'https://api.openstreetmap.org/api/0.6/changesets?limit=100',
      logger,
      tags: ['openstreetmap'],
    })
  );

  fetchers.push((logger) =>
    executeFetch({
      id: 'bitcoin_latest_block',
      url: 'https://blockchain.info/latestblock',
      logger,
      tags: ['blockchain', 'bitcoin'],
    })
  );

  fetchers.push((logger) =>
    executeFetch({
      id: 'ethereum_latest_block',
      url: 'https://api.blockchair.com/ethereum/blocks?limit=1',
      logger,
      tags: ['blockchain', 'ethereum'],
    })
  );

  return fetchers;
}

function buildRadarFetchers(env) {
  const token = env.CLOUDFLARE_TOKEN;
  const range = buildRadarRange();
  const query = `dateStart=${range.start}&dateEnd=${range.end}`;
  const base = 'https://api.cloudflare.com/client/v4';
  const headers = token
    ? {
        Authorization: `Bearer ${token}`,
      }
    : null;

  if (!headers) {
    return [
      async (logger) => ({
        id: 'cloudflare_radar_token',
        ok: false,
        error: 'Missing CLOUDFLARE_TOKEN binding',
        required: true,
        tags: ['radar'],
        duration_ms: 0,
        bytes: 0,
      }),
    ];
  }

  const fetchers = [];

  const radarTop = [
    {
      id: 'cloudflare_radar_http_top_ases',
      builder: (limit) => `${base}/radar/http/top/ases?limit=${limit}&${query}`,
    },
  ];

  radarTop.forEach((def) => {
    fetchers.push((logger) =>
      fetchRadarWithFallback({
        id: def.id,
        headers,
        logger,
        urlFactory: (limit) => def.builder(limit ?? 256),
      })
    );
  });

  const radarSummaries = [
    'http_version',
    'tls_version',
    'os',
    'ip_version',
    'device_type',
    'bot_class',
  ];

  radarSummaries.forEach((dimension) => {
    fetchers.push((logger) =>
      executeFetch({
        id: `cloudflare_radar_http_summary_${dimension}`,
        url: `${base}/radar/http/summary/${dimension}?${query}`,
        init: { headers },
        logger,
        tags: ['radar'],
        validator: radarValidator,
      })
    );
  });

  fetchers.push((logger) =>
    executeFetch({
      id: 'cloudflare_radar_http_timeseries_requests',
      url: `${base}/radar/http/timeseries?name=requests&${query}`,
      init: { headers },
      logger,
      tags: ['radar'],
      validator: radarValidator,
    })
  );

  ['tls_version', 'post_quantum'].forEach((dimension) => {
    fetchers.push((logger) =>
      executeFetch({
        id: `cloudflare_radar_http_timeseries_groups_${dimension}`,
        url: `${base}/radar/http/timeseries_groups/${dimension}?${query}`,
        init: { headers },
        logger,
        tags: ['radar'],
        validator: radarValidator,
      })
    );
  });

  fetchers.push((logger) =>
    executeFetch({
      id: 'cloudflare_radar_dns_timeseries_queryCount',
      url: `${base}/radar/dns/timeseries?name=queryCount&${query}`,
      init: { headers },
      logger,
      tags: ['radar'],
      validator: radarValidator,
    })
  );

  const dnsSummaries = ['query_type', 'ip_version', 'response_code', 'cache_hit', 'protocol'];
  dnsSummaries.forEach((dimension) => {
    fetchers.push((logger) =>
      executeFetch({
        id: `cloudflare_radar_dns_summary_${dimension}`,
        url: `${base}/radar/dns/summary/${dimension}?${query}`,
        init: { headers },
        logger,
        tags: ['radar'],
        validator: radarValidator,
      })
    );
  });

  return fetchers;
}

async function fetchRadarWithFallback({ id, headers, logger, urlFactory }) {
  let lastResult = null;
  for (const limit of RADAR_TOP_LIMITS) {
    const url = urlFactory(limit);
    const result = await executeFetch({
      id,
      url,
      init: { headers },
      logger,
      tags: ['radar'],
      validator: radarValidator,
    });

    if (result.ok) {
      return result;
    }

    lastResult = result;
  }

  return lastResult ?? {
    id,
    ok: false,
    error: 'Radar fetch failed',
    tags: ['radar'],
    bytes: 0,
    duration_ms: 0,
  };
}

function buildRadarRange(hours = 24) {
  const end = new Date();
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000);
  return {
    start: toRadarISO(start),
    end: toRadarISO(end),
  };
}

function toRadarISO(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function executeFetch({ id, url, init = {}, logger, required = false, tags = [], validator }) {
  const started = Date.now();
  const headers = { ...(init.headers || {}) };
  const requestInit = {
    ...init,
    method: init.method || 'GET',
    headers,
    cache: 'no-store',
    signal: createTimeoutSignal(REQUEST_TIMEOUT_MS),
  };

  let response;
  try {
    response = await fetch(url, requestInit);
  } catch (error) {
    const duration = Date.now() - started;
    const result = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: duration,
      tags,
      bytes: 0,
      required,
    };
    logger?.warn?.('entropy-source-error', { id, error: result.error, duration });
    return result;
  }

  const duration = Date.now() - started;
  const fetchedAt = new Date().toISOString();

  if (!response.ok) {
    const result = {
      id,
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}`,
      duration_ms: duration,
      tags,
      bytes: 0,
      required,
    };
    logger?.warn?.('entropy-source-http', { id, status: response.status, duration });
    return result;
  }

  const bodyText = await response.text();
  if (validator) {
    const validation = validator(bodyText);
    if (!validation.ok) {
      const result = {
        id,
        ok: false,
        status: response.status,
        error: validation.message || 'Radar API returned success=false',
        duration_ms: duration,
        tags,
        bytes: 0,
        required,
      };
      logger?.warn?.('entropy-source-validation', { id, error: result.error });
      return result;
    }
  }

  const encoded = encoder.encode(bodyText);
  const result = {
    id,
    ok: true,
    status: response.status,
    bytes: encoded.length,
    duration_ms: duration,
    fetched_at: fetchedAt,
    tags,
    required,
    data: encoded,
  };
  logger?.log?.('entropy-source', { id, bytes: encoded.length, duration });
  return result;
}

function generateLocalEntropy({ id, length, logger, tags = [] }) {
  const started = Date.now();
  try {
    const data = getRandomBytes(length);
    const duration = Date.now() - started;
    const result = {
      id,
      ok: true,
      bytes: data.length,
      duration_ms: duration,
      fetched_at: new Date().toISOString(),
      tags,
      data,
    };
    logger?.log?.('entropy-source', { id, bytes: data.length, duration });
    return Promise.resolve(result);
  } catch (error) {
    const duration = Date.now() - started;
    const result = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: duration,
      tags,
      bytes: 0,
    };
    logger?.warn?.('entropy-source-error', { id, error: result.error, duration });
    return Promise.resolve(result);
  }
}

function radarValidator(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.success === false) {
      const message = Array.isArray(parsed.errors)
        ? parsed.errors.map((e) => e.message).filter(Boolean).join('; ')
        : 'Radar API success=false';
      return { ok: false, message: message || 'Radar API returned an error', retryable: true };
    }
  } catch (error) {
    // Ignore JSON parse failures; raw text will still be hashed.
  }
  return { ok: true };
}

function concatByteArrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  return combined;
}

async function computeDigest(data, env) {
  if (shouldUseSha3(env)) {
    return { bytes: nobleSha3_512(data), provider: '@noble/hashes:sha3-512' };
  }

  if (typeof crypto !== 'undefined' && crypto?.subtle?.digest) {
    try {
      const buffer = await crypto.subtle.digest('SHA-512', getArrayBuffer(data));
      return { bytes: new Uint8Array(buffer), provider: 'webcrypto:SHA-512' };
    } catch (error) {
      // fall through to noble SHA3
    }
  }

  return { bytes: nobleSha3_512(data), provider: '@noble/hashes:sha3-512-fallback' };
}

function getRandomBytes(length) {
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues is not available');
  }
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return array;
}

function shouldUseSha3(env) {
  let value;
  if (env && env.USE_SHA3 !== undefined) {
    value = env.USE_SHA3;
  } else if (env && env.USE_NOBLE_SHA3 !== undefined) {
    value = env.USE_NOBLE_SHA3;
  } else if (typeof process !== 'undefined' && process.env) {
    value = process.env.USE_SHA3 ?? process.env.USE_NOBLE_SHA3;
  }
  if (value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function toBase64(bytes) {
  if (typeof btoa === 'function') {
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  throw new Error('Base64 encoding not supported in this environment');
}

function getArrayBuffer(uint8) {
  if (uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength) {
    return uint8.buffer;
  }
  return uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  if (typeof timeout.unref === 'function') {
    timeout.unref();
  }
  return controller.signal;
}
