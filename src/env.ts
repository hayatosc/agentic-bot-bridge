export type Agent = 'dots' | 'grok'

export interface Bindings {
  SUBSCRIPTIONS: KVNamespace
  ACCESS_TEAM_DOMAIN: string
  ACCESS_DOTS_AUD: string
  ACCESS_GROK_AUD: string
  ACCESS_OWNER_SUB: string
  PUBLIC_ORIGIN: string
  DOTS_CALLBACK_HOSTS: string
  GROK_WEBHOOK_URL: string
  GROK_WEBHOOK_KEY: string
  SUBSCRIPTION_ENCRYPTION_KEY: string
}

export interface Env {
  Bindings: Bindings
  Variables: { owner: string; authorizationExpiresAt: number }
}
