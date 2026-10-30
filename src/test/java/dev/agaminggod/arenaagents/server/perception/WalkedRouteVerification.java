package dev.agaminggod.arenaagents.server.perception;

public final class WalkedRouteVerification {
 public static int verify() {
  WalkedRoute r=new WalkedRoute();
  for(int x=0;x<=12;x++) r.step(p("ow",x,64,0),false);
  for(int z=1;z<=12;z++) r.step(p("ow",12,64,z),false);
  r.mark(p("ow",12,64,6),"seen lava nearby");
  r.disconnect();
  WalkedRoute.Path path=r.path(p("ow",0,64,0),p("ow",12,64,12));
  check(path!=null && path.length()==24,"death retains the long route");
  check(path.points().contains(p("ow",12,64,0)),"compaction keeps the corner instead of cutting a wall");
  check(path.hazards().contains("seen lava nearby"),"route hazards survive compaction");
  check(path.points().size()<25,"straight footsteps compact into waypoints");
  r.step(p("ow",100,64,100),false);
  check(r.path(p("ow",100,64,100),p("ow",12,64,12))==null,"respawn never creates a teleport edge");
  WalkedRoute n=new WalkedRoute();
  n.step(p("ow",0,64,0),false);n.step(p("ow",1,64,0),true);
  n.step(p("nether",10,64,0),false);n.step(p("nether",11,64,0),false);n.disconnect();
  check(n.path(p("ow",0,64,0),p("nether",11,64,0)).length()==2,"portal crossing preserves both walked legs");
  check(n.path(p("nether",11,64,0),p("ow",0,64,0))!=null,"Nether return portal is usable both ways");
  WalkedRoute e=new WalkedRoute();e.step(p("ow",0,64,0),true);e.step(p("minecraft:the_end",100,49,0),false);
  check(e.path(p("minecraft:the_end",100,49,0),p("ow",0,64,0))==null,"End arrival is not a return portal");
  WalkedRoute t=new WalkedRoute();t.step(p("ow",0,64,0),false);t.step(p("nether",0,64,0),false);
  check(t.path(p("ow",0,64,0),p("nether",0,64,0))==null,"a dimension teleport without portal contact is disconnected");
  WalkedRoute ladder=new WalkedRoute();
  for(int y=64;y<=68;y++) ladder.step(p("ow",0,y,0),false);
  check(ladder.path(p("ow",1,64,0),p("ow",0,68,0)).points().getFirst().y()==64,"a nearby vertical route joins at the reachable floor, not an elevated rung");
  WalkedRoute shaft=new WalkedRoute();shaft.step(p("ow",0,64,0),false);shaft.step(p("ow",0,63,0),false);shaft.step(p("ow",0,62,0),false);
  check(shaft.path(p("ow",0,62,0),p("ow",0,64,0)).hazards().stream().anyMatch(h->h.startsWith("shaft:")),"unit shaft steps retain the tools and blocks needed in reverse");
  n.step(p("ow",1,64,0),true);n.step(p("nether",10,64,1),false);
  check(n.path(p("nether",10,64,1),p("nether",11,64,0)).points().stream().allMatch(point->point.dimension().equals("nether")),"a shifted portal exit joins the nearby walked route instead of crossing twice");
  return 12;
 }
 private static WalkedRoute.Point p(String d,int x,int y,int z) {return new WalkedRoute.Point(d,x,y,z);}
 private static void check(boolean condition,String message) {if(!condition) throw new AssertionError(message);}
}
