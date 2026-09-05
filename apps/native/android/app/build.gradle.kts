import java.util.Base64

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val existingDebugKey = file(System.getenv("FROCKBOT_ANDROID_KEYSTORE") ?: "${System.getProperty("user.home")}/.android/debug.keystore")
check(existingDebugKey.isFile) { "Existing Android signing key is required. Never generate a replacement." }
val installedCode = System.getenv("FROCKBOT_INSTALLED_VERSION_CODE")?.toIntOrNull()
    ?: error("Read the installed Pixel versionCode with scripts/native-acceptance.sh before building.")
check(flutter.versionCode > installedCode) { "The build must upgrade the installed versionCode." }

android {
    namespace = "com.frockbot.mobile"
    // Secure storage 11 requires API 37 at compile time; device floor/target remain 24/36.
    compileSdk = 37
    ndkVersion = flutter.ndkVersion
    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Preserve the installed Capacitor identity.
        applicationId = "com.frockbot.mobile"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 24
        targetSdk = 36
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        val acceptance = (project.findProperty("dart-defines") as? String).orEmpty().split(",").any {
            runCatching { String(Base64.getDecoder().decode(it)) == "NATIVE_ACCEPTANCE=true" }.getOrDefault(false)
        }
        buildConfigField("boolean", "NATIVE_ACCEPTANCE", acceptance.toString())
    }

    signingConfigs.getByName("debug") {
        storeFile = existingDebugKey
        storePassword = "android"
        keyAlias = "androiddebugkey"
        keyPassword = "android"
    }
    buildTypes {
        release {
            // The Pixel development upgrade track deliberately keeps its existing signer.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
