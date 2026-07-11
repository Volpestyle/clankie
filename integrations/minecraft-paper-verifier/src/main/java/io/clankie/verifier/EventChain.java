package io.clankie.verifier;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class EventChain {
  private final int maximum;
  private final List<String> lines = new ArrayList<>();
  private String headSha256 = Hashing.ZERO_SHA256;
  private boolean overflowed;

  EventChain(int maximum) {
    if (maximum < 1) throw new IllegalArgumentException("maximum must be positive");
    this.maximum = maximum;
  }

  boolean append(String type, Instant occurredAt, Map<String, ?> data) {
    if (lines.size() >= maximum) {
      overflowed = true;
      return false;
    }
    var event = new LinkedHashMap<String, Object>();
    event.put("sequence", lines.size() + 1);
    event.put("type", type);
    event.put("occurredAt", occurredAt.toString());
    event.put("previousSha256", headSha256);
    event.put("data", data);
    String unsigned = Json.encode(event);
    headSha256 = Hashing.sha256(headSha256 + "\n" + unsigned);
    event.put("sha256", headSha256);
    lines.add(Json.encode(event));
    return true;
  }

  List<String> lines() {
    return List.copyOf(lines);
  }

  String headSha256() {
    return headSha256;
  }

  boolean overflowed() {
    return overflowed;
  }
}
