import { createMcpHandler } from '@modelcontextprotocol/server'
import { Hono } from 'hono'

import type { Agent, Env } from '../env'
import { accessAuth } from '../lib/access'
import { MAX_BODY_BYTES } from '../lib/http'
import { createBridgeServer } from './server'

export function mcpRoutes(agent: Agent) {
  return new Hono<Env>().use('*', accessAuth(agent)).all('/', (c) => {
    const handler = createMcpHandler(
      () => createBridgeServer(c.env, agent, c.get('owner'), c.get('authorizationExpiresAt')),
      { legacy: agent === 'dots' ? 'reject' : 'stateless', maxRequestBodySize: MAX_BODY_BYTES },
    )
    return handler.fetch(c.req.raw)
  })
}
