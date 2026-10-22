import { bindings, defineConfig } from 'cf/config'

export default defineConfig({
  worker: {
    name: 'agentic-bot-bridge',
    compatibilityDate: '2026-10-22',
    compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    entrypoint: 'src/index.ts',
    workersDev: false,
    previewUrls: false,
    observability: {
      enabled: false,
    },
    env: {
      PUBLIC_ORIGIN: bindings.text('https://bridge.example.com'),
      ACCESS_TEAM_DOMAIN: bindings.text('https://YOUR-TEAM.cloudflareaccess.com'),
      ACCESS_DOTS_AUD: bindings.text(''),
      ACCESS_GROK_AUD: bindings.text(''),
      ACCESS_OWNER_SUB: bindings.text(''),
      DOTS_CALLBACK_HOSTS: bindings.text(''),
      SUBSCRIPTIONS: bindings.kv({
        id: 'REPLACE_WITH_KV_NAMESPACE_ID',
      }),
    },
  },
})
