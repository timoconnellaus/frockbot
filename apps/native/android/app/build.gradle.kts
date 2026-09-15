import java.util.Base64

plugins {
    id("com.android.application")
    id("com.google.gms.google-services") version "4.5.0"
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Flutter passes every `--dart-define` as one comma-separated list of base64
// `NAME=value` pairs, so the Dart program and the manifest read the same switches.
fun dartDefine(name: String): String? = (project.findProperty("dart-defines") as? String)
    .orEmpty()
    .split(",")
    .mapNotNull { runCatching { String(Base64.getDecoder().decode(it)) }.getOrNull() }
    .firstOrNull { it.startsWith("$name=") }
    ?.substringAfter("=")

// One build switch controls both Dart transport and the separate Android identity.
val localDevelopment = dartDefine("FROCKBOT_LOCAL_DEV") == "true"

// The App Link host is the deployment's own, never a host written into this file:
// `scripts/native-update.py` takes it from `deployments/hosted.json` and the local
// stacks pass their own (ADR 0028).
val deploymentHost = dartDefine("FROCKBOT_ORIGIN")?.let { java.net.URI(it).host }

// The isolated development package has no production Firebase registration.
tasks.matching { it.name.endsWith("GoogleServices") }.configureEach {
    onlyIf { !localDevelopment }
}

val existingDebugKey = file(System.getenv("FROCKBOT_ANDROID_KEYSTORE") ?: "${System.getProperty("user.home")}/.android/debug.keystore")
check(existingDebugKey.isFile) { "Existing Android signing key is required. Never generate a replacement." }
val versionFloor = (System.getenv("FROCKBOT_ANDROID_VERSION_FLOOR")
    ?: System.getenv("FROCKBOT_INSTALLED_VERSION_CODE"))?.toIntOrNull()
    ?: error("Use scripts/native-update.py to select the release or patch baseline.")
check(flutter.versionCode > versionFloor) { "The build must exceed the release's version floor." }

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
        applicationId = if (localDevelopment) "com.frockbot.mobile.dev" else "com.frockbot.mobile"
        manifestPlaceholders["appLabel"] = if (localDevelopment) "FrockBot (Dev)" else "FrockBot"
        manifestPlaceholders["cleartext"] = localDevelopment.toString()
        // A build that names no deployment claims no App Link. `.invalid` never
        // resolves, so a forgotten define cannot claim another deployment's links;
        // the Dart client refuses such a build outright at its first request.
        manifestPlaceholders["linkHost"] = when {
            localDevelopment -> "localhost"
            deploymentHost != null -> deploymentHost
            else -> "unnamed.invalid"
        }
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
        val acceptance = dartDefine("NATIVE_ACCEPTANCE") == "true"
        buildConfigField("boolean", "NATIVE_ACCEPTANCE", acceptance.toString())
        // The notification tap target opens this deployment's own document, so
        // Kotlin reads the same host the App Link filter was built with.
        buildConfigField(
            "String",
            "LINK_HOST",
            "\"" + manifestPlaceholders["linkHost"] + "\"",
        )
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

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:34.18.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.core:core-ktx:1.17.0")
    // The badge reconcile rule is pure Kotlin so it can be run here rather
    // than on a device. `:app:testDebugUnitTest` covers it, and the pull
    // request's `Flutter` job runs that task, so a Kotlin source that stops
    // compiling fails a check rather than the next release build.
    testImplementation("junit:junit:4.13.2")
}
