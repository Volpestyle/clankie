package io.clankie.verifier;

import java.util.LinkedHashMap;
import java.util.Map;

record RelevantStateFingerprint(
    String fixtureSha256,
    long worldSeed,
    String playerName,
    String gameMode,
    String position,
    Map<String, String> blockStates,
    Map<String, Integer> inventory) {

  String sha256() {
    var state = new LinkedHashMap<String, Object>();
    state.put("fixtureSha256", fixtureSha256);
    state.put("worldSeed", worldSeed);
    state.put("playerName", playerName);
    state.put("gameMode", gameMode);
    state.put("position", position);
    state.put("blockStates", blockStates);
    state.put("inventory", inventory);
    return Hashing.sha256(Json.encode(state));
  }
}
