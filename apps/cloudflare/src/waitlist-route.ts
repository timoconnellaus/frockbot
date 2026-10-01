import { accessEmailV1 } from "@frockbot/app/admin/shared";
import {
  decodeJoinWaitlistResultV1,
  normalizeFirstJobV1,
} from "@frockbot/app/admin/waitlist";

/** The marketing site's beta form posts here, signed in or not. */
export const WAITLIST_PATH_V1 = "/api/waitlist";
/** Left empty by people; a script filling every field fills this one too. */
export const WAITLIST_HONEYPOT_FIELD_V1 = "website";

const NO_STORE = { "cache-control": "no-store" } as const;

function seeOther(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, location },
  });
}

/**
 * A plain form post from the marketing site, answered with a redirect back to
 * it, so joining needs no script and no cross-origin read. Every accepted
 * submission lands on the same thanks page — joined, already on the list, or
 * a full list — so the page says nothing about whose address is there.
 */
export async function routeWaitlistV1(
  request: Request,
  options: {
    /** The marketing site the person came from, e.g. `https://frockbot.com`. */
    homepage: string;
    join(input: unknown): Promise<unknown>;
  },
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, {
      status: 405,
      headers: { ...NO_STORE, allow: "POST" },
    });
  }
  const homepage = options.homepage.replace(/\/+$/, "");
  const thanks = `${homepage}/beta/thanks/`;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return seeOther(`${homepage}/beta/#join`);
  }
  const trap = form.get(WAITLIST_HONEYPOT_FIELD_V1);
  if (typeof trap === "string" && trap.trim().length > 0) {
    return seeOther(thanks);
  }
  const email = accessEmailV1(form.get("email"));
  if (email === undefined) return seeOther(`${homepage}/beta/#join`);
  const firstJob = normalizeFirstJobV1(form.get("firstJob"));
  try {
    const result = decodeJoinWaitlistResultV1(
      await options.join({
        schemaVersion: 1,
        email,
        ...(firstJob === undefined ? {} : { firstJob }),
      }),
    );
    // The outcome and nothing about who: no address reaches the log.
    console.log(
      JSON.stringify({ event: "waitlist-join", status: result.status }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "waitlist-join-failed",
        error: error instanceof Error ? error.name : "unknown",
      }),
    );
    return new Response(
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Try again</title></head>
<body>
<main>
<h1>We couldn't save your place just now.</h1>
<p>Nothing was saved. Go back and send the form again in a moment.</p>
<a href="${homepage}/beta/#join">Back to the form</a>
</main>
</body>
</html>`,
      {
        status: 503,
        headers: {
          ...NO_STORE,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "retry-after": "5",
        },
      },
    );
  }
  return seeOther(thanks);
}
