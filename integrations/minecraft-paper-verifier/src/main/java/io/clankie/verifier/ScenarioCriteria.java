package io.clankie.verifier;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.attribute.Attribute;
import org.bukkit.configuration.InvalidConfigurationException;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;

record ScenarioCriteria(
    int schemaVersion,
    String scenarioId,
    int scenarioVersion,
    String fixtureSha256,
    String worldId,
    String worldName,
    long worldSeed,
    String playerName,
    int maxDurationSeconds,
    int maxEvents,
    int minimumLogs,
    Set<Material> allowedLogs,
    Spawn spawn,
    Cuboid target,
    List<BlockSpec> resetBlocks) {

  record BlockPos(int x, int y, int z) {
    String stable() {
      return x + "," + y + "," + z;
    }
  }

  record BlockSpec(BlockPos position, Material material) {}

  record Spawn(double x, double y, double z, float yaw, float pitch) {}

  record Cuboid(BlockPos min, BlockPos max) {
    boolean contains(BlockPos position) {
      return position.x >= min.x
          && position.x <= max.x
          && position.y >= min.y
          && position.y <= max.y
          && position.z >= min.z
          && position.z <= max.z;
    }
  }

  static ScenarioCriteria load(JavaPlugin plugin) throws IOException, InvalidConfigurationException {
    byte[] fixture;
    String expectedHash;
    try (var fixtureStream = plugin.getResource("scenario.yml");
        var hashStream = plugin.getResource("scenario.sha256")) {
      if (fixtureStream == null || hashStream == null) throw new IOException("Frozen fixture resources are missing");
      fixture = fixtureStream.readAllBytes();
      expectedHash = new String(hashStream.readAllBytes(), StandardCharsets.UTF_8).trim().split("\\s+")[0];
    }
    String actualHash = Hashing.sha256(fixture);
    if (!actualHash.equals(expectedHash)) throw new IOException("Embedded frozen fixture hash mismatch");

    var config = new YamlConfiguration();
    config.loadFromString(new String(fixture, StandardCharsets.UTF_8));
    var allowedLogs = new LinkedHashSet<Material>();
    for (String name : config.getStringList("allowed-logs")) allowedLogs.add(requireMaterial(name));
    var resetBlocks = new ArrayList<BlockSpec>();
    for (String encoded : config.getStringList("reset-blocks")) {
      String[] parts = encoded.split(",");
      if (parts.length != 4) throw new InvalidConfigurationException("Invalid reset block: " + encoded);
      resetBlocks.add(
          new BlockSpec(
              new BlockPos(Integer.parseInt(parts[0]), Integer.parseInt(parts[1]), Integer.parseInt(parts[2])),
              requireMaterial(parts[3])));
    }
    resetBlocks.sort(Comparator.comparing(block -> block.position().stable()));
    return new ScenarioCriteria(
        config.getInt("schema-version"),
        required(config, "scenario-id"),
        config.getInt("scenario-version"),
        actualHash,
        required(config, "world-id"),
        required(config, "world-name"),
        config.getLong("world-seed"),
        required(config, "player-name"),
        config.getInt("max-duration-seconds"),
        config.getInt("max-events"),
        config.getInt("minimum-logs"),
        Set.copyOf(allowedLogs),
        new Spawn(
            config.getDouble("spawn.x"),
            config.getDouble("spawn.y"),
            config.getDouble("spawn.z"),
            (float) config.getDouble("spawn.yaw"),
            (float) config.getDouble("spawn.pitch")),
        new Cuboid(readPos(config, "target-min"), readPos(config, "target-max")),
        List.copyOf(resetBlocks));
  }

  void reset(World world, Player player) {
    requireWorld(world);
    if (!player.getName().equals(playerName)) throw new IllegalStateException("Unexpected scenario player");
    world.setStorm(false);
    world.setThundering(false);
    world.setTime(1_000);
    for (int x = target.min.x; x <= target.max.x; x++) {
      for (int y = target.min.y; y <= target.max.y; y++) {
        for (int z = target.min.z; z <= target.max.z; z++) world.getBlockAt(x, y, z).setType(Material.AIR, false);
      }
    }
    for (var block : resetBlocks) {
      var position = block.position;
      world.getBlockAt(position.x, position.y, position.z).setType(block.material, false);
    }
    player.getInventory().clear();
    player.setGameMode(GameMode.SURVIVAL);
    var maxHealth = player.getAttribute(Attribute.MAX_HEALTH);
    if (maxHealth == null) throw new IllegalStateException("Player has no max-health attribute");
    player.setHealth(Math.min(20.0, maxHealth.getValue()));
    player.setFoodLevel(20);
    player.setFireTicks(0);
    player.setExp(0);
    player.setLevel(0);
    player.teleport(new Location(world, spawn.x, spawn.y, spawn.z, spawn.yaw, spawn.pitch));
  }

  String relevantStateSha256(World world, Player player) {
    requireWorld(world);
    var blocks = new LinkedHashMap<String, String>();
    for (var block : resetBlocks) {
      var position = block.position;
      blocks.put(position.stable(), world.getBlockAt(position.x, position.y, position.z).getType().name());
    }
    for (int x = target.min.x; x <= target.max.x; x++) {
      for (int y = target.min.y; y <= target.max.y; y++) {
        for (int z = target.min.z; z <= target.max.z; z++) {
          blocks.put(x + "," + y + "," + z, world.getBlockAt(x, y, z).getType().name());
        }
      }
    }
    var inventory = new LinkedHashMap<String, Integer>();
    for (var stack : player.getInventory().getContents()) {
      if (stack != null && stack.getType() != Material.AIR) {
        inventory.merge(stack.getType().name(), stack.getAmount(), Integer::sum);
      }
    }
    var location = player.getLocation();
    return new RelevantStateFingerprint(
            fixtureSha256,
            world.getSeed(),
            player.getName(),
            player.getGameMode().name(),
            location.getX() + "," + location.getY() + "," + location.getZ(),
            Map.copyOf(blocks),
            Map.copyOf(inventory))
        .sha256();
  }

  boolean isAllowedLog(Material material) {
    return allowedLogs.contains(material);
  }

  private void requireWorld(World world) {
    if (!world.getName().equals(worldName) || world.getSeed() != worldSeed) {
      throw new IllegalStateException("World identity or seed does not match the frozen fixture");
    }
  }

  private static BlockPos readPos(YamlConfiguration config, String path) {
    return new BlockPos(config.getInt(path + ".x"), config.getInt(path + ".y"), config.getInt(path + ".z"));
  }

  private static String required(YamlConfiguration config, String path) throws InvalidConfigurationException {
    String value = config.getString(path);
    if (value == null || value.isBlank()) throw new InvalidConfigurationException("Missing " + path);
    return value;
  }

  private static Material requireMaterial(String name) throws InvalidConfigurationException {
    Material material = Material.matchMaterial(name);
    if (material == null) throw new InvalidConfigurationException("Unknown material " + name);
    return material;
  }
}
