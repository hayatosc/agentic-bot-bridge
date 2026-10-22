import { z } from 'zod'

import type { Bindings } from '../env'

const httpsOrigin = z.url().refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
})

const accessConfigSchema = z.object({
  ACCESS_TEAM_DOMAIN: httpsOrigin.refine((value) =>
    /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(value),
  ),
  ACCESS_AUD: z.string().min(1),
  ACCESS_OWNER_SUB: z.string().min(1),
  PUBLIC_ORIGIN: httpsOrigin,
})

export function getAccessConfig(env: Bindings) {
  return accessConfigSchema.safeParse(env)
}
