# Abandon unretrievable model effects explicitly

Ollama Cloud does not expose provider-bound response retrieval, so automatic recovery preserves an uncertain model effect without retrying it. An authenticated user reconciliation attempt may explicitly terminalize the still-uncertain Turn as failed, releasing the Bot while retaining the normalized request and failure history.
