import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
  accountId: '9edb79449ad0a1d1ca7b838a0a8de179',
  worker: {
    name: 'agentic-bot-bridge',
    compatibilityDate: '2026-10-22',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    entrypoint: 'src/index.ts',
    workersDev: false,
    domains: ['agentic-bot-bridge.hayatosc.dev'],
    previewUrls: false,
    observability: {
      enabled: false,
    },
    env: {
      PUBLIC_ORIGIN: bindings.text('https://agentic-bot-bridge.hayatosc.dev'),
      ACCESS_TEAM_DOMAIN: bindings.text('https://hayatosc.cloudflareaccess.com'),
      ACCESS_AUD: bindings.text('38a1f38dca3555128329996d92e531a882e65329c86dff2b7d76b314a4c2441b'),
      ACCESS_OWNER_SUB: bindings.text('141ee5e4-4af6-5a09-8567-de9895d62359'),
      DOTS_CALLBACK_HOSTS: bindings.text(''),
      GROK_WEBHOOK_URL: bindings.secret(),
      GROK_WEBHOOK_KEY: bindings.secret(),
      SUBSCRIPTION_ENCRYPTION_KEY: bindings.secret(),
      SUBSCRIPTIONS: bindings.kv({
        id: '042734cd4163491d8510f22be9b6f780',
      }),
    },
  },
})
