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
// The app compiles against 37 (secure storage 11's floor). Some plugins still
// name an older compileSdk of their own — flutter_pcm_sound 3.3.3, the newest
// published version, is pinned to 33 — while depending on androidx artifacts
// (fragment 1.7.1, window 1.2.0, activity 1.8.1, lifecycle 2.7.0) that refuse
// to be consumed below 34. That mismatch fails `checkReleaseAarMetadata`
// before any of our own code is compiled.
//
// compileSdk is the API level a library is compiled against, not one it
// requires at runtime: minSdk 24 and targetSdk 36 are untouched here, so
// lifting a lagging plugin to the app's level changes which devices can run
// this build not at all. Only plugins below the app are lifted, so one that
// has already moved on keeps what it chose. Delete this block once every
// plugin we depend on compiles against 34 or newer.
val appCompileSdk = 37

fun liftCompileSdk(target: Project) {
    val android = target.extensions.findByName("android") ?: return
    val declared = runCatching {
        android.withGroovyBuilder { getProperty("compileSdkVersion") } as? String
    }.getOrNull()
    val level = declared?.removePrefix("android-")?.toIntOrNull() ?: return
    if (level >= appCompileSdk) return
    target.logger.lifecycle(
        "Lifting ${target.name} compileSdk from $level to $appCompileSdk so its " +
            "androidx dependencies resolve.",
    )
    android.withGroovyBuilder { "compileSdkVersion"(appCompileSdk) }
}

// `evaluationDependsOn` below evaluates projects as it walks them, so some are
// already configured by the time this runs; those cannot take an
// `afterEvaluate` and are lifted in place instead.
subprojects {
    if (state.executed) liftCompileSdk(project) else afterEvaluate { liftCompileSdk(project) }
}

subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
