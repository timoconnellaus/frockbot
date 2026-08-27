const loaderFixture = (_ctx, config) => {
  const state = globalThis.__frockbotLoaderFixture;
  state.setups.push(config.label);
  return () => {
    state.cleanups.push(config.label);
  };
};

export default loaderFixture;
