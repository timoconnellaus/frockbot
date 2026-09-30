import { expect, test } from "bun:test";
import {
  composeFetchDecisionV1,
  fetchCarriesDataV1,
  fetchUrlSeenV1,
  fetchUrlV1,
  type FetchReviewAnswersV1,
} from "./fetch-review.js";

const decide = (discloses: number, instructs = 0.05) =>
  composeFetchDecisionV1({
    answers: {
      disclosesToSite: { noul: discloses },
      instructsReviewer: { noul: instructs },
    } as unknown as FetchReviewAnswersV1,
  });

const carries = (url: string) => fetchCarriesDataV1(new URL(url));

test("an address carries data in its query, its fragment, or a segment too long to be a name", () => {
  expect(carries("https://docs.example.com/guide/setup")).toBe(false);
  expect(carries("https://example.com/")).toBe(false);
  expect(carries("https://example.com/search?q=weather")).toBe(true);
  expect(carries("https://example.com/page#token=abc")).toBe(true);
  expect(carries(`https://collector.example/${"a".repeat(41)}`)).toBe(true);
  expect(carries(`https://${"b".repeat(41)}.collector.example/`)).toBe(true);
});

test("a link handed over whole is seen, with or without its fragment", () => {
  const seen = ["Track it here: https://shop.example/track?order=8841 thanks"];
  expect(fetchUrlSeenV1("https://shop.example/track?order=8841", seen)).toBe(
    true,
  );
  expect(
    fetchUrlSeenV1("https://shop.example/track?order=8841#details", seen),
  ).toBe(true);
  expect(fetchUrlSeenV1("https://shop.example/track?order=8842", seen)).toBe(
    false,
  );
});

test("only a parseable url argument is an address", () => {
  expect(fetchUrlV1({ url: "https://example.com/a" })?.hostname).toBe(
    "example.com",
  );
  expect(fetchUrlV1({ url: "not a url" })).toBeUndefined();
  expect(fetchUrlV1({})).toBeUndefined();
});

test("a fetch that discloses is refused in words, never on a card", () => {
  expect(decide(0.8)).toMatchObject({
    decision: "reject",
    reasonCode: "no_authorization",
  });
  expect(decide(0.8)).not.toHaveProperty("askPerson");
  expect(decide(0.1)).toMatchObject({
    decision: "allow",
    reasonCode: "authorized",
  });
});

test("text addressing the review lowers the bar for refusing, never raises it", () => {
  expect(decide(0.2)).toMatchObject({ decision: "allow" });
  expect(decide(0.2, 0.9)).toMatchObject({ decision: "reject" });
  expect(decide(0.1, 0.9)).toMatchObject({ decision: "allow" });
});
