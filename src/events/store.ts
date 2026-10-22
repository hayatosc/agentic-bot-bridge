import { z } from 'zod'

import type { Bindings } from '../env'
import { encryptionKey, fromBase64, toBase64 } from '../lib/crypto'
import type { Subscription } from './schema'
import { subscriptionSchema } from './schema'

export const SUBSCRIPTION_KEY = 'dots-subscription:v1'
const envelopeSchema = z.object({ version: z.literal(1), iv: z.string(), ciphertext: z.string() })
const encoder = new TextEncoder()
const additionalData = encoder.encode(SUBSCRIPTION_KEY)

export class SubscriptionStore {
  constructor(private readonly env: Bindings) {}

  async read(): Promise<Subscription | null> {
    const raw: unknown = await this.env.SUBSCRIPTIONS.get(SUBSCRIPTION_KEY, 'json')
    if (raw === null) return null
    const envelope = envelopeSchema.parse(raw)
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.iv), additionalData },
      await encryptionKey(this.env.SUBSCRIPTION_ENCRYPTION_KEY),
      fromBase64(envelope.ciphertext),
    )
    const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    const record = subscriptionSchema.parse(decoded)
    return record.expiresAt > Date.now() ? record : null
  }

  async write(record: Subscription): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData },
      await encryptionKey(this.env.SUBSCRIPTION_ENCRYPTION_KEY),
      encoder.encode(JSON.stringify(record)),
    )
    await this.env.SUBSCRIPTIONS.put(
      SUBSCRIPTION_KEY,
      JSON.stringify({ version: 1, iv: toBase64(iv), ciphertext: toBase64(ciphertext) }),
      // KV requires at least 60 seconds; read() enforces the exact granted lifetime.
      { expirationTtl: Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000)) },
    )
  }

  async delete(): Promise<void> {
    await this.env.SUBSCRIPTIONS.delete(SUBSCRIPTION_KEY)
  }
}
