import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/services.dart';

/// The reviewed web theme's semantic colors, radii, typefaces and motion.
/// Native text/touch sizes follow platform accessibility instead of CSS pixels.
abstract final class FrockTheme {
  static const accent = Color(0xffec386b);
  static const window = Color(0xff1f1e24);
  static const surface = Color(0xff211f26);
  static const raised = Color(0xff2c2a33);
  static const border = Color(0xff3a3742);
  static const muted = Color(0xffaaa6b1);
  static const text = Color(0xfff4f2f6);
  static const fast = Duration(milliseconds: 140);
  static const enter = Duration(milliseconds: 260);

  static Duration motion(BuildContext context, [Duration duration = enter]) =>
      MediaQuery.disableAnimationsOf(context) ? Duration.zero : duration;

  static ThemeData theme(Brightness brightness) {
    final dark = brightness == Brightness.dark;
    final scheme =
        ColorScheme.fromSeed(
          seedColor: accent,
          brightness: brightness,
        ).copyWith(
          primary: dark ? accent : const Color(0xffbd1e50),
          onPrimary: Colors.white,
          surface: dark ? surface : const Color(0xfffaf8fb),
          onSurface: dark ? text : window,
          onSurfaceVariant: dark ? muted : const Color(0xff625c6b),
          surfaceContainerHighest: dark ? raised : const Color(0xffefebf1),
          outlineVariant: dark ? border : const Color(0xffdfd9e3),
        );
    final base = ThemeData(
      useMaterial3: true,
      brightness: brightness,
      colorScheme: scheme,
      fontFamily: 'Manrope',
    );
    final type = base.textTheme.apply(fontFamily: 'Manrope');
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(10),
    );
    return base.copyWith(
      scaffoldBackgroundColor: dark ? window : const Color(0xfffaf8fb),
      textTheme: type.copyWith(
        displaySmall: type.displaySmall?.copyWith(
          fontFamily: 'Archivo Black',
          fontSize: 32,
          height: 1.2,
          letterSpacing: -0.6,
        ),
        headlineMedium: type.headlineMedium?.copyWith(
          fontSize: 24,
          fontWeight: FontWeight.w700,
          height: 1.2,
        ),
        titleLarge: type.titleLarge?.copyWith(
          fontSize: 20,
          fontWeight: FontWeight.w700,
        ),
        titleMedium: type.titleMedium?.copyWith(
          fontSize: 17,
          fontWeight: FontWeight.w700,
        ),
        bodyLarge: type.bodyLarge?.copyWith(fontSize: 16, height: 1.5),
        bodyMedium: type.bodyMedium?.copyWith(fontSize: 14, height: 1.5),
        bodySmall: type.bodySmall?.copyWith(
          fontSize: 12,
          height: 1.5,
          color: scheme.onSurfaceVariant,
          fontFeatures: [const FontFeature.tabularFigures()],
        ),
        labelLarge: type.labelLarge?.copyWith(
          fontSize: 14,
          fontWeight: FontWeight.w700,
        ),
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: scheme.surface,
        foregroundColor: scheme.onSurface,
        surfaceTintColor: Colors.transparent,
        centerTitle: false,
        elevation: 0,
        systemOverlayStyle: dark
            ? SystemUiOverlayStyle.light
            : SystemUiOverlayStyle.dark,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(48, 52),
          shape: shape,
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(48, 48),
          shape: shape,
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(48, 48),
          shape: shape,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerHighest,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(14),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 16,
          vertical: 16,
        ),
      ),
      dividerTheme: DividerThemeData(
        color: scheme.outlineVariant,
        thickness: 1,
      ),
      listTileTheme: ListTileThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        selectedTileColor: scheme.primary.withValues(alpha: 0.12),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: shape,
      ),
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: {
          TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
          TargetPlatform.macOS: CupertinoPageTransitionsBuilder(),
          TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
        },
      ),
    );
  }
}

class SheepAvatar extends StatelessWidget {
  final double size;
  const SheepAvatar({super.key, this.size = 40});
  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(size * 0.27),
    child: Image.asset(
      'assets/sheep.png',
      width: size,
      height: size,
      excludeFromSemantics: true,
    ),
  );
}

/// Finite, quiet placeholders: no idle animation or accessibility chatter.
class FrockSkeleton extends StatelessWidget {
  final double width;
  final double height;
  const FrockSkeleton({
    super.key,
    this.width = double.infinity,
    this.height = 16,
  });
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
      ),
    ),
  );
}
