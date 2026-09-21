import type { DictationCleanupFixtureV1 } from "./dictation-cleanup.js";

export const dictationCleanupFixturesV1: readonly DictationCleanupFixtureV1[] =
  [
    {
      name: "self-correction",
      intent: "A mid-sentence correction keeps only the final wording.",
      evidence: {
        raw: "Check Thursday, sorry, Friday's flights. Don't book anything.",
        tidied: "Check Friday's flights. Don't book anything.",
      },
      expected: { fidelity: "faithful" },
    },
    {
      name: "fillers-and-repetitions",
      intent: "Fillers and accidental repetitions drop; the message stays.",
      evidence: {
        raw: "So um I I think we should we should look at the the pricing page again",
        tidied: "So I think we should look at the pricing page again.",
      },
      expected: { fidelity: "faithful" },
    },
    {
      name: "list-formatting",
      intent: "A spoken enumeration may become a list.",
      evidence: {
        raw: "three things first the flights second the hotel and third the car",
        tidied: "Three things:\n\n- the flights\n- the hotel\n- the car",
      },
      expected: { fidelity: "faithful" },
    },
    {
      name: "question-stays-question",
      intent: "A dictated question that is still a question is a tidy.",
      evidence: {
        raw: "um what time does the uh the Friday flight get in?",
        tidied: "What time does the Friday flight get in?",
      },
      expected: { fidelity: "faithful" },
    },
    {
      name: "one-negation-in-a-correction",
      intent: "A self-correction may drop one negation while others remain.",
      evidence: {
        raw: "Don't, I mean, do not call them, and no emails either.",
        tidied: "Do not call them, and no emails either.",
      },
      expected: { fidelity: "faithful" },
    },
    {
      name: "spoken-quotes",
      intent: "Quotation marks the person said stay in a tidy.",
      evidence: {
        raw: '"Book it," she said, um, "before Friday, please."',
        tidied: '"Book it," she said, "before Friday, please."',
      },
      expected: { fidelity: "faithful" },
    },
    {
      name: "lost-negation",
      intent: "Dropping the only negation changes what they said.",
      evidence: {
        raw: "Check Friday's flights. Don't book anything.",
        tidied: "Check Friday's flights and book them.",
      },
      expected: { fidelity: "unfaithful" },
    },
    {
      name: "exploratory-became-instruction",
      intent: "Thinking aloud must not become an order.",
      evidence: {
        raw: "Maybe we should change the model. Find out if it's worth it.",
        tidied: "Change the model. Find out if it's worth it.",
      },
      expected: { fidelity: "unfaithful" },
    },
    {
      name: "summarised",
      intent: "A summary is not a tidy.",
      evidence: {
        raw:
          "So the thing about Tuesday is that the venue needs confirming and the " +
          "caterer has not come back to us and I would like to know about parking",
        tidied: "Sort out Tuesday.",
      },
      expected: { fidelity: "unfaithful" },
    },
    {
      name: "answered-question",
      intent: "Answering the dictated question is not tidying it.",
      evidence: {
        raw: "What time does the Friday flight to Melbourne get in?",
        tidied: "The Friday flight to Melbourne arrives at 4:35pm.",
      },
      expected: { fidelity: "unfaithful" },
    },
    {
      name: "added-information",
      intent: "A destination and a time nobody said are invented.",
      evidence: {
        raw: "Check the Friday flights.",
        tidied:
          "Check the Friday flights to Melbourne, which leave hourly from gate 12.",
      },
      expected: { fidelity: "unfaithful" },
    },
    {
      name: "meta-preamble",
      intent: "A model talking to us is not a tidy.",
      evidence: {
        raw: "um check the Friday flights for me would you",
        tidied: "Here is the tidied text: Check the Friday flights.",
      },
      expected: { fidelity: "unfaithful" },
    },
    {
      name: "code-fence",
      intent: "Wrapping the answer in a fence is a reply, not a tidy.",
      evidence: {
        raw: "um so check the Friday flights before the weekend",
        tidied: "```\nCheck the Friday flights before the weekend.\n```",
      },
      expected: { fidelity: "unfaithful" },
    },
  ];
