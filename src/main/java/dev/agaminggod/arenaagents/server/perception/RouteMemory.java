package dev.agaminggod.arenaagents.server.perception;

import com.google.gson.*;
import java.util.*;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;

/** Memories belong to the player's UUID across bodies and dimensions, cleared with the world. */
public final class RouteMemory {
 private static final Map<UUID, RouteMemory> PLAYERS = new HashMap<>();
 private final WalkedRoute route = new WalkedRoute();
 private final Map<String, LinkedHashMap<String, JsonObject>> resources = new HashMap<>();
 private WalkedRoute.Point death;
 private ServerPlayer body;
 private boolean wasAlive;
 private WalkedRoute.Point lastPortal;
 private WalkedRoute.Point lastPosition;
 private RouteMemory() {}
 public static RouteMemory of(ServerPlayer p) { return PLAYERS.computeIfAbsent(p.getUUID(), k -> new RouteMemory()); }
 public static void died(UUID id, dev.agaminggod.arenaagents.agent.AgentDeathSnapshot snapshot) {
  RouteMemory m=PLAYERS.computeIfAbsent(id,k->new RouteMemory());
  m.death=new WalkedRoute.Point(snapshot.dimensionId(),(int)Math.floor(snapshot.x()),(int)Math.floor(snapshot.y()),(int)Math.floor(snapshot.z()));
  m.route.disconnect();m.wasAlive=false;m.lastPosition=null;m.lastPortal=null;
 }
 public static void register() {
  net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(server -> {
   for (ServerPlayer p:server.getPlayerList().getPlayers()) of(p).observe(p);
  });
  net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPING.register(server -> PLAYERS.clear());
 }
 public static WalkedRoute.Point point(ServerPlayer p) {
  BlockPos b=p.blockPosition();int y=(int)Math.floor(p.getY()+0.5D);
  // At a bridge or portal lip the centre can hang over air while the body still stands on the neighbouring rim.
  // Match travel's footing anchor, so history never turns that overhanging centre into a standing waypoint.
  BlockPos under=new BlockPos(b.getX(),y-1,b.getZ());
  if(p.onGround() && p.level().getBlockState(under).getCollisionShape(p.level(),under).isEmpty()) {
   BlockPos support=p.getOnPos();
   if(!p.level().getBlockState(support).getCollisionShape(p.level(),support).isEmpty()) b=support;
  }
  return new WalkedRoute.Point(p.level().dimension().identifier().toString(),b.getX(),y,b.getZ());
 }
 private void observe(ServerPlayer p) {
  if (!p.isAlive()) {
   if(wasAlive) death=point(p);
   route.disconnect(); wasAlive=false; body=p; return;
  }
  if (body!=null && body!=p && !body.isAlive()) route.disconnect();
  body=p; wasAlive=true;
  // Contact is player knowledge, including an End portal just below the feet.
  boolean portal=false;
  for (int y=-1;y<=1;y++) {
   String id=BuiltInRegistries.BLOCK.getKey(p.level().getBlockState(p.blockPosition().offset(0,y,0)).getBlock()).toString();
   if(id.equals("minecraft:nether_portal")||id.equals("minecraft:end_portal")||id.equals("minecraft:end_gateway")) portal=true;
  }
  WalkedRoute.Point at=point(p);
  if(lastPosition!=null && !lastPosition.dimension().equals(at.dimension()) && lastPortal!=null && lastPosition.distance(lastPortal)<=5) route.step(lastPortal,true);
  if (p.onGround() || p.isInWater() || p.onClimbable() || lastPosition!=null && !lastPosition.dimension().equals(at.dimension())) route.step(at,portal);
  if(p.onClimbable()) route.mark(at,WalkedRoute.CLIMBABLE);
  lastPosition=at;
 }
 public WalkedRoute.Path path(ServerPlayer p, String dimension, double x,double y,double z) {
  return route.path(point(p),new WalkedRoute.Point(dimension,(int)Math.floor(x),(int)Math.floor(y),(int)Math.floor(z)));
 }
 public boolean climbable(WalkedRoute.Point at) { return route.climbable(at); }
 public void mark(ServerPlayer p,String hazard) {route.mark(point(p),hazard);}
 public void seen(ServerPlayer p, JsonArray blocks) {
  String dim=point(p).dimension();
  LinkedHashMap<String,JsonObject> seen=resources.computeIfAbsent(dim,k->new LinkedHashMap<>());
  for(JsonElement e:blocks) {
   JsonObject b=e.getAsJsonObject(); String id=b.get("blockId").getAsString();
   if(id.equals("minecraft:lava")) route.mark(point(p),"seen lava nearby");
   String kind=id.endsWith("_log")||id.endsWith("_stem")||id.endsWith("_wood")||id.endsWith("_hyphae")?"wood":id.endsWith("_planks")?"planks":id.equals("minecraft:crafting_table")?"crafting table":id.endsWith(":chest")||id.endsWith(":barrel")?"chest":null;
   if(id.equals("minecraft:nether_portal")||id.equals("minecraft:end_portal")||id.equals("minecraft:end_gateway")) {
    WalkedRoute.Point portalPoint=new WalkedRoute.Point(dim,b.get("x").getAsInt(),b.get("y").getAsInt(),b.get("z").getAsInt());
    if(lastPortal==null || !lastPortal.dimension().equals(dim) || point(p).distance(portalPoint)<point(p).distance(lastPortal)) lastPortal=portalPoint;
   }
   String key=b.get("x")+","+b.get("y")+","+b.get("z");
   if(kind==null) {seen.remove(key);continue;}
   JsonObject r=new JsonObject();for(String field:List.of("blockId","x","y","z")) r.add(field,b.get(field).deepCopy());r.addProperty("kind",kind);r.addProperty("dimension",dim);seen.put(key,r);
  }
 }
 public JsonObject facts(ServerPlayer p) {
  JsonObject out=new JsonObject();out.addProperty("walkedCells",route.size());
  if(death!=null) {
   JsonObject target=new JsonObject();target.addProperty("dimension",death.dimension());target.addProperty("x",death.x());target.addProperty("y",death.y());target.addProperty("z",death.z());out.add("death",target);
   WalkedRoute.Path path=path(p,death.dimension(),death.x(),death.y(),death.z());
   out.addProperty("connected",path!=null);
   if(path!=null) {
    out.addProperty("length",Math.round(path.length()));out.addProperty("waypoints",path.points().size());
    JsonArray hazards=new JsonArray();path.hazards().stream().sorted().forEach(hazards::add);out.add("hazards",hazards);
    JsonArray portals=new JsonArray();
    for(int i=1;i<path.points().size();i++) if(!path.points().get(i-1).dimension().equals(path.points().get(i).dimension())) {
     WalkedRoute.Point a=path.points().get(i-1);JsonObject v=new JsonObject();v.addProperty("dimension",a.dimension());v.addProperty("x",a.x());v.addProperty("y",a.y());v.addProperty("z",a.z());v.addProperty("to",path.points().get(i).dimension());portals.add(v);
    }
    out.add("portals",portals);
   }
  }
  JsonArray nearest=new JsonArray();
  for(String kind:List.of("wood","planks","crafting table","chest")) resources.getOrDefault(point(p).dimension(),new LinkedHashMap<>()).values().stream()
    .filter(r->r.get("kind").getAsString().equals(kind)).min(Comparator.comparingDouble(r->Math.pow(r.get("x").getAsDouble()-p.getX(),2)+Math.pow(r.get("y").getAsDouble()-p.getY(),2)+Math.pow(r.get("z").getAsDouble()-p.getZ(),2))).ifPresent(nearest::add);
  out.add("seenResources",nearest);return out;
 }
}
