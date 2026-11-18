(() => {
  // Each document owns its observer; initialization scripts run again on reload.
  const state = { entries: [], dropped: 0 };
  Object.defineProperty(window, '__ocSmokeRendererErrors', { value: state });
  const capture = (kind, error) => {
    if (state.entries.length >= 8) { state.dropped++; return; }
    state.entries.push({
      kind,
      message: String(error?.message ?? error).slice(0, 1024),
      stack: String(error?.stack ?? '').slice(0, 4096)
    });
  };
  window.addEventListener('error', event => capture('error', event.error ?? event.message));
  window.addEventListener('unhandledrejection', event => capture('unhandledrejection', event.reason));
})();
