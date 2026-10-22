import { z } from 'zod'

import { decodeSigningSecret } from '../lib/crypto'
import { deliveredMessageSchema } from '../messages/schema'

export const EVENT_NAME = 'message.created'
export const eventArgumentsSchema = z.strictObject({})
export const signingSecretSchema = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      decodeSigningSecret(value)
      return true
    } catch {
      return false
    }
  }, 'Expected whsec_ followed by a base64-encoded 24–64 byte key')

const identityShape = {
  name: z.literal(EVENT_NAME),
  arguments: eventArgumentsSchema.default({}),
}

export const subscribeSchema = z.object({
  ...identityShape,
  delivery: z.strictObject({
    mode: z.literal('webhook'),
    url: z.url().max(4096),
    secret: signingSecretSchema,
  }),
  cursor: z.string().max(512).nullable().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
})

export const unsubscribeSchema = z.object({
  ...identityShape,
  delivery: z.object({ mode: z.literal('webhook'), url: z.url().max(4096) }),
})

export const subscriptionSchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.literal(EVENT_NAME),
  arguments: eventArgumentsSchema,
  url: z.url(),
  secret: signingSecretSchema,
  expiresAt: z.number(),
  verifiedAt: z.number(),
  previousSecret: signingSecretSchema.optional(),
  rotateUntil: z.number().optional(),
})
export type Subscription = z.infer<typeof subscriptionSchema>

export const subscribeResultSchema = z.object({
  id: z.string(),
  refreshBefore: z.string(),
  cursor: z.null(),
  truncated: z.boolean(),
})

export const eventDefinition = {
  name: EVENT_NAME,
  description: 'A message from the paired Grok Bot to this dot. No history or replay is available.',
  delivery: ['webhook'],
  inputSchema: z.toJSONSchema(eventArgumentsSchema),
  payloadSchema: z.toJSONSchema(deliveredMessageSchema),
}
