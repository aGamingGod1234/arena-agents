package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.RouteMemory;
import dev.agaminggod.arenaagents.server.perception.WalkedRoute;
import java.util.function.BiPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;

/** Follows remembered turns; each leg uses ordinary travel's current sight, lava brake, brink and construction. */
public final class ServerRetraceController implements ServerController {
 private final String dimension;
 private final double x,y,z,tolerance;
 private final long timeoutMs,startedAt;
 private final boolean build;
 private final String stop;
 private final Float health;
 private final BiPredicate<ServerPlayer,BlockPos> modify;
 private WalkedRoute.Path path;
 private int index,legEnd;
 private boolean lookedOut;
 private ServerController leg;
 private final java.util.function.IntFunction<ServerController> shaft;
 private ServerNavigationController portalLeg;
 private long portalSince;
 public ServerRetraceController(String dimension,double x,double y,double z,double tolerance,long timeoutMs,boolean build,String stop,Float health,BiPredicate<ServerPlayer,BlockPos> modify,java.util.function.IntFunction<ServerController> shaft,long startedAt) {
  this.dimension=dimension;this.x=x;this.y=y;this.z=z;this.tolerance=tolerance;this.timeoutMs=timeoutMs;this.build=build;this.stop=stop;this.health=health;this.modify=modify;this.shaft=shaft;this.startedAt=startedAt;
 }
 @Override public TickResult tick(ServerPlayer p,long nowEpochMs) {
  if(path==null) {
   path=RouteMemory.of(p).path(p,dimension,x,y,z);
   if(path==null) return TickResult.failed("NO_ROUTE","No walked route connects this position to the target; no straight-line replacement attempted",0);
  }
  if(nowEpochMs - startedAt >= timeoutMs) { cancel(p);return TickResult.timedOut("TRAVEL_TIMEOUT","Retrace deadline reached; completed "+index+"/"+path.points().size()+" waypoints",progress()); }
  while(index<path.points().size()) {
   WalkedRoute.Point next=path.points().get(index);
   if(!next.dimension().equals(RouteMemory.point(p).dimension()) || index+1<path.points().size() && !next.dimension().equals(path.points().get(index+1).dimension())) {
    if (leg!=null) {leg.cancel(p);leg=null;}
    WalkedRoute.Point source=next.dimension().equals(RouteMemory.point(p).dimension()) ? next : path.points().get(index-1);
    if(portalLeg==null) {
     portalSince=nowEpochMs;
     portalLeg=new ServerNavigationController(new net.minecraft.world.phys.Vec3(source.x()+0.5,source.y(),source.z()+0.5),0.2,false,nowEpochMs,Math.min(20_000,timeoutMs-(nowEpochMs-startedAt)));
    }
    TickResult crossing=portalLeg.tick(p,nowEpochMs);
    if(crossing.state()==State.RUNNING) return TickResult.running(progress());
    if(crossing.state()!=State.SUCCEEDED) return new TickResult(crossing.state(),crossing.reasonCode(),"Retrace portal: "+crossing.message(),progress());
    // Nether portals take four seconds of contact; hold still after navigation releases its inputs.
    portalLeg.cancel(p);
    if(nowEpochMs-portalSince>15_000) return TickResult.failed("NO_ROUTE","Remembered portal reached but no crossing occurred; inspect the current portal",progress());
    return TickResult.running(progress());
   }
   WalkedRoute.Point following=index+1<path.points().size()?path.points().get(index+1):null;
   boolean verticalNext=following!=null && next.dimension().equals(following.dimension()) && next.x()==following.x() && next.z()==following.z() && next.y()!=following.y();
   double arrival=verticalNext && !p.onClimbable()?0.3:1.15;
   double d=Math.sqrt(Math.pow(p.getX()-(next.x()+0.5),2)+Math.pow(p.getY()-next.y(),2)+Math.pow(p.getZ()-(next.z()+0.5),2));
   if((leg==null || legEnd==index) && d<=arrival && Math.abs(p.getY()-next.y())<=0.6) { if(leg!=null) leg.cancel(p);leg=null;lookedOut=false;index++;continue; }
   if(leg==null) {
    if(!lookedOut) legEnd=index;
    WalkedRoute.Point feet=RouteMemory.point(p);
    boolean rememberedClimb=RouteMemory.of(p).climbable(next);
    if(!lookedOut && rememberedClimb && (verticalNext || next.y()!=feet.y())) {
     while(legEnd+1<path.points().size()) {
      WalkedRoute.Point rung=path.points().get(legEnd+1);
      if(!rung.dimension().equals(next.dimension()) || rung.x()!=next.x() || rung.z()!=next.z()) break;
      legEnd++;
     }
     // Ordinary navigation ends on support, so continue through the rungs to the remembered landing.
     if(legEnd+1<path.points().size() && path.points().get(legEnd+1).dimension().equals(next.dimension()) && Math.abs(path.points().get(legEnd+1).y()-path.points().get(legEnd).y())<=1) legEnd++;
    }
    WalkedRoute.Point target=path.points().get(legEnd);
    double horizontal=Math.hypot(target.x()+0.5-p.getX(),target.z()+0.5-p.getZ());
    boolean alignVertical=verticalNext && Math.abs(p.getY()-target.y())<=0.6;
    boolean navigate=lookedOut || rememberedClimb || p.onClimbable() || alignVertical;
    // First see the remembered ladder from adjacent ground; the navigation goal is its supported landing.
    if(rememberedClimb && !p.onClimbable() && !lookedOut) {
     if(!ServerLookController.turnToward(p,new net.minecraft.world.phys.Vec3(next.x()+0.5,p.getY()+1.0,next.z()+0.5))) return TickResult.running(progress());
    } else if(navigate && horizontal>0.4 && Math.abs(p.getY()-target.y())<=2 && !ServerLookController.turnToward(p,new net.minecraft.world.phys.Vec3(target.x()+0.5,target.y()+1.0,target.z()+0.5))) return TickResult.running(progress());
    boolean down=target.y()<p.getY()-0.6 && horizontal<0.8;
    leg=navigate ? new ServerNavigationController(new net.minecraft.world.phys.Vec3(target.x()+0.5,target.y(),target.z()+0.5),verticalNext?0.2:0.3,false,nowEpochMs,timeoutMs-(nowEpochMs-startedAt)) : down && build ? shaft.apply(target.y()) : new ServerTravelController(target.x()+0.5,target.y(),target.z()+0.5,1,timeoutMs-(nowEpochMs-startedAt),build,stop,health,modify,nowEpochMs).routeLeg();
   }
   TickResult result=leg.tick(p,nowEpochMs);
   if(result.state()==State.RUNNING) return TickResult.running(progress());
   leg.cancel(p);leg=null;
   WalkedRoute.Point completed=path.points().get(legEnd);
   if(result.reasonCode().equals("REACHED_FRONTIER") && legEnd>index && !lookedOut && Math.abs(p.getY()-completed.y())<=2) {lookedOut=true;return TickResult.running(progress());}
   if(result.state()!=State.SUCCEEDED) return new TickResult(result.state(),result.reasonCode(),"Retrace "+index+"/"+path.points().size()+" toward "+completed+": "+result.message(),progress());
   if(!result.reasonCode().equals("ARRIVED") && !result.reasonCode().equals("DESTINATION_REACHED")) return result;
   if(legEnd==index && d>1.75 && Math.abs(p.getY()-next.y())>1.2) return TickResult.failed("NO_ROUTE","Remembered vertical step needs rebuilding; waypoint "+next,progress());
   index=legEnd+1;lookedOut=false;
  }
  // A death can be between sampled footsteps. Finish the short last leg with normal travel's arrival band.
  if(Math.hypot(p.getX()-x,p.getZ()-z)>tolerance || Math.abs(p.getY()-y)>Math.max(3,tolerance)) {
   if(leg==null) leg=new ServerTravelController(x,y,z,tolerance,timeoutMs-(nowEpochMs-startedAt),build,stop,health,modify,nowEpochMs);
   TickResult result=leg.tick(p,nowEpochMs);
   if(result.state()==State.RUNNING) return TickResult.running(progress());
   leg.cancel(p);leg=null;
   if(result.state()!=State.SUCCEEDED || !result.reasonCode().equals("ARRIVED")) return result;
  }
  return TickResult.succeeded("ARRIVED","Retraced "+Math.round(path.length())+" blocks along "+path.points().size()+" remembered waypoints; target "+x+","+y+","+z);
 }
 private double progress() {return path==null?0:Math.min(0.99,(double)index/Math.max(1,path.points().size()));}
 @Override public void cancel(ServerPlayer p) {if(leg!=null) leg.cancel(p);if(portalLeg!=null) portalLeg.cancel(p);}
}
