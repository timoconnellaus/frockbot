export function createImmutablePlanRequestFactory<TPlan, TRequest, TResult>(
  compilePlan: () => Promise<TPlan>,
  createForRequest: (
    plan: TPlan,
    request: TRequest,
  ) => TResult | Promise<TResult>,
): (request: TRequest) => Promise<TResult> {
  let planPromise: Promise<TPlan> | undefined;

  const loadPlan = (): Promise<TPlan> => {
    if (planPromise) return planPromise;
    const pending = Promise.resolve().then(compilePlan);
    planPromise = pending;
    void pending.catch(() => {
      if (planPromise === pending) planPromise = undefined;
    });
    return pending;
  };

  return async (request) => createForRequest(await loadPlan(), request);
}
