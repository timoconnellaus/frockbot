/**
 * The longest a single Turn may run before the loop stops waiting for it.
 *
 * Nothing bounded a Turn's wall clock before this: one hung for seventeen
 * minutes with an animated avatar and nothing else, and would have hung until
 * the isolate died. Fifteen minutes is well past any Turn a person is watching
 * and well inside the point at which they have concluded the product is broken.
 *
 * It lives in the contracts rather than in the loop that enforces it because
 * two parties need the same number: the loop, which aborts on it, and the
 * repair that settles a run still marked `running` once it cannot possibly
 * still be running. A repair that used a different number would either leave
 * a dead Turn holding its record or cut a live one off.
 */
export const TURN_DEADLINE_MS_V1 = 15 * 60 * 1000;
