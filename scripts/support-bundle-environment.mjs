const CONFIGURED_ENVIRONMENT_KEY = /^(CLANKIE_|OTEL_|SENTRY_|POSTHOG_|DISCORD_|OPENAI_|ANTHROPIC_)/u;

/** Returns names only. Environment values are never admitted to support-bundle data. */
export function configuredEnvironmentKeys(env) {
  return Object.keys(env)
    .filter((key) => CONFIGURED_ENVIRONMENT_KEY.test(key))
    .sort();
}
