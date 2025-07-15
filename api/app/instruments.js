const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");
// Ensure to call this before requiring any other modules!
Sentry.init({
  dsn: "DSN",
  integrations: [
    // Add our Profiling integration
    nodeProfilingIntegration(),
  ],
  // Add Tracing by setting tracesSampleRate
  // We recommend adjusting this value in production
  tracesSampleRate: 1.0,
  // Set sampling rate for profiling
  // This is relative to tracesSampleRate
  profilesSampleRate: 1.0,

  // Enable logs to be sent to Sentry
  _experiments: { enableLogs: true },
  beforeSend(event) {
    // Check if this is a LiteLLM error
    if (event.exception && event.exception.values) {
      for (const exception of event.exception.values) {
        if (exception.value && exception.value.includes('litellm.ServiceUnavailableError')) {
          // Sanitize the error message
          const errorParts = exception.value.split('Messages:');
          if (errorParts.length > 1) {
            exception.value = errorParts[0] + 'Messages: [REDACTED]' + 
              errorParts[1].substring(errorParts[1].indexOf('model_group'));
          }
        }
      }
    }
    return event;
  }
});
