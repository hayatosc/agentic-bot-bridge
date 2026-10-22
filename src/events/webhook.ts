import { z } from 'zod'

import type { Bindings } from '../env'
import { equalChallenge, signWebhook } from '../lib/crypto'
import {
  callbackHosts,
  HTTP_TIMEOUT_MS,
  jsonBody,
  readSmallJson,
  trustedHttpsUrl,
} from '../lib/http'
import type { Subscription } from './schema'

export async function postEvent(
  env: Bindings,
  subscription: Subscription,
  id: string,
  value: unknown,
): Promise<Response> {
  const url = trustedHttpsUrl(subscription.url, callbackHosts(env.DOTS_CALLBACK_HOSTS))
  const body = jsonBody(value)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signatures = [await signWebhook(subscription.secret, id, timestamp, body)]
  if (subscription.previousSecret && (subscription.rotateUntil ?? 0) > Date.now()) {
    signatures.push(await signWebhook(subscription.previousSecret, id, timestamp, body))
  }
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signatures.join(' '),
      'X-MCP-Subscription-Id': subscription.id,
    },
    body,
  })
}

export async function verifyCallback(env: Bindings, subscription: Subscription): Promise<boolean> {
  const challenge = crypto.randomUUID()
  const response = await postEvent(env, subscription, `verify_${crypto.randomUUID()}`, {
    type: 'verification',
    challenge,
  })
  if (!response.ok) {
    await response.body?.cancel()
    return false
  }
  const result = z
    .object({ challenge: z.string().max(128) })
    .safeParse(await readSmallJson(response))
  return result.success && equalChallenge(result.data.challenge, challenge)
}
