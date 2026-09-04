const PRICE_SPECS = [
  {
    lookupKey: "frockbot_basic_monthly",
    label: "Basic monthly subscription",
    unitAmount: 2_000,
    recurring: true,
  },
  ...[25, 50, 100, 500].map((dollars) => ({
    lookupKey: `frockbot_credit_${String(dollars)}`,
    label: `$${String(dollars)} credit pack`,
    unitAmount: dollars * 100,
    recurring: false,
  })),
  {
    lookupKey: "frockbot_credit_custom",
    label: "Custom credit purchase",
    custom: true,
    recurring: false,
  },
] as const;

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) throw new Error("STRIPE_SECRET_KEY is required");

const confirm = process.argv.includes("--confirm");
const unexpected = process.argv
  .slice(2)
  .filter((argument) => argument !== "--confirm");
if (unexpected.length > 0) {
  throw new Error(`Unknown argument: ${unexpected.join(", ")}`);
}

async function stripe(
  path: string,
  body?: URLSearchParams,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body } : {}),
  });
  const value = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const error = value.error;
    const message =
      error && typeof error === "object"
        ? (error as Record<string, unknown>).message
        : undefined;
    throw new Error(
      typeof message === "string" ? message : `Stripe ${response.status}`,
    );
  }
  return value;
}

async function priceForLookupKey(
  lookupKey: string,
): Promise<Record<string, unknown> | undefined> {
  const query = new URLSearchParams({
    "lookup_keys[]": lookupKey,
    active: "true",
    limit: "2",
  });
  const value = await stripe(`/v1/prices?${query.toString()}`);
  const data = value.data;
  if (!Array.isArray(data)) throw new Error("Stripe returned invalid prices");
  if (data.length > 1)
    throw new Error(`More than one active ${lookupKey} price`);
  const price = data[0];
  return price && typeof price === "object"
    ? (price as Record<string, unknown>)
    : undefined;
}

async function findProduct(): Promise<string | undefined> {
  const value = await stripe("/v1/products?active=true&limit=100");
  const data = value.data;
  if (!Array.isArray(data)) throw new Error("Stripe returned invalid products");
  for (const candidate of data) {
    if (!candidate || typeof candidate !== "object") continue;
    const product = candidate as Record<string, unknown>;
    const metadata = product.metadata;
    if (
      metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).frockbot_billing_catalog === "v1" &&
      typeof product.id === "string"
    ) {
      return product.id;
    }
  }
  return undefined;
}

const existing = new Map<string, Record<string, unknown>>();
for (const spec of PRICE_SPECS) {
  const price = await priceForLookupKey(spec.lookupKey);
  if (price) existing.set(spec.lookupKey, price);
}

let productId = [...existing.values()].find(
  (price) => typeof price.product === "string",
)?.product as string | undefined;
productId ??= await findProduct();

if (!confirm) {
  console.log(
    "Dry run. Re-run with --confirm to create missing Stripe objects.",
  );
  console.log(
    productId
      ? `Product: ${productId}`
      : 'Product: would create "FrockBot Billing"',
  );
  for (const spec of PRICE_SPECS) {
    const found = existing.get(spec.lookupKey);
    console.log(
      found
        ? `${spec.lookupKey}: ${String(found.id)} (exists)`
        : `${spec.lookupKey}: would create`,
    );
  }
  process.exit(0);
}

if (!productId) {
  const product = await stripe(
    "/v1/products",
    new URLSearchParams({
      name: "FrockBot Billing",
      description: "Basic subscription and prepaid usage credits",
      "metadata[frockbot_billing_catalog]": "v1",
    }),
  );
  if (typeof product.id !== "string") {
    throw new Error("Stripe returned an invalid Product id");
  }
  productId = product.id;
  console.log(`Product: ${productId} (created)`);
} else {
  console.log(`Product: ${productId} (exists)`);
}

for (const spec of PRICE_SPECS) {
  const found = existing.get(spec.lookupKey);
  if (found) {
    console.log(`${spec.lookupKey}: ${String(found.id)} (exists)`);
    continue;
  }
  const body = new URLSearchParams({
    currency: "usd",
    product: productId,
    lookup_key: spec.lookupKey,
    nickname: spec.label,
  });
  if ("custom" in spec && spec.custom) {
    body.set("custom_unit_amount[enabled]", "true");
    body.set("custom_unit_amount[minimum]", "500");
    body.set("custom_unit_amount[maximum]", "100000");
    body.set("custom_unit_amount[preset]", "5000");
  } else if ("unitAmount" in spec) {
    body.set("unit_amount", String(spec.unitAmount));
  }
  if (spec.recurring) body.set("recurring[interval]", "month");
  const created = await stripe("/v1/prices", body);
  console.log(`${spec.lookupKey}: ${String(created.id)} (created)`);
}
