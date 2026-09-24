{{flutter_js}}
{{flutter_build_config}}
// The engine's fallback fonts (the Noto faces it fetches for a glyph the
// app's own fonts lack, such as "♯") come from this origin, where
// `apps/cloudflare/build-flutter-web.ts` stages them beside the build. Its
// default is fonts.gstatic.com, which the app document's `connect-src 'self'`
// refuses, leaving the glyph undrawn.
_flutter.loader.load({
  config: {
    fontFallbackBaseUrl: new URL("fallback-fonts/", document.baseURI).href,
  },
});
