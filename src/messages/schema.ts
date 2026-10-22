import { z } from 'zod'

const identifier = z.string().min(1).max(200)

export const messageSchema = z.strictObject({
  message_id: identifier.describe('A unique, stable ID for this message. Preserve it on retry.'),
  text: z.string().min(1).max(60_000),
  conversation_id: identifier.optional(),
  reply_to: identifier.optional(),
  final: z.boolean().default(false),
})

export type Message = z.infer<typeof messageSchema>

export const deliveredMessageSchema = messageSchema.extend({
  sender: z.enum(['dots', 'grok']),
  recipient: z.enum(['dots', 'grok']),
})

export const deliveryResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), message_id: identifier, http_status: z.number() }),
  z.object({
    status: z.literal('failed'),
    message_id: identifier,
    reason: z.string(),
    http_status: z.number().optional(),
  }),
  z.object({
    status: z.literal('unknown'),
    message_id: identifier,
    reason: z.string(),
    http_status: z.number().optional(),
  }),
])

export type DeliveryResult = z.infer<typeof deliveryResultSchema>
