import { env } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import type { JWK } from 'jose'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import app from '../src/app'
import type { Agent, Bindings } from '../src/env'
import { subscribeResultSchema, subscribeSchema } from '../src/events/schema'
import { EventService } from '../src/events/service'
import { SUBSCRIPTION_KEY, SubscriptionStore } from '../src/events/store'
import { fromBase64, toBase64 } from '../src/lib/crypto'
import { MAX_BODY_BYTES, trustedHttpsUrl } from '../src/lib/http'

declare global {
  namespace Cloudflare {
    interface Env {
      SUBSCRIPTIONS: KVNamespace
    }
  }
}

const issuer = 'https://bridge-tests.cloudflareaccess.com'
const origin = 'https://bridge.example.com'
const callback = 'https://receiver.example.com/events/private-callback'
const secret = `whsec_${toBase64(new Uint8Array(32).fill(7))}`
const replacement = `whsec_${toBase64(new Uint8Array(32).fill(8))}`
const bindings: Bindings = {
  SUBSCRIPTIONS: env.SUBSCRIPTIONS,
  ACCESS_TEAM_DOMAIN: issuer,
  ACCESS_AUD: 'bridge-audience',
  ACCESS_OWNER_SUB: 'owner-subject',
  PUBLIC_ORIGIN: origin,
  DOTS_CALLBACK_HOSTS: 'receiver.example.com',
  GROK_WEBHOOK_URL: 'https://grok.example.com/routine',
  GROK_WEBHOOK_KEY: 'test-key',
  SUBSCRIPTION_ENCRYPTION_KEY: toBase64(new Uint8Array(32).fill(1)),
}

const subscribeParams = {
  name: 'message.created',
  arguments: {},
  delivery: { mode: 'webhook', url: callback, secret },
}
const message = { message_id: 'unique-message', text: 'こんにちは 👋\n"quoted"', final: false }
const rpcEnvelope = z.object({
  result: z.record(z.string(), z.unknown()).optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
})

let signingKey: CryptoKey
let jwk: JWK
let requests: Request[]
let receiver: (request: Request) => Promise<Response>

async function token(
  options: { subject?: string; audience?: string; issuer?: string; expiry?: number } = {},
) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(options.subject ?? bindings.ACCESS_OWNER_SUB)
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? bindings.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(options.expiry ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(signingKey)
}

async function call(
  method: string,
  params: Record<string, unknown> = {},
  agent: Agent = 'dots',
  customBindings = bindings,
) {
  const response = await app.request(
    `${origin}/${agent}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'MCP-Method': method,
        ...(method === 'tools/call' && typeof params.name === 'string'
          ? { 'MCP-Name': params.name }
          : {}),
        'Cf-Access-Jwt-Assertion': await token(),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    },
    customBindings,
  )
  const body: unknown = await response.json()
  const parsed = rpcEnvelope.parse(body)
  expect(response.status, JSON.stringify(body)).toBe(parsed.error?.code === -32601 ? 404 : 200)
  return parsed
}

async function subscribe() {
  const response = await call('events/subscribe', subscribeParams)
  expect(response.error).toBeUndefined()
  return subscribeResultSchema.parse(response.result)
}

async function verifySignature(request: Request, signingSecret = secret) {
  const id = request.headers.get('webhook-id')
  const timestamp = request.headers.get('webhook-timestamp')
  const signatureHeader = request.headers.get('webhook-signature') ?? ''
  const bytes = new TextEncoder().encode(`${id}.${timestamp}.${await request.clone().text()}`)
  const key = await crypto.subtle.importKey(
    'raw',
    fromBase64(signingSecret.slice(6)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  for (const signature of signatureHeader.split(' ')) {
    if (
      signature.startsWith('v1,') &&
      (await crypto.subtle.verify('HMAC', key, fromBase64(signature.slice(3)), bytes))
    )
      return true
  }
  return false
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256', { extractable: true })
  signingKey = keys.privateKey
  jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
})

beforeEach(async () => {
  vi.spyOn(console, 'info').mockImplementation(() => {})
  await bindings.SUBSCRIPTIONS.delete(SUBSCRIPTION_KEY)
  requests = []
  receiver = async (request) => {
    const body: unknown = await request.clone().json()
    const challenge = z
      .object({ type: z.literal('verification'), challenge: z.string() })
      .safeParse(body)
    return challenge.success
      ? Response.json({ challenge: challenge.data.challenge })
      : Response.json({ ok: true })
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init)
    if (request.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] })
    requests.push(request.clone())
    return receiver(request)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Access and MCP transport', () => {
  it('records only the route and response status for request diagnostics', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const response = await app.request(
      `${origin}/dots?token=private-query`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer private-token' },
        body: 'private-message',
      },
      bindings,
    )
    expect(response.status).toBe(401)
    expect(info.mock.calls).toEqual([['bridge.request.completed', { route: '/dots', status: 401 }]])
  })

  it('requires the same Access authentication on every path, including the root', async () => {
    for (const path of ['/', '/dots', '/grok', '/unknown']) {
      expect((await app.request(`${origin}${path}`, {}, bindings)).status).toBe(401)
    }
    const assertion = await token()
    const root = await app.request(
      origin,
      { headers: { 'Cf-Access-Jwt-Assertion': assertion } },
      bindings,
    )
    expect(root.status).toBe(200)
    expect(await root.json()).toMatchObject({ name: 'agentic-bot-bridge' })
  })

  it.each(['dots', 'grok'] as const)(
    'connects the official SDK client over HTTP to %s',
    async (agent) => {
      const client = new Client(
        { name: 'integration-test', version: '1' },
        {
          versionNegotiation: { mode: agent === 'dots' ? { pin: '2026-07-28' } : 'legacy' },
        },
      )
      const assertion = await token()
      const transport = new StreamableHTTPClientTransport(new URL(`${origin}/${agent}`), {
        fetch: (input, init) => {
          const request = new Request(input, init)
          request.headers.set('Cf-Access-Jwt-Assertion', assertion)
          return Promise.resolve(app.fetch(request, bindings))
        },
      })
      try {
        await client.connect(transport)
        const catalog = await client.listTools()
        expect(catalog.tools.map((tool) => tool.name)).toEqual(['send_message'])
        if (agent === 'dots') {
          const subscribed = await client.request(
            { method: 'events/subscribe', params: subscribeParams },
            subscribeResultSchema,
          )
          expect(subscribed.id).toMatch(/^sub_/)
          const delivered = await client.callTool({ name: 'send_message', arguments: message })
          expect(delivered).toMatchObject({ structuredContent: { status: 'accepted' } })
        } else {
          const delivered = await client.callTool({ name: 'send_message', arguments: message })
          expect(delivered).toMatchObject({
            structuredContent: { status: 'failed', reason: 'no_active_subscription' },
          })
        }
      } finally {
        await client.close()
      }
    },
  )

  it('advertises Events only on dots using MCP 2.0 discovery', async () => {
    const dots = await call('server/discover')
    expect(dots.result).toMatchObject({
      resultType: 'complete',
      capabilities: { events: {}, tools: { listChanged: false } },
      supportedVersions: ['2026-07-28'],
    })
    const grok = await call('server/discover', {}, 'grok')
    expect(grok.result?.capabilities).not.toHaveProperty('events')
    expect((await call('events/list', {}, 'grok')).error?.code).toBe(-32601)
    const catalog = await call('events/list')
    expect(catalog.result).toMatchObject({
      events: [{ name: 'message.created', delivery: ['webhook'] }],
    })
  })

  it('exposes one fixed-recipient tool with a structured result schema', async () => {
    const result = await call('tools/list')
    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({
      tools: [{ name: 'send_message', annotations: { idempotentHint: false } }],
    })
  })

  it.each([
    ['missing', '', 401],
    ['forged', 'not-a-jwt', 401],
    ['wrong-audience', 'audience', 401],
    ['wrong-owner', 'owner', 403],
    ['wrong-issuer', 'issuer', 401],
    ['expired', 'expired', 401],
  ])('rejects %s credentials before parsing or sending', async (_name, kind, status) => {
    const assertion =
      kind === 'audience'
        ? await token({ audience: 'unrelated-application' })
        : kind === 'owner'
          ? await token({ subject: 'another-owner' })
          : kind === 'issuer'
            ? await token({ issuer: 'https://other.cloudflareaccess.com' })
            : kind === 'expired'
              ? await token({ expiry: Math.floor(Date.now() / 1000) - 60 })
              : kind
    const response = await app.request(
      `${origin}/dots`,
      { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': assertion }, body: 'not-json' },
      bindings,
    )
    expect(response.status).toBe(status)
    expect(requests).toHaveLength(0)
  })

  it('fails closed when the shared Access configuration is missing', async () => {
    for (const override of [{ ACCESS_TEAM_DOMAIN: '' }, { ACCESS_AUD: '' }]) {
      const response = await app.request(`${origin}/dots`, {}, { ...bindings, ...override })
      expect(response.status).toBe(503)
    }
  })

  it('rejects alternate hostnames and foreign browser origins', async () => {
    const assertion = await token()
    expect(
      (
        await app.request(
          'https://bypass.workers.dev/dots',
          { headers: { 'Cf-Access-Jwt-Assertion': assertion } },
          bindings,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await app.request(
          `${origin}/dots`,
          {
            headers: {
              'Cf-Access-Jwt-Assertion': assertion,
              Origin: 'https://attacker.example.com',
            },
          },
          bindings,
        )
      ).status,
    ).toBe(403)
  })

  it('supports stateless legacy initialization on grok', async () => {
    const response = await app.request(
      `${origin}/grok`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Cf-Access-Jwt-Assertion': await token(),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'legacy', version: '1' },
          },
        }),
      },
      bindings,
    )
    expect(response.status).toBe(200)
    expect(response.headers.has('mcp-session-id')).toBe(false)
    expect(await response.text()).toContain('2025-11-25')
    expect(
      (
        await app.request(
          `${origin}/grok`,
          { headers: { 'Cf-Access-Jwt-Assertion': await token() } },
          bindings,
        )
      ).status,
    ).toBe(405)
  })

  it('bounds bytes even when content-length understates the request', async () => {
    const response = await app.request(
      `${origin}/grok`,
      {
        method: 'POST',
        headers: {
          'Cf-Access-Jwt-Assertion': await token(),
          'Content-Type': 'application/json',
          'Content-Length': '1',
        },
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      },
      bindings,
    )
    expect(response.status).toBe(413)
  })
})

describe('subscription lifecycle', () => {
  it('logs only the hostname when an unapproved callback is rejected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new EventService(
      { ...bindings, DOTS_CALLBACK_HOSTS: '' },
      bindings.ACCESS_OWNER_SUB,
      Date.now() + 60_000,
    )
    await expect(
      service.subscribe(
        subscribeSchema.parse({
          ...subscribeParams,
          delivery: { ...subscribeParams.delivery, url: `${callback}?token=private-token` },
        }),
      ),
    ).rejects.toMatchObject({ code: -32015, data: { reason: 'url_not_allowed' } })
    expect(warn.mock.calls).toEqual([
      [
        'bridge.subscription.rejected',
        { reason: 'url_not_allowed', hostname: 'receiver.example.com' },
      ],
    ])
    expect(requests).toHaveLength(0)
    expect(await bindings.SUBSCRIPTIONS.get(SUBSCRIPTION_KEY)).toBeNull()
  })

  it('never grants a lifetime beyond the authenticating Access JWT', async () => {
    const expiresAt = Date.now() + 60_000
    const result = await new EventService(bindings, bindings.ACCESS_OWNER_SUB, expiresAt).subscribe(
      subscribeSchema.parse({ ...subscribeParams, ttlMs: null }),
    )
    expect(Date.parse(result.refreshBefore)).toBe(expiresAt)
  })

  it('verifies a signed challenge and stores only an encrypted subscription', async () => {
    const result = await subscribe()
    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (!request) throw new Error('Expected challenge')
    expect(await verifySignature(request)).toBe(true)
    expect(request.headers.get('X-MCP-Subscription-Id')).toBe(result.id)
    expect(request.redirect).toBe('manual')
    const stored = await bindings.SUBSCRIPTIONS.get(SUBSCRIPTION_KEY)
    expect(stored).not.toContain(secret)
    expect(stored).not.toContain(callback)
    const record = await new SubscriptionStore(bindings).read()
    expect(record).toMatchObject({ id: result.id, owner: bindings.ACCESS_OWNER_SUB, secret })
    expect((await bindings.SUBSCRIPTIONS.list()).keys.map((entry) => entry.name)).toEqual([
      SUBSCRIPTION_KEY,
    ])
  })

  it('refreshes a stable identity without repeating a recently successful challenge', async () => {
    const first = await subscribe()
    const second = await call('events/subscribe', {
      ...subscribeParams,
      ttlMs: 60_000,
      cursor: 'not-replayable',
    })
    const result = subscribeResultSchema.parse(second.result)
    expect(result.id).toBe(first.id)
    expect(result.cursor).toBeNull()
    expect(Date.parse(result.refreshBefore)).toBeLessThanOrEqual(Date.now() + 60_000)
    expect(requests).toHaveLength(1)
  })

  it('refuses to silently replace a different active destination', async () => {
    await subscribe()
    const result = await call('events/subscribe', {
      ...subscribeParams,
      delivery: { ...subscribeParams.delivery, url: `${callback}-other` },
    })
    expect(result.error?.code).toBe(-32602)
    expect(requests).toHaveLength(1)
  })

  it('does not activate a failed challenge or persist its secret', async () => {
    receiver = async () => Response.json({ challenge: 'wrong' })
    const result = await call('events/subscribe', subscribeParams)
    expect(result.error).toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } })
    expect(await bindings.SUBSCRIPTIONS.get(SUBSCRIPTION_KEY)).toBeNull()
  })

  it('rejects callback redirects without following them', async () => {
    receiver = async () =>
      new Response(null, { status: 302, headers: { Location: 'https://attacker.example.com/' } })
    expect((await call('events/subscribe', subscribeParams)).error?.code).toBe(-32015)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.redirect).toBe('manual')
  })

  it('categorizes callback timeouts', async () => {
    receiver = async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }
    expect((await call('events/subscribe', subscribeParams)).error).toMatchObject({
      code: -32015,
      data: { reason: 'timeout' },
    })
  })

  it.each(['whsec_YQ==', 'plain-secret', `whsec_${toBase64(new Uint8Array(65))}`])(
    'rejects invalid signing secrets before making a request',
    async (invalid) => {
      const result = await call('events/subscribe', {
        ...subscribeParams,
        delivery: { ...subscribeParams.delivery, secret: invalid },
      })
      expect(result.error?.code).toBe(-32602)
      expect(requests).toHaveLength(0)
    },
  )

  it('enforces exact lifetime despite KV minimum retention', async () => {
    await subscribe()
    const store = new SubscriptionStore(bindings)
    const record = await store.read()
    if (!record) throw new Error('Expected subscription')
    await store.write({ ...record, expiresAt: Date.now() - 1 })
    expect(await bindings.SUBSCRIPTIONS.get(SUBSCRIPTION_KEY)).not.toBeNull()
    expect(await new SubscriptionStore(bindings).read()).toBeNull()
    expect(
      (await call('tools/call', { name: 'send_message', arguments: message }, 'grok')).result,
    ).toMatchObject({ structuredContent: { status: 'failed', reason: 'no_active_subscription' } })
  })

  it('rotates signing keys with dual signatures and retains them on refresh', async () => {
    await subscribe()
    const rotated = {
      ...subscribeParams,
      delivery: { ...subscribeParams.delivery, secret: replacement },
    }
    expect((await call('events/subscribe', rotated)).error).toBeUndefined()
    expect((await call('events/subscribe', rotated)).error).toBeUndefined()
    await call('tools/call', { name: 'send_message', arguments: message }, 'grok')
    const request = requests.at(-1)
    if (!request) throw new Error('Expected event')
    expect(await verifySignature(request, secret)).toBe(true)
    expect(await verifySignature(request, replacement)).toBe(true)
    const store = new SubscriptionStore(bindings)
    const record = await store.read()
    if (!record) throw new Error('Expected subscription')
    await store.write({ ...record, rotateUntil: Date.now() - 1 })
    await call('tools/call', { name: 'send_message', arguments: message }, 'grok')
    const after = requests.at(-1)
    if (!after) throw new Error('Expected event')
    expect(await verifySignature(after, secret)).toBe(false)
    expect(await verifySignature(after, replacement)).toBe(true)
  })

  it('authorizes unsubscribe by owner and identity, and makes it repeatable', async () => {
    await subscribe()
    const params = {
      name: 'message.created' as const,
      arguments: {},
      delivery: { mode: 'webhook' as const, url: callback },
    }
    await new EventService(bindings, 'another-owner', Date.now() + 60_000).unsubscribe(params)
    expect(await new SubscriptionStore(bindings).read()).not.toBeNull()
    for (let count = 0; count < 2; count++) {
      expect((await call('events/unsubscribe', params)).error).toBeUndefined()
    }
    expect(await new SubscriptionStore(bindings).read()).toBeNull()
  })

  it('does not leak KV errors through JSON-RPC', async () => {
    vi.spyOn(bindings.SUBSCRIPTIONS, 'put').mockRejectedValueOnce(new Error(`sensitive ${secret}`))
    const result = await call('events/subscribe', subscribeParams)
    expect(result.error).toMatchObject({
      code: -32603,
      message: expect.stringContaining('Subscription storage unavailable'),
    })
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})

describe('direct delivery', () => {
  it('sends dots messages to the configured Grok routine with its Bearer key', async () => {
    const result = await call('tools/call', { name: 'send_message', arguments: message })
    expect(result.error).toBeUndefined()
    expect(result.result).toMatchObject({
      structuredContent: { status: 'accepted', http_status: 200 },
    })
    expect(requests).toHaveLength(1)
    const request = requests[0]
    if (!request) throw new Error('Expected delivery')
    expect(request.url).toBe(bindings.GROK_WEBHOOK_URL)
    expect(request.headers.get('Authorization')).toBe('Bearer test-key')
    expect(request.redirect).toBe('manual')
    expect(await request.json()).toMatchObject({ ...message, sender: 'dots', recipient: 'grok' })
    expect((await bindings.SUBSCRIPTIONS.list()).keys).toHaveLength(0)
  })

  it('delivers signed Grok events across fresh request/server instances with stable event IDs', async () => {
    const subscription = await subscribe()
    for (let count = 0; count < 2; count++) {
      const result = await call(
        'tools/call',
        {
          name: 'send_message',
          arguments: { ...message, conversation_id: 'c', reply_to: 'p', final: true },
        },
        'grok',
      )
      expect(result.result).toMatchObject({ structuredContent: { status: 'accepted' } })
    }
    const first = requests[1]
    const second = requests[2]
    if (!first || !second) throw new Error('Expected both events')
    expect(first.headers.get('webhook-id')).toBe(second.headers.get('webhook-id'))
    expect(first.headers.get('X-MCP-Subscription-Id')).toBe(subscription.id)
    expect(first.headers.has('Authorization')).toBe(false)
    expect(await verifySignature(first)).toBe(true)
    expect(await first.json()).toMatchObject({
      eventId: first.headers.get('webhook-id'),
      name: 'message.created',
      cursor: null,
      data: {
        ...message,
        sender: 'grok',
        recipient: 'dots',
        conversation_id: 'c',
        reply_to: 'p',
        final: true,
      },
    })
  })

  it('rejects attempted sender/recipient overrides', async () => {
    const result = await call('tools/call', {
      name: 'send_message',
      arguments: { ...message, sender: 'grok', recipient: 'dots' },
    })
    expect(result.result?.isError ?? Boolean(result.error)).toBe(true)
    expect(requests).toHaveLength(0)
  })

  it.each([
    [401, 'failed'],
    [410, 'failed'],
    [413, 'failed'],
    [429, 'failed'],
    [302, 'failed'],
    [500, 'unknown'],
    [408, 'unknown'],
    [202, 'unknown'],
  ])('classifies Grok HTTP %s as %s without retries', async (status, outcome) => {
    receiver = async () => new Response(null, { status: Number(status) })
    expect(
      (await call('tools/call', { name: 'send_message', arguments: message })).result,
    ).toMatchObject({ structuredContent: { status: outcome, http_status: status } })
    expect(requests).toHaveLength(1)
  })

  it('reports a lost response as unknown without retrying', async () => {
    receiver = async () => {
      throw new TypeError('Network error')
    }
    expect(
      (await call('tools/call', { name: 'send_message', arguments: message })).result,
    ).toMatchObject({ structuredContent: { status: 'unknown' } })
    expect(requests).toHaveLength(1)
  })

  it('stops events if the configured owner or trusted hosts change', async () => {
    await subscribe()
    const result = await call('tools/call', { name: 'send_message', arguments: message }, 'grok', {
      ...bindings,
      DOTS_CALLBACK_HOSTS: '',
    })
    expect(result.result).toMatchObject({ structuredContent: { status: 'failed' } })
    expect(requests).toHaveLength(1)
  })

  it.each([
    'http://receiver.example.com/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://user:pass@receiver.example.com/',
    'https://receiver.example.com:8443/',
    'https://receiver.example.com/#fragment',
    'https://receiver.example.com.attacker.com/',
    'https://receiver.local/',
  ])('blocks unsafe callback %s', (url) => {
    expect(() =>
      trustedHttpsUrl(url, ['receiver.example.com', '127.0.0.1', '[::1]', 'receiver.local']),
    ).toThrow()
  })

  it('rejects unsupported subscription arguments instead of ignoring filters', () => {
    expect(
      subscribeSchema.safeParse({ ...subscribeParams, arguments: { conversation_id: 'ignored' } })
        .success,
    ).toBe(false)
  })
})
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
