import java.security.MessageDigest

plugins { java }

group = "io.clankie"
version = "0.1.0"

repositories {
  mavenCentral()
  maven("https://repo.papermc.io/repository/maven-public/") {
    name = "papermc"
    metadataSources {
      mavenPom()
      artifact()
    }
  }
}

dependencies {
  compileOnly("io.papermc.paper:paper-api:1.21.11-R0.1-SNAPSHOT")
  testImplementation(platform("org.junit:junit-bom:5.11.4"))
  testImplementation("org.junit.jupiter:junit-jupiter")
  testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

configurations.testImplementation { extendsFrom(configurations.compileOnly.get()) }
configurations.testRuntimeOnly { extendsFrom(configurations.compileOnly.get()) }

java { toolchain.languageVersion.set(JavaLanguageVersion.of(21)) }

val frozenFixtureDir = layout.projectDirectory.dir("../../scenarios/minecraft/collect-craft-place/v1")
val frozenFixture = frozenFixtureDir.file("scenario.yml")
val frozenFixtureHash = frozenFixtureDir.file("scenario.sha256")
val serverConfig = frozenFixtureDir.file("server.properties")
val serverConfigHash = frozenFixtureDir.file("server.properties.sha256")
val generatedFixtureResources = layout.buildDirectory.dir("generated/frozen-fixture")
val scenarioEvidence = layout.buildDirectory.dir("scenario-evidence")

fun sha256(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

val verifyFrozenFixture by tasks.registering {
  inputs.files(frozenFixture, frozenFixtureHash, serverConfig, serverConfigHash)
  doLast {
    val expected = frozenFixtureHash.asFile.readText().trim().substringBefore(" ")
    val actual = sha256(frozenFixture.asFile.readBytes())
    check(expected == actual) { "Frozen fixture hash mismatch: expected $expected, got $actual" }
    val expectedServer = serverConfigHash.asFile.readText().trim().substringBefore(" ")
    val actualServer = sha256(serverConfig.asFile.readBytes())
    check(expectedServer == actualServer) {
      "Frozen server config hash mismatch: expected $expectedServer, got $actualServer"
    }
  }
}

val copyFrozenFixture by tasks.registering(Copy::class) {
  dependsOn(verifyFrozenFixture)
  from(frozenFixtureDir) { include("scenario.yml", "scenario.sha256") }
  into(generatedFixtureResources)
}

sourceSets.main { resources.srcDir(generatedFixtureResources) }
tasks.processResources { dependsOn(copyFrozenFixture) }
tasks.test {
  dependsOn(verifyFrozenFixture)
  useJUnitPlatform()
  doFirst { delete(scenarioEvidence) }
  systemProperty("scenario.evidence.dir", scenarioEvidence.get().asFile)
}

tasks.jar {
  archiveBaseName.set("clankie-paper-verifier")
  manifest { attributes["Implementation-Version"] = project.version }
}
