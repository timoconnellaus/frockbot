# Bound Ollama command validity

Ollama Connection command IDs provide replay receipts for 30 days, with admission limited to 256 combined completed and pending manual commands during that window. This bounds User Durable Object storage while preserving exact idempotency for a declared recovery period; after expiry, a reused command ID is a new command.
