package dev.agaminggod.arenaagents.control;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.UUID;

public final class LiveTaskViewVerification {
 private LiveTaskViewVerification() { }
 public static int verify() {
  String fixture="""
   {"goalRevision":1,"goal":"Get a pickaxe","active":true,"verified":false,"revision":2,"generatedAt":1000,
    "plan":{"steps":[{"id":"tool","label":"Carry an iron pickaxe","kind":"inventory","status":"lost","dependsOn":[],"detail":"Recover or replace it","evidence":null}]},
    "lastObserved":{},"events":[{"stage":"tool","message":"minecraft.observe","sequence":1,"at":1000}],"usage":null,"allowance":null}
   """;
  var root=LiveTaskViewData.parse(fixture);if(!root.get("active").getAsBoolean())throw new AssertionError("Active view lost");
  new LiveTaskViewPayload.Snapshot(UUID.randomUUID(),false,"Offline",fixture);
  int assertions=2;
  for(String field:new String[]{"goalRevision","generatedAt"}){var bad=root.deepCopy();bad.addProperty(field,-1);reject(bad.toString());assertions++;}
  var cycle=root.deepCopy();var step=cycle.getAsJsonObject("plan").getAsJsonArray("steps").get(0).getAsJsonObject();var deps=new JsonArray();deps.add("tool");step.add("dependsOn",deps);reject(cycle.toString());assertions++;
  var unknown=root.deepCopy();var udeps=new JsonArray();udeps.add("missing");unknown.getAsJsonObject("plan").getAsJsonArray("steps").get(0).getAsJsonObject().add("dependsOn",udeps);reject(unknown.toString());assertions++;
  var usage=root.deepCopy();var tokens=new JsonObject();tokens.addProperty("totalTokens",-1);usage.add("usage",tokens);reject(usage.toString());assertions++;
  reject("x".repeat(LiveTaskViewPayload.MAX_BYTES+1));assertions++;
  try {new LiveTaskViewPayload.Snapshot(UUID.randomUUID(),true,"Online","界".repeat(LiveTaskViewPayload.MAX_BYTES/3+1));throw new AssertionError("Oversized UTF-8 accepted");}catch(IllegalArgumentException expected){assertions++;}
  if(LiveTaskViewData.parse("{}").size()!=0)throw new AssertionError("Loading state rejected");assertions++;
  // 100 emoji are 100 code points (the coordinator's limit) but 200 UTF-16 units: the snapshot must still load.
  var emoji=root.deepCopy();emoji.getAsJsonObject("plan").getAsJsonArray("steps").get(0).getAsJsonObject().addProperty("label","\uD83E\uDDF1".repeat(100));
  LiveTaskViewData.parse(emoji.toString());assertions++;
  var tooLong=root.deepCopy();tooLong.getAsJsonObject("plan").getAsJsonArray("steps").get(0).getAsJsonObject().addProperty("label","\uD83E\uDDF1".repeat(101));
  reject(tooLong.toString());assertions++;
  // Rates, percentages and dollars are decimals; the usage roster carries every agent plus account rows.
  var decimals=root.deepCopy();var rates=new JsonObject();rates.addProperty("inputTokensPerMinute",1234.5);decimals.add("usage",rates);
  decimals.add("roster",com.google.gson.JsonParser.parseString("""
   {"generatedAt":1000,"agents":[{"agentId":"sol-1","provider":"codex","model":"gpt-6.1-sol","effort":"low","tier":"default","calls":184,"busyPercent":61.4,
    "tokens":{"input":9100000,"cached":7800000,"uncached":1300000,"cacheWrite":0,"output":92000,"reasoning":41000},"costUsd":11.402531,"listCostUsd":null,
    "perMinute":{"calls":3.2,"costUsd":0.19},"perHour":{"calls":192,"costUsd":11.2},"last":null,"goal":{"revision":2,"calls":4}}],
    "accounts":[{"provider":"codex","label":"Codex","account":"agam...","plan":"pro","limitKind":"plan_percent","warning":"yellow",
    "windows":[{"id":"primary","usedPercent":84.5,"perHour":0.4,"hoursToLimit":38.75,"resetsFirst":false}],"credits":{"remaining":4288.05,"perHour":285.1,"hoursToLimit":15.04},
    "requests":{"perMinute":4.6,"perHour":250,"rateLimited":{"total":0,"lastHour":0,"lastAt":null}},"agents":["sol-1"]}]}
   """));
  var parsed=LiveTaskViewData.parse(decimals.toString());assertions++;
  if(parsed.getAsJsonObject("roster").getAsJsonArray("accounts").get(0).getAsJsonObject().getAsJsonObject("credits").get("remaining").getAsDouble()!=4288.05)throw new AssertionError("Credits decimal lost");assertions++;
  var negative=decimals.deepCopy();negative.getAsJsonObject("roster").getAsJsonArray("agents").get(0).getAsJsonObject().addProperty("costUsd",-0.5);reject(negative.toString());assertions++;
  var badWarning=decimals.deepCopy();badWarning.getAsJsonObject("roster").getAsJsonArray("accounts").get(0).getAsJsonObject().addProperty("warning","purple");reject(badWarning.toString());assertions++;
  var huge=decimals.deepCopy();var big=new JsonObject();big.addProperty("x",new java.math.BigDecimal("9007199254740993"));huge.add("usage",big);reject(huge.toString());assertions++;
  return assertions;
 }
 private static void reject(String json){try{LiveTaskViewData.parse(json);throw new AssertionError("Malformed task view accepted");}catch(RuntimeException expected){}}
}
