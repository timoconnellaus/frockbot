export interface StripeClientV1 {
  createCustomer(input: {
    userId: string;
    idempotencyKey: string;
  }): Promise<string>;
  resolvePrice(lookupKey: string): Promise<string>;
  createCheckout(input: {
    userId: string;
    customerId: string;
    idempotencyKey: string;
    mode: "payment" | "subscription";
    successUrl: string;
    cancelUrl: string;
    priceId?: string;
    customAmountCents?: number;
  }): Promise<string>;
  createPortal(input: {
    customerId: string;
    idempotencyKey: string;
    returnUrl: string;
  }): Promise<string>;
}

interface StripeClientOptionsV1 {
  secretKey: string;
  fetch?: typeof fetch;
}

function boundedStripeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`Stripe returned an invalid ${label}.`);
  }
  return value;
}

export function createStripeClientV1(
  options: StripeClientOptionsV1,
): StripeClientV1 {
  const fetchStripe = options.fetch ?? fetch;

  async function request(
    path: string,
    init: {
      method?: "GET" | "POST";
      body?: URLSearchParams;
      idempotencyKey?: string;
    },
  ): Promise<Record<string, unknown>> {
    const response = await fetchStripe(`https://api.stripe.com${path}`, {
      method: init.method ?? "POST",
      headers: {
        authorization: `Bearer ${options.secretKey}`,
        ...(init.body
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...(init.idempotencyKey
          ? { "idempotency-key": init.idempotencyKey }
          : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const stripeError = value.error;
      const message =
        stripeError && typeof stripeError === "object"
          ? (stripeError as Record<string, unknown>).message
          : undefined;
      throw new Error(
        typeof message === "string" ? message : "Stripe request failed.",
      );
    }
    return value;
  }

  return {
    async createCustomer(input) {
      const body = new URLSearchParams({
        "metadata[frockbot_user_id]": input.userId,
      });
      const value = await request("/v1/customers", {
        body,
        idempotencyKey: input.idempotencyKey,
      });
      return boundedStripeId(value.id, "Customer id");
    },
    async resolvePrice(lookupKey) {
      const query = new URLSearchParams({
        "lookup_keys[]": lookupKey,
        active: "true",
        limit: "2",
      });
      const value = await request(`/v1/prices?${query.toString()}`, {
        method: "GET",
      });
      const rows = value.data;
      if (!Array.isArray(rows) || rows.length !== 1) {
        throw new Error(`Stripe price ${lookupKey} is not configured.`);
      }
      const row = rows[0];
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Stripe price ${lookupKey} is invalid.`);
      }
      return boundedStripeId((row as Record<string, unknown>).id, "Price id");
    },
    async createCheckout(input) {
      const body = new URLSearchParams({
        mode: input.mode,
        customer: input.customerId,
        client_reference_id: input.userId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        "line_items[0][quantity]": "1",
        "metadata[frockbot_user_id]": input.userId,
        "metadata[frockbot_kind]":
          input.mode === "subscription" ? "subscription" : "credit",
      });
      if (input.mode === "subscription") {
        body.set("subscription_data[metadata][frockbot_user_id]", input.userId);
      } else {
        body.set(
          "payment_intent_data[metadata][frockbot_user_id]",
          input.userId,
        );
        body.set("payment_intent_data[metadata][frockbot_kind]", "credit");
      }
      if (input.priceId) {
        body.set("line_items[0][price]", input.priceId);
      } else if (input.customAmountCents !== undefined) {
        body.set("line_items[0][price_data][currency]", "usd");
        body.set(
          "line_items[0][price_data][unit_amount]",
          String(input.customAmountCents),
        );
        body.set(
          "line_items[0][price_data][product_data][name]",
          "FrockBot credits",
        );
      } else {
        throw new Error("Stripe Checkout has no price.");
      }
      const value = await request("/v1/checkout/sessions", {
        body,
        idempotencyKey: input.idempotencyKey,
      });
      return boundedStripeId(value.url, "Checkout URL");
    },
    async createPortal(input) {
      const body = new URLSearchParams({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      const value = await request("/v1/billing_portal/sessions", {
        body,
        idempotencyKey: input.idempotencyKey,
      });
      return boundedStripeId(value.url, "Billing Portal URL");
    },
  };
}
