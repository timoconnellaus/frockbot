import { noul, type JsonValue, type TypeSafeClient } from "@typesafe-ai/sdk";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";

// Which of the Bot's Skills a request is likely to need, named at the tail of
// the Turn's first request. The catalog in the system prompt stays whole and
// unchanged, so the cached prefix holds; this only points. Context quality,
// not safety: a judgment that fails names nothing.

/** The most Skills one judgment reads. A larger catalog is not nominated from. */
export const SKILL_NOMINATION_JUDGED_MAX_V1 = 24;

/** At or above this, a Skill is named. */
export const SKILL_NOMINATION_YES_V1 = 0.7;

/** The most Skills one note names. */
export const SKILL_NOMINATION_NAMED_MAX_V1 = 3;

export const SKILL_NOMINATION_TIMEOUT_MS_V1 = 3_000;

export interface SkillCandidateV1 {
  /** What `skill_load` takes: the ref, or the path when there is none. */
  readonly load: string;
  readonly name: string;
  readonly description: string;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function skillNominationStateV1(input: {
  request: string;
  skills: readonly SkillCandidateV1[];
}): Record<string, JsonValue> {
  return {
    request: clip(input.request, 600),
    skills: input.skills.map((skill) => ({
      name: skill.name,
      description: clip(skill.description, 300),
    })),
  };
}

export function skillNominationQuestionsV1(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `s${index}`,
      noul(
        {
          target: `\`skills[${index}]\`, a recipe the Bot can load`,
          decision:
            "Would following this Skill help the Bot do what `request` asks?",
        },
        {
          true: "It is about this kind of work",
          false: "It is about something else",
        },
      ),
    ]),
  );
}

/** The Skills to name, strongest first, or none when Jev cannot say. */
export async function nominateSkillsV1(
  client: TypeSafeClient,
  input: {
    request: string;
    skills: readonly SkillCandidateV1[];
    signal?: AbortSignal;
  },
): Promise<SkillCandidateV1[]> {
  const skills = input.skills;
  if (
    skills.length === 0 ||
    skills.length > SKILL_NOMINATION_JUDGED_MAX_V1 ||
    !input.request.trim()
  ) {
    return [];
  }
  try {
    const { answers } = await client.systemOne(
      {
        state: skillNominationStateV1({ request: input.request, skills }),
        questions: skillNominationQuestionsV1(skills.length),
        model: RESPONSE_REVIEW_MODEL_V1,
      },
      {
        retry: { maxRetries: 0 },
        timeout: SKILL_NOMINATION_TIMEOUT_MS_V1,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    return skills
      .map((skill, index) => {
        const answer = (answers as Record<string, { noul?: unknown }>)[
          `s${index}`
        ];
        return {
          skill,
          score: typeof answer?.noul === "number" ? answer.noul : 0,
          index,
        };
      })
      .filter((entry) => entry.score >= SKILL_NOMINATION_YES_V1)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, SKILL_NOMINATION_NAMED_MAX_V1)
      .map((entry) => entry.skill);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return [];
  }
}
