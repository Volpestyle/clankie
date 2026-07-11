package io.clankie.verifier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;

final class EventChainTest {
  @Test
  void chainsBoundedEventsAndFailsClosedOnOverflow() {
    var chain = new EventChain(2);
    assertTrue(chain.append("one", Instant.EPOCH, Map.of("value", 1)));
    String first = chain.headSha256();
    assertTrue(chain.append("two", Instant.EPOCH.plusSeconds(1), Map.of("value", 2)));
    assertNotEquals(first, chain.headSha256());
    assertFalse(chain.append("three", Instant.EPOCH.plusSeconds(2), Map.of()));
    assertTrue(chain.overflowed());
    assertEquals(2, chain.lines().size());
  }

  @Test
  void identicalInputsProduceIdenticalChains() {
    var first = new EventChain(4);
    var second = new EventChain(4);
    first.append("event", Instant.EPOCH, Map.of("stable", true));
    second.append("event", Instant.EPOCH, Map.of("stable", true));
    assertEquals(first.lines(), second.lines());
    assertEquals(first.headSha256(), second.headSha256());
  }

  @Test
  void scenarioEndIsIdempotent() {
    var run = new ScenarioRun("idempotent", Instant.EPOCH, "a".repeat(64), 8);
    run.finish(Instant.EPOCH.plusSeconds(1));
    int endedSize = run.events().lines().size();
    run.finish(Instant.EPOCH.plusSeconds(2));
    assertEquals(endedSize, run.events().lines().size());
    assertEquals(Instant.EPOCH.plusSeconds(1), run.endedAt());
  }
}
