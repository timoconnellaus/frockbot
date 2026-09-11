allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
// A plugin that pins an old compileSdk fails the whole build the moment one
// of its AndroidX dependencies requires a newer one: `flutter_pcm_sound`
// compiles against 33 and pulls in libraries that require 34 or later. Every
// Android subproject is lifted to the app's own compileSdk here. That is
// which APIs a plugin may compile against, not which devices it runs on —
// minSdk and targetSdk are untouched, and so is the plugin's source.
//
// Reflection rather than an AGP type: the root project does not carry the
// Android Gradle Plugin on its buildscript classpath.
subprojects {
    afterEvaluate {
        val android = extensions.findByName("android") ?: return@afterEvaluate
        val current =
            runCatching {
                android.javaClass.getMethod("getCompileSdk").invoke(android) as? Int
            }.getOrNull()
                ?: runCatching {
                    (android.javaClass.getMethod("getCompileSdkVersion").invoke(android) as? String)
                        ?.removePrefix("android-")
                        ?.toIntOrNull()
                }.getOrNull()
        if (current != null && current < 36) {
            runCatching {
                android.javaClass.getMethod("setCompileSdk", Integer::class.java)
                    .invoke(android, 36)
            }.recoverCatching {
                android.javaClass.getMethod("compileSdkVersion", Int::class.javaPrimitiveType)
                    .invoke(android, 36)
            }.getOrThrow()
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}

subprojects {
    project.evaluationDependsOn(":app")
}
