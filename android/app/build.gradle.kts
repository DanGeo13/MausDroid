import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val versions = groovy.json.JsonSlurper().parse(rootProject.file("../version.json")) as Map<*, *>
val apkVersion = versions["apk"] as String
val apkCode = apkVersion.split(".").let { (it[0].toInt() * 10000) + (it[1].toInt() * 100) + it[2].toInt() }

// Release signing comes from environment variables (GitHub Actions secrets) or
// android/keystore.properties locally. The same key must sign every version.
val ksProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signing(name: String): String? = System.getenv("MAUSDROID_$name") ?: ksProps.getProperty(name)

android {
    namespace = "au.mausdroid"
    compileSdk = 36
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "au.mausdroid"
        minSdk = 28
        // Sideloaded app: targeting API 28 lets DanDroid run the official
        // Claude Code / Codex programs and its built-in Tailscale on the phone.
        targetSdk = 28
        versionCode = apkCode
        versionName = apkVersion
        ndk { abiFilters += listOf("arm64-v8a") }
        externalNativeBuild { cmake { cppFlags += "-std=c++17"; arguments += "-DANDROID_STL=c++_shared" } }
        buildConfigField("String", "UPDATE_URL", "\"https://raw.githubusercontent.com/DanGeo13/DanDroid/updates/update.json\"")
        buildConfigField("String", "UPDATE_PUBLIC_KEY", "\"${rootProject.file("../updates-public-key.txt").readText().trim()}\"")
        buildConfigField("String", "ENGINE_VERSION", "\"${versions["engine"]}\"")
    }

    signingConfigs {
        create("release") {
            val store = signing("KEYSTORE_FILE")
            if (store != null) {
                storeFile = file(store)
                storePassword = signing("KEYSTORE_PASSWORD")
                keyAlias = signing("KEY_ALIAS")
                keyPassword = signing("KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (signing("KEYSTORE_FILE") != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }
    buildFeatures { buildConfig = true }
    // Installed directly (not via Google Play), so the Play target rule does not apply.
    lint { disable += "ExpiredTargetSdkVersion" }
    externalNativeBuild { cmake { path = file("src/main/cpp/CMakeLists.txt") } }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { jniLibs { useLegacyPackaging = true } }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    testImplementation("junit:junit:4.13.2")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    // Scanning the QR code on your PC to link it (Google's scanner: no camera permission needed).
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
}
