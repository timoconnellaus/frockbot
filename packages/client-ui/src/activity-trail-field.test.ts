import { describe, expect, test } from "bun:test";
import {
  ACTIVITY_TRAIL_ACCENT_V1,
  ACTIVITY_TRAIL_MAX_PARTICLES_V1,
  ACTIVITY_TRAIL_PALE_V1,
  activityTrailColourV1,
  activityTrailRadiusV1,
  advanceActivityTrailFieldV1,
  burstActivityTrailFieldV1,
  createActivityTrailFieldV1,
  parseActivityTrailColourV1,
  type ActivityTrailGeometryV1,
} from "./activity-trail-field.js";

const geometry: ActivityTrailGeometryV1 = {
  originX: 6,
  centreY: 22,
  width: 200,
};

/** Every random draw lands in the middle of its range. */
const middling = () => 0.5;

describe("the comet trail's particle field", () => {
  test("particles are born at the avatar's edge and flow right", () => {
    const field = createActivityTrailFieldV1();
    burstActivityTrailFieldV1(field, {
      count: 3,
      speed: 1,
      brightness: 1,
      geometry,
      random: middling,
    });
    expect(field.particles).toHaveLength(3);
    for (const particle of field.particles) {
      expect(particle.x).toBe(geometry.originX);
      expect(particle.vx).toBeGreaterThan(0);
    }

    advanceActivityTrailFieldV1(field, {
      seconds: 0.1,
      rate: 0,
      geometry,
      random: middling,
    });
    for (const particle of field.particles) {
      expect(particle.x).toBeGreaterThan(geometry.originX);
    }
  });

  test("a fractional rate still emits, one particle at a time", () => {
    // Six a second at sixty frames a second is a particle every tenth of a
    // second, not a particle every frame and not none at all.
    const field = createActivityTrailFieldV1();
    for (let frame = 0; frame < 5; frame += 1) {
      advanceActivityTrailFieldV1(field, {
        seconds: 1 / 60,
        rate: 6,
        geometry,
        random: middling,
      });
    }
    expect(field.particles).toHaveLength(0);
    for (let frame = 0; frame < 7; frame += 1) {
      advanceActivityTrailFieldV1(field, {
        seconds: 1 / 60,
        rate: 6,
        geometry,
        random: middling,
      });
    }
    expect(field.particles).toHaveLength(1);
  });

  test("a rate of zero drains the field rather than freezing it", () => {
    const field = createActivityTrailFieldV1();
    burstActivityTrailFieldV1(field, {
      count: 10,
      speed: 1,
      brightness: 1,
      geometry,
      random: middling,
    });
    for (let frame = 0; frame < 200; frame += 1) {
      advanceActivityTrailFieldV1(field, {
        seconds: 1 / 60,
        rate: 0,
        geometry,
        random: middling,
      });
    }
    expect(field.particles).toHaveLength(0);
  });

  test("particles are purged before they can be drawn dead", () => {
    const field = createActivityTrailFieldV1();
    burstActivityTrailFieldV1(field, {
      count: 4,
      speed: 1,
      brightness: 1,
      geometry,
      random: middling,
    });
    advanceActivityTrailFieldV1(field, {
      seconds: 0.1,
      rate: 0,
      geometry,
      random: middling,
    });
    for (const particle of field.particles) {
      expect(particle.life).toBeGreaterThan(0);
      expect(particle.x).toBeLessThanOrEqual(geometry.width + particle.radius);
    }
  });

  test("a particle past the right edge is gone", () => {
    const field = createActivityTrailFieldV1();
    burstActivityTrailFieldV1(field, {
      count: 1,
      speed: 1,
      brightness: 1,
      geometry,
      random: middling,
    });
    const narrow = { ...geometry, width: 8 };
    advanceActivityTrailFieldV1(field, {
      seconds: 0.1,
      rate: 0,
      geometry: narrow,
      random: middling,
    });
    expect(field.particles).toHaveLength(0);
  });

  test("the field never grows without bound", () => {
    const field = createActivityTrailFieldV1();
    burstActivityTrailFieldV1(field, {
      count: 5000,
      speed: 1,
      brightness: 1,
      geometry,
      random: middling,
    });
    expect(field.particles).toHaveLength(ACTIVITY_TRAIL_MAX_PARTICLES_V1);
  });

  test("a background tab's enormous frame does not teleport the field", () => {
    const field = createActivityTrailFieldV1();
    advanceActivityTrailFieldV1(field, {
      seconds: 600,
      rate: 40,
      geometry,
      random: middling,
    });
    expect(field.particles.length).toBeLessThanOrEqual(
      ACTIVITY_TRAIL_MAX_PARTICLES_V1,
    );
    for (const particle of field.particles) {
      expect(particle.x).toBeLessThanOrEqual(geometry.width + particle.radius);
    }
  });

  test("the drawn radius is never negative", () => {
    // `arc` throws on a negative radius, and life crosses zero on the frame
    // before the purge sees it.
    expect(
      activityTrailRadiusV1({
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: -3,
        decay: 1,
        radius: 2,
        tone: 0,
        brightness: 1,
      }),
    ).toBeGreaterThan(0);
  });

  test("colour blends between the app's text colour and its accent", () => {
    const particle = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 1,
      decay: 1,
      radius: 1,
      tone: 0.5,
      brightness: 1,
    };
    const blended = activityTrailColourV1(particle);
    expect(blended).toMatch(/^rgba\(\d+,\d+,\d+,[\d.]+\)$/);

    // Fully pale and fully accent are the ends the blend runs between.
    const flat = { pale: [0, 0, 0], accent: [0, 0, 0] } as const;
    expect(activityTrailColourV1(particle, flat)).toContain("rgba(0,0,0,");

    // A brighter burst is more opaque than the steady stream.
    const alphaOf = (value: string) =>
      Number(value.split(",")[3]?.slice(0, -1));
    expect(
      alphaOf(activityTrailColourV1({ ...particle, brightness: 1.9 })),
    ).toBeGreaterThan(alphaOf(blended));

    // …and never past opaque.
    expect(
      alphaOf(activityTrailColourV1({ ...particle, brightness: 40 })),
    ).toBe(1);
  });

  test("theme colours are read where they parse, and fall back where they do not", () => {
    expect(parseActivityTrailColourV1("#f4f2f6")).toEqual([
      ...ACTIVITY_TRAIL_PALE_V1,
    ]);
    expect(parseActivityTrailColourV1(" #EC386B ")).toEqual([
      ...ACTIVITY_TRAIL_ACCENT_V1,
    ]);
    expect(parseActivityTrailColourV1("rgb(236, 56, 107)")).toEqual([
      ...ACTIVITY_TRAIL_ACCENT_V1,
    ]);
    expect(parseActivityTrailColourV1("rgba(236 56 107 / 40%)")).toEqual([
      ...ACTIVITY_TRAIL_ACCENT_V1,
    ]);
    expect(
      parseActivityTrailColourV1("color-mix(in oklab, red, blue)"),
    ).toBeUndefined();
    expect(parseActivityTrailColourV1("")).toBeUndefined();
  });
});
