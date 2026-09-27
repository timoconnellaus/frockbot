/** The pattern `ClientHello.nativeVersion` accepts, so a release can always say its name. */
const RELEASE =
  /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z.-]{1,20})?$/u;

/**
 * The version tag `release.yml` builds, without its `v`, from
 * `FROCKBOT_RELEASE`; null for any other build. Shared by the web client build
 * here and `scripts/native-metadata.ts`, so the two cannot disagree about what
 * a release is called.
 */
export function releaseVersion(value: string | undefined) {
  if (value === undefined || value === "") return null;
  const match = RELEASE.exec(value);
  if (!match || value.length > 32) {
    throw new Error(
      `FROCKBOT_RELEASE must be a version tag without its \`v\`, such as 0.7.163 or 0.8.0-rc.1, not ${JSON.stringify(value)}.`,
    );
  }
  return { release: value, versionName: `${match[1]}.${match[2]}.${match[3]}` };
}
