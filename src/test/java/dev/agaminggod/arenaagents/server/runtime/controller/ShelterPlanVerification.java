package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.HashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

public final class ShelterPlanVerification {
 public static int verify() {
  int checks = 0;
  BlockPos center = new BlockPos(83, 73, 91);
  for (Direction opening : new Direction[] {Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST}) {
   for (boolean roof : new boolean[] {false, true}) {
    var plan = ServerShelterController.plan(center, opening, roof);
    var positions = new HashSet<BlockPos>();
    for (var cell : plan) {
     if (!positions.add(cell.at())) throw new AssertionError("Duplicate shelter placement");
     if (cell.at().equals(center) || cell.at().equals(center.above())) throw new AssertionError("Shelter occupies body");
     checks += 2;
    }
    if (positions.contains(center.relative(opening).above())) throw new AssertionError("Fighting window was closed");
    if (!positions.contains(center.relative(opening))) throw new AssertionError("Sill must keep feet inside");
    if (positions.contains(center.above(2)) != roof) throw new AssertionError("Roof choice lost");
    for (int y=0;y<2;y++) for(int x=-1;x<=1;x++) for(int z=-1;z<=1;z++) {
     if (Math.abs(x)+Math.abs(z)!=1) continue;
     BlockPos at = center.offset(x,y,z);
     if (!at.equals(center.relative(opening).above()) && !positions.contains(at)) throw new AssertionError("Wall hole at " + at);
     checks++;
    }
    checks += 3;
   }
  }
  checks += verifySupport(center);
  return checks;
 }

 private static int verifySupport(BlockPos center) {
  int checks = 0;
  BlockPos wall = center.relative(Direction.EAST);
  // Flat ground: the wall cell already stands on a seen block, so nothing is added.
  if (!ServerShelterController.support(center, wall, p -> p.getY() < center.getY() ? ServerShelterController.Seen.SOLID : ServerShelterController.Seen.OPEN).isEmpty())
   throw new AssertionError("Supported wall got support cells");
  checks++;
  // Ground one lower beside the floor: one block below the wall cell.
  var one = ServerShelterController.support(center, wall, p -> p.getY() < center.getY() - 1 ? ServerShelterController.Seen.SOLID : ServerShelterController.Seen.OPEN);
  if (one.size() != 1 || !one.get(0).at().equals(wall.below()) || one.get(0).face() != Direction.UP) throw new AssertionError("Step support " + one);
  checks++;
  // Ground two lower: two blocks, lowest first, as a player pillars.
  var two = ServerShelterController.support(center, wall, p -> p.getY() < center.getY() - 2 ? ServerShelterController.Seen.SOLID : ServerShelterController.Seen.OPEN);
  if (two.size() != 2 || !two.get(0).at().equals(wall.below(2)) || !two.get(1).at().equals(wall.below())) throw new AssertionError("Two-step support " + two);
  checks++;
  // A drop deeper than two with a seen solid outer neighbour: place against its side face instead.
  BlockPos outer = wall.relative(Direction.EAST);
  var side = ServerShelterController.support(center, wall, p -> p.equals(outer) ? ServerShelterController.Seen.SOLID : ServerShelterController.Seen.OPEN);
  if (side.size() != 1 || !side.get(0).at().equals(wall) || side.get(0).face() != Direction.WEST) throw new AssertionError("Side support " + side);
  checks++;
  // The interior is never a support face, and unseen support is left to the ordinary placement.
  if (!ServerShelterController.support(center, wall, p -> p.equals(center) ? ServerShelterController.Seen.SOLID : ServerShelterController.Seen.OPEN).isEmpty())
   throw new AssertionError("Interior used as support");
  if (!ServerShelterController.support(center, wall, p -> ServerShelterController.Seen.UNKNOWN).isEmpty()) throw new AssertionError("Unseen support assumed");
  checks += 2;
  return checks;
 }
}
