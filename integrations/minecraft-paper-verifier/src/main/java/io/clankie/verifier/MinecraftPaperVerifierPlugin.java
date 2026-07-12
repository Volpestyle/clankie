package io.clankie.verifier;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.bukkit.Bukkit;
import org.bukkit.GameMode;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.command.Command;
import org.bukkit.command.CommandExecutor;
import org.bukkit.command.CommandSender;
import org.bukkit.command.ConsoleCommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.inventory.CraftItemEvent;
import org.bukkit.event.inventory.InventoryCreativeEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerGameModeChangeEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;

public final class MinecraftPaperVerifierPlugin extends JavaPlugin implements Listener, CommandExecutor {
  private final EvidenceWriter evidenceWriter = new EvidenceWriter();
  private final ScenarioEvaluator evaluator = new ScenarioEvaluator();
  private ScenarioCriteria criteria;
  private ScenarioRun active;

  @Override
  public void onEnable() {
    try {
      criteria = ScenarioCriteria.load(this);
    } catch (Exception error) {
      getLogger().severe("Frozen verifier fixture failed closed: " + error.getMessage());
      Bukkit.getPluginManager().disablePlugin(this);
      return;
    }
    Bukkit.getPluginManager().registerEvents(this, this);
    var command = getCommand("mcscenario");
    if (command == null) throw new IllegalStateException("mcscenario missing from plugin.yml");
    command.setExecutor(this);
    getLogger().info("Loaded frozen scenario " + criteria.scenarioId() + "@" + criteria.scenarioVersion()
        + " sha256=" + criteria.fixtureSha256());
  }

  @Override
  public void onDisable() {
    if (active != null) {
      active.forbid("verifier_disabled", Instant.now());
      try {
        finishActive(active.runId());
      } catch (RuntimeException error) {
        getLogger().severe("Could not preserve disabled-run evidence: " + error.getMessage());
      }
    }
  }

  @Override
  public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
    if (!(sender instanceof ConsoleCommandSender)) {
      sender.sendMessage("The frozen verifier is controlled only by the trusted server console.");
      if (sender instanceof Player player && isScenarioPlayer(player)) {
        forbid("verifier_control_attempt");
      }
      return true;
    }
    if (args.length == 0) return usage(sender);
    try {
      return switch (args[0]) {
        case "reset" -> reset(sender);
        case "start" -> args.length == 2 ? start(sender, args[1]) : usage(sender);
        case "end" -> args.length == 2 ? end(sender, args[1]) : usage(sender);
        case "status" -> status(sender);
        default -> usage(sender);
      };
    } catch (Exception error) {
      sender.sendMessage("Verifier failed closed: " + error.getMessage());
      getLogger().warning("Verifier command failed: " + error);
      return true;
    }
  }

  private boolean reset(CommandSender sender) {
    if (active != null) throw new IllegalStateException("Cannot reset while a scenario is active");
    var player = requirePlayer();
    criteria.reset(requireWorld(), player);
    sender.sendMessage("Scenario reset state sha256=" + criteria.relevantStateSha256(requireWorld(), player));
    return true;
  }

  private boolean start(CommandSender sender, String runId) throws IOException {
    validateRunId(runId);
    Path existing = reportPath(runId);
    if (Files.isRegularFile(existing)) {
      sender.sendMessage("Scenario already ended; report=" + existing);
      return true;
    }
    if (active != null) {
      if (active.runId().equals(runId)) sender.sendMessage("Scenario already active: " + runId);
      else throw new IllegalStateException("Another scenario run is active");
      return true;
    }
    var world = requireWorld();
    var player = requirePlayer();
    criteria.reset(world, player);
    active = new ScenarioRun(runId, Instant.now(), criteria.relevantStateSha256(world, player), criteria.maxEvents());
    sender.sendMessage("Scenario started: " + runId);
    return true;
  }

  private boolean end(CommandSender sender, String runId) {
    validateRunId(runId);
    Path existing = reportPath(runId);
    if (active == null && Files.isRegularFile(existing)) {
      sender.sendMessage("Scenario already ended; report=" + existing);
      return true;
    }
    if (active == null || !active.runId().equals(runId)) throw new IllegalStateException("Run is not active");
    Path report = finishActive(runId);
    sender.sendMessage("Scenario ended; report=" + report);
    return true;
  }

  private boolean status(CommandSender sender) {
    sender.sendMessage(active == null ? "No active scenario" : "Active scenario: " + active.runId());
    return true;
  }

  private Path finishActive(String runId) {
    if (active == null || !active.runId().equals(runId)) throw new IllegalStateException("Run is not active");
    ScenarioRun run = active;
    run.finish(Instant.now());
    var world = requireWorld();
    var player = requirePlayer();
    var placed = run.placedTable();
    String actualBlock = placed == null ? Material.AIR.name() : world.getBlockAt(placed.x(), placed.y(), placed.z()).getType().name();
    boolean insideTarget = placed != null && criteria.target().contains(placed);
    var state = new ScenarioEvaluator.FinalState(
        player.getName(),
        !player.isDead() && player.getHealth() > 0,
        player.getHealth(),
        player.getGameMode().name(),
        run.collectedLogs(),
        run.craftedTable(),
        insideTarget,
        actualBlock,
        inventory(player),
        run.violations(),
        run.events().overflowed());
    var evaluation = evaluator.evaluate(criteria, run, state);
    try {
      Path report = evidenceWriter.write(runsRoot(), criteria, run, state, evaluation);
      active = null;
      return report;
    } catch (IOException error) {
      throw new IllegalStateException("Could not preserve verifier evidence", error);
    }
  }

  private Map<String, Integer> inventory(Player player) {
    var inventory = new LinkedHashMap<String, Integer>();
    for (ItemStack stack : player.getInventory().getContents()) {
      if (stack != null && stack.getType() != Material.AIR) inventory.merge(stack.getType().name(), stack.getAmount(), Integer::sum);
    }
    return Collections.unmodifiableMap(new LinkedHashMap<>(inventory));
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onBlockBreak(BlockBreakEvent event) {
    if (!isActivePlayer(event.getPlayer())) return;
    Material material = event.getBlock().getType();
    if (criteria.isAllowedLog(material)) active.collected(material, position(event.getBlock().getX(), event.getBlock().getY(), event.getBlock().getZ()), Instant.now());
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onCraft(CraftItemEvent event) {
    if (!(event.getWhoClicked() instanceof Player player) || !isActivePlayer(player)) return;
    if (event.getRecipe().getResult().getType() == Material.CRAFTING_TABLE) active.craftedTable(Instant.now());
  }

  @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
  public void onBlockPlace(BlockPlaceEvent event) {
    if (!isActivePlayer(event.getPlayer()) || event.getBlockPlaced().getType() != Material.CRAFTING_TABLE) return;
    var placed = position(event.getBlock().getX(), event.getBlock().getY(), event.getBlock().getZ());
    active.placedTable(placed, criteria.target().contains(placed), Instant.now());
  }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onCommand(PlayerCommandPreprocessEvent event) {
    if (!isActivePlayer(event.getPlayer())) return;
    event.setCancelled(true);
    forbid("forbidden_command");
  }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onTeleport(PlayerTeleportEvent event) {
    if (!isActivePlayer(event.getPlayer())) return;
    event.setCancelled(true);
    forbid("teleport");
  }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onGameMode(PlayerGameModeChangeEvent event) {
    if (!isActivePlayer(event.getPlayer()) || event.getNewGameMode() == GameMode.SURVIVAL) return;
    event.setCancelled(true);
    forbid("game_mode_change");
  }

  @EventHandler(priority = EventPriority.LOWEST)
  public void onCreativeInventory(InventoryCreativeEvent event) {
    if (!(event.getWhoClicked() instanceof Player player) || !isActivePlayer(player)) return;
    event.setCancelled(true);
    forbid("creative_inventory");
  }

  @EventHandler(priority = EventPriority.MONITOR)
  public void onDeath(PlayerDeathEvent event) {
    if (isActivePlayer(event.getEntity())) forbid("player_died");
  }

  private void forbid(String violation) {
    if (active != null) active.forbid(violation, Instant.now());
  }

  private boolean isScenarioPlayer(Player player) {
    return criteria != null && player.getName().equals(criteria.playerName());
  }

  private boolean isActivePlayer(Player player) {
    return active != null && isScenarioPlayer(player);
  }

  private Player requirePlayer() {
    Player player = Bukkit.getPlayerExact(criteria.playerName());
    if (player == null) throw new IllegalStateException("Scenario player is not online");
    return player;
  }

  private World requireWorld() {
    World world = Bukkit.getWorld(criteria.worldName());
    if (world == null) throw new IllegalStateException("Scenario world is not loaded");
    return world;
  }

  private Path runsRoot() {
    return getDataFolder().toPath().resolve("runs");
  }

  private Path reportPath(String runId) {
    return runsRoot().resolve(runId).resolve("report.json");
  }

  private static ScenarioCriteria.BlockPos position(int x, int y, int z) {
    return new ScenarioCriteria.BlockPos(x, y, z);
  }

  private static void validateRunId(String runId) {
    if (!runId.matches("[A-Za-z0-9._-]{1,64}")) throw new IllegalArgumentException("Unsafe run id");
  }

  private static boolean usage(CommandSender sender) {
    sender.sendMessage("Usage: mcscenario <reset|start|end|status> [run-id]");
    return true;
  }
}
