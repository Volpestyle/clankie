package io.clankie.verifier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import java.util.Map;
import org.junit.jupiter.api.Test;

final class RelevantStateFingerprintTest {
  @Test
  void sameSeedAndConfigProduceIdenticalRelevantState() {
    var first = state(774042, Map.of("0,65,0", "AIR", "-4,65,2", "OAK_LOG"));
    var second = state(774042, Map.of("-4,65,2", "OAK_LOG", "0,65,0", "AIR"));
    assertEquals(first.sha256(), second.sha256());
  }

  @Test
  void seedOrBlockDriftChangesTheRelevantStateHash() {
    var baseline = state(774042, Map.of("-4,65,2", "OAK_LOG"));
    assertNotEquals(baseline.sha256(), state(774043, Map.of("-4,65,2", "OAK_LOG")).sha256());
    assertNotEquals(baseline.sha256(), state(774042, Map.of("-4,65,2", "AIR")).sha256());
  }

  private RelevantStateFingerprint state(long seed, Map<String, String> blocks) {
    return new RelevantStateFingerprint(
        "a".repeat(64), seed, "Clankie", "SURVIVAL", "0.5,65.0,0.5", blocks, Map.of());
  }
}
