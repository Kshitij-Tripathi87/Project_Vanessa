import java.util.Collections
import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.dagger.hilt.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    kotlin("kapt")
}

val llamaCppDir = providers.gradleProperty("llamaCppDir").orNull?.takeIf { it.isNotBlank() }
if (llamaCppDir != null) {
    require(file("$llamaCppDir/CMakeLists.txt").isFile && file("$llamaCppDir/include/llama.h").isFile) {
        "llamaCppDir must point to a llama.cpp source checkout"
    }
}

android {
    namespace = "com.vanessa.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.vanessa.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"

        if (llamaCppDir != null) {
            ndk { abiFilters += "arm64-v8a" }
            externalNativeBuild {
                cmake {
                    arguments += listOf("-DLLAMA_CPP_DIR=$llamaCppDir", "-DANDROID_PLATFORM=android-28")
                }
            }
        }

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }
    }

    if (llamaCppDir != null) {
        ndkVersion = "27.2.12479018"
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.8"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // Generated protocol contract (single source of truth for the wire format)
    implementation(project(":core:protocol"))
    implementation(project(":core:agent"))

    // Kotlin
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.22")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    // AndroidX Core
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.activity:activity-compose:1.8.2")
    implementation("androidx.fragment:fragment-ktx:1.6.2")
    implementation("androidx.biometric:biometric:1.1.0")

    // Material theme (Theme.Vanessa extends Theme.Material3)
    implementation("com.google.android.material:material:1.11.0")

    // Compose
    implementation(platform("androidx.compose:compose-bom:2024.02.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.7.7")

    // Hilt (Dependency Injection)
    implementation("com.google.dagger:hilt-android:2.50")
    kapt("com.google.dagger:hilt-android-compiler:2.50")
    implementation("androidx.hilt:hilt-navigation-compose:1.1.0")

    // Ktor (WebSocket client)
    implementation("io.ktor:ktor-client-core:2.3.8")
    implementation("io.ktor:ktor-client-android:2.3.8")
    implementation("io.ktor:ktor-client-websockets:2.3.8")
    implementation("io.ktor:ktor-client-logging:2.3.8")
    implementation("io.ktor:ktor-serialization-kotlinx-json:2.3.8")
    implementation("io.ktor:ktor-client-content-negotiation:2.3.8")

    // Google Play services QR scanner presents a system UI without requiring camera permission.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // QR Code Scanner / CameraX dependencies remain available for custom capture flows.
    implementation("com.google.mlkit:barcode-scanning:17.2.0")
    implementation("androidx.camera:camera-core:1.3.1")
    implementation("androidx.camera:camera-camera2:1.3.1")
    implementation("androidx.camera:camera-lifecycle:1.3.1")
    implementation("androidx.camera:camera-view:1.3.1")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.0.0")

    // Testing
    testImplementation("junit:junit:4.13.2")
    // Real org.json on the JVM test classpath; the android.jar stub only throws.
    testImplementation("org.json:json:20231013")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.02.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

// Allow references to generated code
kapt {
    correctErrorTypes = true
}

// Release gate: an APK that merely compiles is not evidence that local inference shipped.
// Without the native runtime the app installs and runs, but `LlamaCppInference.isAvailable`
// is false forever, so every model feature is dead. Fail the build instead.
tasks.register("verifyLocalInferenceApk") {
    group = "verification"
    description = "Asserts the debug APK contains the arm64 inference runtime and no embedded GGUF."
    dependsOn("assembleDebug")
    val apk = layout.buildDirectory.file("outputs/apk/debug/app-debug.apk")
    doLast {
        val file = apk.get().asFile
        require(file.isFile) { "No APK at $file; run :app:assembleDebug first" }
        // Inspect the assembled APK's native libraries to confirm the inference runtime
        // was actually linked in, rather than just a debug build that never loads a model.
        val entries: List<String> = ZipFile(file).use { zip ->
            Collections.list(zip.entries()).map { entry -> entry.name }
        }
        val required = listOf(
            "lib/arm64-v8a/libvanessa_llama.so",
            "lib/arm64-v8a/libllama.so",
        )
        val missing = required.filterNot(entries::contains)
        require(missing.isEmpty()) {
            "APK ${file.name} is missing the local inference runtime: $missing. " +
                "Rebuild with -PllamaCppDir=<llama.cpp checkout> (see scripts/fetch-llama-cpp.sh)."
        }
        // The model stays a separately managed asset; embedding it would bloat the APK
        // and let the app drift from the validated artifact.
        val embedded = entries.filter { it.endsWith(".gguf", ignoreCase = true) }
        require(embedded.isEmpty()) { "APK embeds a GGUF model: $embedded" }
        println("verifyLocalInferenceApk: ${required.size} inference libraries present, no GGUF embedded")
    }
}
