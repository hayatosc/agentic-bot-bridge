import type { Agent, Bindings } from '../env'
import { EVENT_NAME } from '../events/schema'
import { SubscriptionStore } from '../events/store'
import { postEvent } from '../events/webhook'
import { digest } from '../lib/crypto'
import { callbackHosts, HTTP_TIMEOUT_MS, jsonBody, trustedHttpsUrl } from '../lib/http'
import type { DeliveryResult, Message } from './schema'

function classifyResponse(message: Message, response: Response, grok: boolean): DeliveryResult {
  if (grok ? response.status === 200 : response.ok) {
    return { status: 'accepted', message_id: message.message_id, http_status: response.status }
  }
  // A server error may have happened after the receiver started processing the message.
  if (response.status >= 500 || response.status === 408 || (grok && response.ok)) {
    return {
      status: 'unknown',
      message_id: message.message_id,
      http_status: response.status,
      reason: 'receiver_outcome_unknown',
    }
  }
  return {
    status: 'failed',
    message_id: message.message_id,
    http_status: response.status,
    reason: 'receiver_rejected',
  }
}

export async function deliver(
  env: Bindings,
  sender: Agent,
  message: Message,
): Promise<DeliveryResult> {
  const data = { ...message, sender, recipient: sender === 'dots' ? 'grok' : 'dots' }
  let send: () => Promise<Response>
  try {
    if (sender === 'dots') {
      const url = trustedHttpsUrl(env.GROK_WEBHOOK_URL, [new URL(env.GROK_WEBHOOK_URL).hostname])
      if (!env.GROK_WEBHOOK_KEY) throw new Error('Missing webhook key')
      const body = jsonBody(data)
      send = () =>
        fetch(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.GROK_WEBHOOK_KEY}`,
          },
          body,
        })
    } else {
      const subscription = await new SubscriptionStore(env).read()
      if (!subscription || subscription.owner !== env.ACCESS_OWNER_SUB) {
        return {
          status: 'failed',
          message_id: message.message_id,
          reason: 'no_active_subscription',
        }
      }
      trustedHttpsUrl(subscription.url, callbackHosts(env.DOTS_CALLBACK_HOSTS))
      const eventId = `evt_${await digest(JSON.stringify([sender, message.message_id]))}`
      const event = {
        eventId,
        name: EVENT_NAME,
        timestamp: new Date().toISOString(),
        data,
        cursor: null,
      }
      jsonBody(event)
      send = () => postEvent(env, subscription, eventId, event)
    }
  } catch {
    return {
      status: 'failed',
      message_id: message.message_id,
      reason: 'configuration_or_storage_error',
    }
  }
  try {
    const response = await send()
    const result = classifyResponse(message, response, sender === 'dots')
    // Receipt is already known even if discarding the response body fails.
    await response.body?.cancel().catch(() => undefined)
    return result
  } catch {
    return {
      status: 'unknown',
      message_id: message.message_id,
      reason: 'transport_outcome_unknown',
    }
  }
}
