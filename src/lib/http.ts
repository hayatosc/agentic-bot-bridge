export const MAX_BODY_BYTES = 256 * 1024
export const HTTP_TIMEOUT_MS = 10_000

export function trustedHttpsUrl(value: string, hosts: readonly string[]): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !hosts.includes(url.hostname) ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) ||
    /^[0-9.]+$/.test(url.hostname) ||
    /\.(localhost|local|internal|test|invalid)$/.test(url.hostname)
  ) {
    throw new Error('Untrusted HTTPS destination')
  }
  return url
}

export function callbackHosts(value: string): string[] {
  return value
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
}

export function jsonBody(value: unknown): string {
  const body = JSON.stringify(value)
  if (body === undefined || new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new Error('Payload exceeds 256 KiB')
  }
  return body
}

// Bound the receiver's response as well as our outbound request.
export async function readSmallJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 4096) throw new Error('Response too large')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return JSON.parse(text + decoder.decode())
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
