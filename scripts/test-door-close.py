#!/usr/bin/env python3
"""Execute production door navigation methods against a small, deterministic fake world.

No Minecraft server is started. Methods are extracted unchanged except for qualified
type names, so this checks the controller's real click/tracking/closure control flow.
Run from any directory with Python 3 and a JDK on PATH.
"""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CONTROLLER = ROOT / "src/main/java/dev/agaminggod/arenaagents/server/runtime/controller/ServerNavigationController.java"
BUILDER = CONTROLLER.with_name("TravelBuilder.java")


def method(source, signature):
    start = source.index(signature)
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


source = CONTROLLER.read_text()
methods = "\n".join(method(source, signature) for signature in (
    "private boolean doorAhead(", "private boolean closeDoorBehind(",
    "private static boolean door(", "private boolean clickDoor("))
for prefix in ("dev.agaminggod.arenaagents.server.runtime.input.",
               "dev.agaminggod.arenaagents.server.runtime.",
               "net.minecraft.world.phys.shapes.", "net.minecraft.world.level.block."):
    methods = methods.replace(prefix, "")
click = method(BUILDER.read_text(), "static boolean click(")

fixture = r"""
import java.util.*;
public class DoorCloseRegression {
  record BlockPos(int x, int y, int z) {
    BlockPos above() { return new BlockPos(x,y+1,z); }
    BlockPos below() { return new BlockPos(x,y-1,z); }
    BlockPos relative(int direction) { return new BlockPos(x+direction,y,z); }
    int getX() { return x; } int getY() { return y; } int getZ() { return z; }
  }
  record GridPosition(int x, int y, int z) {}
  record PathNode(GridPosition position) {}
  record Vec3(double x, double y, double z) {
    static Vec3 atCenterOf(BlockPos p) { return new Vec3(p.x+.5,p.y+.5,p.z+.5); }
    double distanceTo(Vec3 p) { return Math.sqrt(Math.pow(x-p.x,2)+Math.pow(y-p.y,2)+Math.pow(z-p.z,2)); }
  }
  static class AABB {
    AABB(BlockPos p) {} AABB minmax(AABB b) { return this; }
    AABB inflate(double d) { return this; } boolean intersects(AABB b) { return false; }
  }
  static class DoorBlock { DoorBlock type() { return this; } boolean canOpenByHand() { return true; } }
  static class FenceGateBlock {}
  static class BlockStateProperties { static final String OPEN = "open"; }
  record BlockState(Object getBlock, boolean open, int other) {
    boolean hasProperty(String p) { return getBlock instanceof DoorBlock || getBlock instanceof FenceGateBlock; }
    boolean getValue(String p) { return open; }
  }
  static class BuiltInRegistries {
    static final BuiltInRegistries BLOCK = new BuiltInRegistries();
    String getKey(Object b) { return "door"; }
  }
  record BlockHitResult(BlockPos getBlockPos, int getDirection) {}
  static class ItemStack {}
  enum InteractionHand { MAIN_HAND }
  record InteractionResult(boolean consumesAction) {}
  static class ServerLevel {
    final Map<BlockPos,BlockState> states = new HashMap<>();
    boolean allowed = true;
    BlockState getBlockState(BlockPos p) { return states.getOrDefault(p,new BlockState("air",false,0)); }
    boolean mayInteract(ServerPlayer p, BlockPos pos) { return allowed; }
  }
  static class GameMode {
    boolean toggle = true, changeAdjacent, replace;
    int clicks;
    InteractionResult useItemOn(ServerPlayer p, ServerLevel l, ItemStack stack, InteractionHand hand, BlockHitResult hit) {
      clicks++;
      BlockState before = l.getBlockState(hit.getBlockPos());
      l.states.put(hit.getBlockPos(), replace ? new BlockState("air",false,0)
          : new BlockState(before.getBlock(), toggle ? !before.open() : before.open(), before.other()+1));
      if (changeAdjacent) l.states.put(hit.getBlockPos().relative(1),new BlockState("stone",false,0));
      return new InteractionResult(true);
    }
  }
  static class ServerPlayer {
    final ServerLevel world = new ServerLevel(); final GameMode gameMode = new GameMode();
    BlockHitResult hit; Vec3 eye = new Vec3(.5,65.5,.5);
    ServerLevel level() { return world; } ItemStack getMainHandItem() { return new ItemStack(); }
    Vec3 getEyePosition() { return eye; } double blockInteractionRange() { return 4.5; }
    float getYRot() { return 0; } float getXRot() { return 0; }
    ServerPlayer getInventory() { return this; } int getSelectedSlot() { return 0; }
    AABB getBoundingBox() { return new AABB(new BlockPos(0,64,0)); }
    boolean onGround() { return true; }
  }
  static class ArmSwing { static void use(ServerPlayer p, InteractionHand h) {} }
  static class MinecraftNavigationWorld {
    final ServerLevel level;
    MinecraftNavigationWorld(ServerLevel l) { level = l; }
    boolean planesThroughDoors() { return true; }
    BlockState stateAt(BlockPos p) { return level.getBlockState(p); }
    static boolean closedHandDoor(BlockState s) { return Controller.door(s) && !s.open(); }
  }
  static class TargetSightline {
    static Vec3 block(Object... args) { return null; }
  }
  static class CollisionContext { static Object of(ServerPlayer p) { return p; } }
  static class AgentInputState { AgentInputState(Object... args) {} }
  static class AgentInputRuntime {
    static InputController controller(ServerPlayer p) { return new InputController(); }
    static String requireAgentId(ServerPlayer p) { return "test"; }
  }
  enum InputOwner { NAVIGATION }
  static class InputController {
    Object acquire(Object... args) { return new Object(); } void apply(Object... args) {}
  }
  static class AgentInputStates {
    record MotorState(float yaw, float pitch) { static MotorState initial(float y,float p) { return new MotorState(y,p); } }
    record MotorTarget(float yaw,float pitch,boolean a,boolean b,boolean c) {}
    record Step(MotorState state) {}
    static Step stepMotor(MotorState s, MotorTarget t, long now) { return new Step(s); }
  }
  static class TravelBuilder {
    static BlockHitResult crosshair(ServerPlayer p) { return p.hit; }
    static float[] lookAt(Vec3 eye,Vec3 aim) { return new float[]{0,0}; }
    CLICK_METHOD
  }
  static class Controller {
    static final double DOOR_REACH = 3;
    static final int DOOR_TICKS = 30, DOOR_CLICK_GAP = 5;
    boolean crouched, lastSprint; int waypointIndex, doorTicks, doorClicks, doorCooldown;
    BlockPos doorAt, openedDoor; String doorFailure;
    Object inputLease; InputController inputController; AgentInputStates.MotorState motorState;
    CONTROLLER_METHODS
  }
  static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
  public static void main(String[] args) {
    int cases = 0;
    for (Object block : List.of(new DoorBlock(), new FenceGateBlock())) {
      // Hit either half: only the clicked block toggles in this fake, deliberately leaving adjacent air unchanged.
      for (int dy : block instanceof DoorBlock ? new int[]{0,1} : new int[]{0}) {
        ServerPlayer p = new ServerPlayer(); Controller c = new Controller();
        BlockPos base = new BlockPos(1,64,0), hit = dy == 0 ? base : base.above();
        p.world.states.put(base,new BlockState(block,false,0));
        p.world.states.put(hit,new BlockState(block,false,0));
        p.hit = new BlockHitResult(hit,1);
        var world = new MinecraftNavigationWorld(p.world);
        var nodes = List.of(new PathNode(new GridPosition(1,64,0)));
        check(c.doorAhead(p,world,nodes,0),"opening occupies navigation");
        check(p.world.getBlockState(hit).open(),"vanilla click opens the door");
        check(base.equals(c.openedDoor),"successful open must be recorded despite unchanged adjacent air");
        // Real doors update both halves. Mirror that here before moving the body through.
        p.world.states.put(base,new BlockState(block,true,0));
        p.eye = new Vec3(3.5,65.5,.5); c.doorCooldown = 0;
        check(c.doorAhead(p,world,List.of(),50),"closing occupies navigation");
        check(!p.world.getBlockState(hit).open(),"door closes after passage");
        check(c.openedDoor == null,"successful close clears tracking");
        check(p.gameMode.clicks == 2,"one opening and one closing click");
        cases++;
      }
      ServerPlayer p = new ServerPlayer(); Controller c = new Controller();
      BlockPos pos = new BlockPos(1,64,0); p.hit = new BlockHitResult(pos,1);
      p.world.states.put(pos,new BlockState(block,false,0)); p.gameMode.toggle = false;
      p.gameMode.changeAdjacent = true;

      check(c.doorAhead(p,new MinecraftNavigationWorld(p.world),
          List.of(new PathNode(new GridPosition(1,64,0))),0),"failed click still occupies navigation");
      check(c.openedDoor == null,"failed interaction does not claim ownership");
      check(p.gameMode.clicks == 1,"failed interaction actually attempted the click");
      c.doorCooldown = 0; p.gameMode.replace = true;
      check(!c.clickDoor(p,pos,50),"replacement of a door is not a successful toggle");
      cases++;
    }
    System.out.println("PASS: " + cases + " door/gate opening, tracking, closure and failed-click cases");
  }
}
""".replace("CLICK_METHOD", click).replace("CONTROLLER_METHODS", methods)

with tempfile.TemporaryDirectory(prefix="arena-f01-door-close-") as directory:
    java = Path(directory) / "DoorCloseRegression.java"
    java.write_text(fixture)
    subprocess.run(["javac", "-d", directory, str(java)], check=True)
    subprocess.run(["java", "-cp", directory, "DoorCloseRegression"], check=True)
