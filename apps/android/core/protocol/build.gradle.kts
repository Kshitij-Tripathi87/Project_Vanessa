plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    jvmToolchain(17)
}

// Both runtimes consume the exact same checked-in conversation fixtures. Gradle
// copies these as test resources; there is no hand-maintained Android duplicate.
sourceSets {
    test {
        resources.srcDir(rootProject.file("../../packages/protocol/fixtures"))
    }
}

dependencies {
    // Generated models use kotlinx.serialization annotations and JsonObject/JsonArray.
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    testImplementation(kotlin("test-junit"))
}
