import { createMiddleware } from 'hono/factory'
import { createRemoteJWKSet, jwtVerify } from 'jose'

import type { Env } from '../env'
import { getAccessConfig } from './config'

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

function getKeys(domain: string) {
  const existing = keySets.get(domain)
  if (existing) return existing
  const keys = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`))
  keySets.set(domain, keys)
  return keys
}

export function accessAuth() {
  return createMiddleware<Env>(async (c, next) => {
    const config = getAccessConfig(c.env)
    if (!config.success) return c.json({ error: 'Access configuration is incomplete' }, 503)
    const { ACCESS_TEAM_DOMAIN, ACCESS_OWNER_SUB, PUBLIC_ORIGIN } = config.data
    const origin = c.req.header('Origin')
    if (new URL(c.req.url).origin !== PUBLIC_ORIGIN || (origin && origin !== PUBLIC_ORIGIN)) {
      return c.json({ error: 'Forbidden origin' }, 403)
    }
    const token = c.req.header('Cf-Access-Jwt-Assertion')
    if (!token) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const { payload } = await jwtVerify(token, getKeys(ACCESS_TEAM_DOMAIN), {
        issuer: ACCESS_TEAM_DOMAIN,
        audience: config.data.ACCESS_AUD,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat'],
      })
      if (payload.sub !== ACCESS_OWNER_SUB) return c.json({ error: 'Forbidden' }, 403)
      if (typeof payload.exp !== 'number') return c.json({ error: 'Unauthorized' }, 401)
      c.set('owner', payload.sub)
      c.set('authorizationExpiresAt', payload.exp * 1000)
    } catch {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })
}
