import { ProtocolError } from '@modelcontextprotocol/server'
import type { z } from 'zod'

import type { Bindings } from '../env'
import { digest } from '../lib/crypto'
import { callbackHosts, trustedHttpsUrl } from '../lib/http'
import type { Subscription, subscribeSchema, unsubscribeSchema } from './schema'
import { EVENT_NAME } from './schema'
import { SubscriptionStore } from './store'
import { verifyCallback } from './webhook'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const VERIFICATION_CACHE_MS = 5 * 60 * 1000
const ROTATION_WINDOW_MS = 5 * 60 * 1000

function subscriptionId(owner: string, url: string): Promise<string> {
  // This event has no filters. Its only valid arguments are canonical {}.
  return digest(JSON.stringify([owner, url, EVENT_NAME, {}])).then((id) => `sub_${id}`)
}

export class EventService {
  private readonly store: SubscriptionStore
  constructor(
    private readonly env: Bindings,
    private readonly owner: string,
    private readonly authorizationExpiresAt: number,
  ) {
    this.store = new SubscriptionStore(env)
  }

  async subscribe(params: z.infer<typeof subscribeSchema>) {
    let url: string
    try {
      url = trustedHttpsUrl(params.delivery.url, callbackHosts(this.env.DOTS_CALLBACK_HOSTS)).href
    } catch {
      const hostname = new URL(params.delivery.url).hostname
      // Callback paths and signing secrets are credentials; log only the rejected host.
      console.warn('bridge.subscription.rejected', { reason: 'url_not_allowed', hostname })
      throw new ProtocolError(-32015, 'Callback endpoint rejected', {
        reason: 'url_not_allowed',
        hostname,
      })
    }
    const id = await subscriptionId(this.owner, url)
    const existing = await this.store.read()
    if (existing && existing.id !== id) {
      throw new ProtocolError(-32602, 'Unsubscribe the active subscription before replacing it')
    }
    const now = Date.now()
    const record: Subscription = {
      id,
      owner: this.owner,
      name: EVENT_NAME,
      arguments: {},
      url,
      secret: params.delivery.secret,
      expiresAt: Math.min(
        now + Math.min(params.ttlMs ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS),
        this.authorizationExpiresAt,
      ),
      verifiedAt: existing?.verifiedAt ?? 0,
    }
    if (existing && existing.secret !== record.secret) {
      if ((existing.rotateUntil ?? 0) > now) {
        throw new ProtocolError(-32602, 'Wait for the current signing-key rotation to finish')
      }
      record.previousSecret = existing.secret
      record.rotateUntil = now + ROTATION_WINDOW_MS
    } else if (existing?.previousSecret && (existing.rotateUntil ?? 0) > now) {
      record.previousSecret = existing.previousSecret
      record.rotateUntil = existing.rotateUntil
    }
    if (
      !existing ||
      existing.secret !== record.secret ||
      now - record.verifiedAt >= VERIFICATION_CACHE_MS
    ) {
      try {
        if (!(await verifyCallback(this.env, record))) {
          throw new ProtocolError(-32015, 'Callback verification failed', {
            reason: 'challenge_failed',
          })
        }
      } catch (error) {
        if (error instanceof ProtocolError) throw error
        const reason =
          error instanceof Error && /Timeout|Abort/.test(error.name)
            ? 'timeout'
            : 'challenge_failed'
        throw new ProtocolError(-32015, 'Callback verification failed', { reason })
      }
      record.verifiedAt = Date.now()
    }
    // Verification can consume the requested lifetime; never activate an already expired record.
    if (record.expiresAt <= Date.now()) {
      throw new ProtocolError(-32602, 'Requested lifetime elapsed during verification')
    }
    await this.store.write(record)
    return {
      id,
      refreshBefore: new Date(record.expiresAt).toISOString(),
      cursor: null,
      truncated: false,
    }
  }

  async unsubscribe(params: z.infer<typeof unsubscribeSchema>) {
    const id = await subscriptionId(this.owner, new URL(params.delivery.url).href)
    const existing = await this.store.read()
    if (existing?.id === id && existing.owner === this.owner) await this.store.delete()
    return {}
  }
}
