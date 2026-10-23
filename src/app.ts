import { Hono } from 'hono'

import type { Env } from './env'
import { accessAuth } from './lib/access'
import { mcpRoutes } from './mcp/routes'

const app = new Hono<Env>()
  .use('*', async (c, next) => {
    await next()
    if (c.req.path === '/dots' || c.req.path === '/grok') {
      console.info('bridge.request.completed', { route: c.req.path, status: c.res.status })
    }
  })
  .use('*', accessAuth())
  .get('/', (c) => c.json({ name: 'agentic-bot-bridge', version: '0.1.0' }))
  .route('/dots', mcpRoutes('dots'))
  .route('/grok', mcpRoutes('grok'))
  .onError((_error, c) => c.json({ error: 'Internal server error' }, 500))

export type AppType = typeof app
export default app
