# Construction and combat facts

Write programs live from current observations. This topic supplies mechanics, not executable routines; capabilities section program supplies API syntax.

## Bucket casting

Water flowing onto a lava source (level 0) makes obsidian; flowing lava makes cobblestone. Each obsidian block costs one lava source. A minimum portal has a 4x5 outer frame and a clear 2x3 interior; corners are optional, leaving 10 obsidian. Cast in place without diamonds; mining obsidian requires a diamond or netherite pickaxe.

A lava source turns to obsidian the instant water (source or flowing) touches it from a side or above, as it is poured or when water arrives; water only below does nothing. Unconverted lava spreads after about 1.5 seconds; until then an empty bucket scoops the source back. A nonflammable mould must contain the water and lava so water reaches each placed source. Check the mould after each failed placement before pouring; a missing wall can spill either fluid. Recover water from its source with an empty bucket. With one bucket, the cooling water stays placed while the bucket ferries lava; refilling from that water removes the coolant. A site beside the supply pool keeps each lava trip short. Flooding the supply pool turns its sources into obsidian that an iron pickaxe cannot collect. Temporary supports must leave the portal interior clear.

Once three frame obsidian are in view, the wake frame line and world.state().portalFrames[0] show the seen frame nearest completion: interior low corner x,y,z, axis, interior [width,height], missing [x,y,z,seen] frame cells (corners optional) and blocked interior cells. A cast cell reads obsidian only after it cools; unseen cells need a look. Fire lights the frame only when nothing is missing and the interior is clear.

## Placement and access

Placement coordinates name the destination, while face names the clicked support face. The destination must accept the block, an adjacent solid support must be visible and in reach, and the player's body must be clear. Seeing a block does not mean seeing its requested face. A top face needs eyes above its plane; higher work needs higher dry footing with clear headroom. Flowers, leaves and other occupied cells may need clearing first. A failure receipt describes a failed placement, not a completed wall.

## Pillars and bridges

Feet need support and the body needs clearance. A new support changes the seen route; check it before stepping out. Lava burns wooden supports. Sneaking reduces ordinary ledge walking risk but does not prove a gap traversable or keep a broken support beneath you.

## Blazes

Blazes fly and shoot fire; hard cover blocks projectiles. Water evaporates in the Nether. Melee needs a reachable target and supported feet; a bow needs arrows and a clear shot. A stopped combat action leaves the body idle. Current health, fire, threats and cover determine the next defense.
