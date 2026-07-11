package io.clankie.verifier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

final class FrozenFixtureTest {
  @Test
  void embeddedFixtureMatchesItsFrozenHash() throws Exception {
    try (var fixture = getClass().getClassLoader().getResourceAsStream("scenario.yml");
        var hash = getClass().getClassLoader().getResourceAsStream("scenario.sha256")) {
      assertTrue(fixture != null && hash != null);
      String expected = new String(hash.readAllBytes(), StandardCharsets.UTF_8).trim().split("\\s+")[0];
      assertEquals(expected, Hashing.sha256(fixture.readAllBytes()));
    }
  }

  @Test
  void unsafeRunIdsCannotEscapeTheEvidenceRoot() {
    try {
      new ScenarioRun("../../tamper", java.time.Instant.EPOCH, "a".repeat(64), 8);
    } catch (IllegalArgumentException expected) {
      assertTrue(expected.getMessage().contains("Unsafe"));
      return;
    }
    assertFalse(true, "unsafe run id was accepted");
  }
}
