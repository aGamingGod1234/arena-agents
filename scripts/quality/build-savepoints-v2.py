#!/usr/bin/env python3
"""Rebuild versioned d38 fixtures from immutable originals and a model-free surface survey.
Usage: build-savepoints-v2.py ORIGINAL_DIR SURVEY_JSON OUTPUT_DIR
Terrain/structure truth stays in the evaluator's sidecars, never in a model goal.
"""
import copy, hashlib, json, math, pathlib, re, sys
src, survey_file, out = map(pathlib.Path, sys.argv[1:])
survey = json.loads(survey_file.read_text()); out.mkdir(parents=True, exist_ok=True)
OW, NE, END = ('minecraft:'+x for x in ['overworld','the_nether','the_end'])
def xyz(text):
    return list(map(float,re.search(r'\[\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?,\s*(-?[\d.]+)d?\]',text).groups()))
def height(seed,x,z):
    return round(xyz(survey[seed]['heights'][f'{x},{z}'])[1])
def command(dim,text): return f'execute in {dim} run {text}'
def fill(dim,a,b,block): return command(dim,f'fill {a[0]} {a[1]} {a[2]} {b[0]} {b[1]} {b[2]} minecraft:{block}')
def setblock(dim,p,block): return command(dim,f'setblock {p[0]} {p[1]} {p[2]} minecraft:{block}')
def portal(dim,x,y,z):
    return [fill(dim,[x-1,y-1,z],[x+2,y+3,z],'obsidian'),fill(dim,[x,y,z],[x+1,y+2,z],'nether_portal[axis=x]')]
def kit(nether=False,end=False,eyes=0,gold=0):
    items=[('iron_pickaxe',1),('iron_sword',1),('shield',1),('water_bucket',1),('flint_and_steel',1),('cooked_beef',32),('cobblestone',64),('cobblestone',64),('oak_planks',32),('oak_log',8),('crafting_table',1),('stone_axe',1),('torch',32)]
    if end: items += [('bow',1),('arrow',64),('ender_pearl',2)]
    if eyes: items += [('ender_eye',eyes)]
    if gold: items += [('gold_ingot',gold)]
    return [{'item':'minecraft:'+item,'count':count} for item,count in items]
def camp(bed,top,nether=False,end=False,clear_exit=False):
    x,y,z=bed; c=[fill(OW,[x-3,y-1,z-3],[x+5,y+3,z+3],'cobblestone'),fill(OW,[x-2,y,z-2],[x+4,y+2,z+2],'air')]
    # A normal closed wooden door keeps the small camp safe, and remains usable by the player.
    c += [setblock(OW,[x-3,y,z],'oak_door[facing=west,half=lower]'),setblock(OW,[x-3,y+1,z],'oak_door[facing=west,half=upper]')]
    c += [setblock(OW,bed,'red_bed[facing=east,part=foot]'),setblock(OW,[x+1,y,z],'red_bed[facing=east,part=head]'),setblock(OW,[x-1,y,z+1],'chest[facing=north]'),setblock(OW,[x+2,y,z-1],'crafting_table'),setblock(OW,[x-1,y,z-1],'torch'),setblock(OW,[x+3,y,z-1],'torch')]
    spare=[('stone_pickaxe',1),('stone_axe',1),('cooked_beef',16),('cobblestone',64),('oak_log',8),('shield',1)]
    if nether: spare += [('golden_helmet',1),('flint_and_steel',1)]
    if end: spare += [('water_bucket',1),('cobblestone',64),('bow',1),('arrow',32)]
    for slot,(item,count) in enumerate(spare): c.append(command(OW,f'item replace block {x-1} {y} {z+1} container.{slot} with minecraft:{item} {count}'))
    route=None
    if top>y:
        top=max(top,y+4)
        sx,sz=x+4,z+1
        c += [fill(OW,[sx-1,y,sz-1],[sx+1,top-1,sz+1],'cobblestone'),fill(OW,[sx,y,sz],[sx,top,sz],'air'),fill(OW,[sx,y,sz],[sx,top-1,sz],'ladder[facing=west]')]
        # The shaft's entrance and its ladder are directly visible from the bed.
        c += [fill(OW,[x+2,y,sz],[sx-1,y+1,sz],'air')]
        if clear_exit:c += [fill(OW,[sx-1,top,sz-1],[sx+1,top+1,sz+1],'air')]
        route={'dimension':OW,'kind':'ladder','bottom':[sx,y,sz],'top':[sx,top,sz],'support':[sx+1,sz]}
    return c,route,spare

def nether_shelter(x,y,z):
    c=[fill(NE,[x-3,y-1,z-4],[x+4,y+3,z+2],'cobblestone'),fill(NE,[x-2,y,z-3],[x+3,y+2,z+1],'air')]
    c += [setblock(NE,[x-3,y,z-2],'oak_door[facing=west,half=lower]'),setblock(NE,[x-3,y+1,z-2],'oak_door[facing=west,half=upper]'),setblock(NE,[x-1,y,z-2],'torch')]
    return c+portal(NE,x,y,z)

def end_room():
    c=[fill(OW,[319,-31,2544],[341,-25,2564],'obsidian replace minecraft:lava'),fill(OW,[319,-30,2544],[341,-24,2564],'stone_bricks replace minecraft:spawner'),command(OW,'kill @e[type=minecraft:silverfish,x=319,y=-31,z=2544,dx=22,dy=8,dz=20]')]
    for x,z in [(331,2551),(332,2551),(333,2551),(330,2552),(330,2553),(330,2554),(334,2552),(334,2553),(334,2554),(331,2555),(332,2555),(333,2555)]:
        if (x,z)==(330,2554): continue  # The natural frame on this seed already has its eye.
        face='south' if z==2551 else 'north' if z==2555 else 'east' if x==330 else 'west'
        c.append(setblock(OW,[x,-26,z],f'end_portal_frame[facing={face},eye=true]'))
    c += [fill(OW,[331,-26,2552],[333,-26,2554],'end_portal')]
    for x,z in [(322,2548),(338,2548),(322,2558),(338,2558)]: c += [setblock(OW,[x,-28,z],'torch')]
    return c
manifest=[]
for p in sorted(src.glob('*.json')):
    if p.stem.endswith('-v2'): continue
    d=json.loads(p.read_text()); seed=d['seed'];
    if p.stem=='5-stronghold' and '5-surface' not in survey.get(seed,{}): continue
    name=p.stem; dim=d['setup']['dimension']; is_ne=dim==NE; is_end=dim==END; end_stage=name.startswith('6-')
    if name.startswith('1'): bed=[13,66,107];top=height(seed,17,108);pos=[13.5,66,108.5]
    elif name.startswith('2b'):bed=[85,-53,63];top=height(seed,89,64);ne=[26,32,11]
    elif name.startswith('2-'):bed=[114,64,687];top=height(seed,118,688);ne=[16,62,89]
    elif name.startswith('3-'):bed=[544,64,500];top=height(seed,548,501);ne=[68,59,63]
    elif name.startswith(('4-','5-')):
        basepos=xyz(survey[seed][name]['pos']);bed=[math.floor(basepos[0]),round(basepos[1]),math.floor(basepos[2])];top=bed[1];pos=[bed[0]+.5,bed[1],bed[2]+1.5]
    elif end_stage:bed=[323,-28,2553];top=height(seed,327,2554);pos=[325.5,-28,2551.5]
    elif name.startswith('7-'):bed=[70,82,142];top=height(seed,74,143);ne=[15,110,8]
    elif name.startswith('8-'):bed=[-5,-53,97];top=height(seed,-1,98);pos=[-6.5,-53,97.5]
    else:bed=[-18,-54,94];top=height(seed,-14,95);ne=[9,37,27]
    c,route,spare=camp(bed,top,is_ne,end_stage)
    if is_ne:
        if name.startswith('2b'):
            # The original sampled pair lies at the linking limit. A short protected passage
            # moves the Overworld portal far enough east for either Nether portal column.
            c += [fill(OW,[89,bed[1]-1,59],[103,bed[1]+3,63],'cobblestone'),fill(OW,[89,bed[1],60],[102,bed[1]+2,62],'air'),setblock(OW,[94,bed[1],60],'torch')]
            ow_portal=[100,bed[1],61]
        elif name.startswith('9-'):
            ow_portal=[bed[0]+1,bed[1],bed[2]+2]
        else:
            ow_portal=[bed[0]-1,bed[1],bed[2]-2]
        c += portal(OW,*ow_portal)+nether_shelter(*ne);pos=[ne[0]+.5,ne[1],ne[2]-2.5]
    if end_stage:
        c += end_room()
        # Open the camp toward the cleared portal room, without exposing the bed to the old lava.
        c += [fill(OW,[328,-28,2551],[328,-25,2552],'air'),fill(OW,[329,-29,2552],[329,-28,2552],'cobblestone'),fill(OW,[328,-28,2552],[328,-28,2552],'stone_brick_stairs[facing=east]'),fill(OW,[329,-27,2552],[329,-27,2552],'stone_brick_stairs[facing=east]')]
    if is_end:
        c += [fill(END,[98,48,-2],[102,48,2],'obsidian'),fill(END,[98,49,-2],[102,52,2],'air'),fill(END,[48,48,0],[97,48,0],'end_stone'),fill(END,[48,49,0],[97,50,0],'air'),fill(END,[54,49,-1],[97,49,-1],'end_stone'),fill(END,[54,49,1],[97,49,1],'end_stone'),fill(END,[48,49,-1],[53,50,1],'air'),fill(END,[48,48,-1],[53,48,1],'end_stone'),fill(END,[47,49,0],[47,59,0],'end_stone'),fill(END,[48,49,0],[48,61,0],'air'),fill(END,[48,49,0],[48,59,0],'ladder[facing=east]')];pos=[50.5,49,.5]
    if name.startswith('8-'):
        # Protect the camp edge, retaining the natural casting pool to the west.
        c += [fill(OW,[-8,-54,95],[-7,-54,99],'cobblestone'),fill(OW,[-8,-53,97],[-7,-52,97],'air'),setblock(OW,[-8,-53,97],'oak_door[facing=west,half=lower]'),setblock(OW,[-8,-52,97],'oak_door[facing=west,half=upper]')]
    # 5 starts inside the stronghold: the original natural-ground search result is retained.
    if name=='5-stronghold':
        # Its shaft reaches the real surface height recorded during the survey.
        top=survey[seed]['5-surface'];c,route,spare=camp(bed,top,is_ne,end_stage)
    eyes=16 if name.startswith('4-') else 12 if name.startswith('5-') else 0
    gold=10 if 'gold10' in name else 2 if is_ne else 0
    setup={'dimension':dim,'position':pos,'generality':True,'freezeUntilGoalStart':True,'time':1000,'weather':'clear','commands':c,'inventory':kit(is_ne,end_stage,eyes,gold),'armour':{'head':'minecraft:golden_helmet' if is_ne else 'minecraft:iron_helmet','chest':'minecraft:iron_chestplate','legs':'minecraft:iron_leggings','feet':'minecraft:iron_boots'},'effects':[],'mobs':[],'loadChunks':[{'dimension':OW,'position':bed}], 'usedBedSpawn':{'dimension':OW,'position':bed}}
    if is_end:setup['loadChunks'].append({'dimension':END,'position':[0,80,0]})
    if route:setup['loadChunks'].append({'dimension':OW,'position':route['top']})
    if is_end:setup['settleTicks']=100
    d.update({'variantOf':p.name,'fixtureVersion':2,'setup':setup,'bedSpawn':{'dimension':OW,'position':bed},'recoveryRoute':route,'spareKit':spare,'source':d.get('source'),'notes':['Version 2: reconstructed player preparation on the original seed; original file retained unchanged.','The bed is used through vanilla interaction. Breaking or moving it invalidates this respawn.','A lit recovery camp contains a spare kit and crafting table.'+(' A ladder visible from the bed reaches the surface.' if route else ' The camp opens onto the surface.'),'Only visible world blocks supply route information; no hidden terrain memory or structure coordinates are injected.']})
    if name.startswith('8-'):
        d['setup']['inventory'].append({'item':'minecraft:bucket','count':2})
    if is_end:
        d['endRecovery']={'bridge':[48,97,48],'ladder':{'bottom':[48,49,0],'top':[48,60,0]},'shelter':[50.5,49,.5]}
        d['notes'].append('End start: a dug two-block-high shelter under the island, a guarded end-stone bridge back to the arrival platform, and a ladder to the surface. No boss or spawn rules change.')
    target=out/(name+'-v2.json');target.write_text(json.dumps(d,indent=2)+'\n');manifest.append({'file':target.name,'variantOf':p.name,'originalSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'route':route,'bed':bed})
# Four independent seed starts use a surface camp and the same legitimate entry kit.
base=json.loads((out/'9-nether-entry-sol-bed-gold-v2.json').read_text())
for seed in ['20261024','8675309','123456789','987654321']:
    if 'netherY' not in survey.get(seed,{}): continue
    d=copy.deepcopy(base);bed=survey[seed]['campBed'];top=bed[1];c,route,spare=camp(bed,top,True);ne=survey[seed]['netherPortal']
    c+=portal(OW,bed[0]-1,top,bed[2]-2)+nether_shelter(*ne)
    d.update(seed=seed,source='Independent seed; a player-prepared surface portal camp and a small Nether portal shelter.',variantOf='9-nether-entry-sol-bed-gold-v2.json',sampleIndex=None,minute=None,deathsBefore=0,bedSpawn={'dimension':OW,'position':bed},recoveryRoute=None,spareKit=spare)
    d['setup'].update(position=[ne[0]+.5,ne[1],ne[2]-2.5],commands=c,loadChunks=[{'dimension':OW,'position':bed}],usedBedSpawn=d['bedSpawn']);d['setup'].pop('settleTicks',None)
    d['notes'][0]='Version 2: independent seed with a surface portal camp; structure truth is evaluator-only.'
    d['notes'][2]='A lit surface camp contains a spare kit and crafting table beside the return portal.'
    d['netherExit']=survey[seed]['naturalExit']
    target=out/f'9-nether-entry-{seed}-v2.json';target.write_text(json.dumps(d,indent=2)+'\n');manifest.append({'file':target.name,'bed':bed,'route':None,'newSeed':True})
# Natural lava-pool starts on the same four independent seeds.
lava_sites=json.loads((out.parent/'lava-survey.json').read_text()) if (out.parent/'lava-survey.json').exists() else {}
for seed,site in lava_sites.items():
    d=json.loads((out/'8-lava-pool-bed-v2.json').read_text());bed=site['bed'];x,y,z=bed
    c,route,spare=camp(bed,site['shaftTop'],False,False,site.get('exitObstructed',False))
    px,py,pz=site['poolEdge']
    c += [fill(OW,[px+1,py,pz],[px+3,py,pz],'cobblestone'),fill(OW,[px+1,py+1,pz],[px+3,py+3,pz],'air'),setblock(OW,[x-3,y,z],'oak_door[facing=west,half=lower]'),setblock(OW,[x-3,y+1,z],'oak_door[facing=west,half=upper]')]
    d.update(seed=seed,source='Natural exposed cave lava pool, surveyed offline; player-built lit camp and surface shaft.',variantOf='8-lava-pool-bed-v2.json',sampleIndex=None,minute=None,deathsBefore=0,bedSpawn={'dimension':OW,'position':bed},recoveryRoute=route,spareKit=spare,lavaPool={'edge':site['poolEdge'],'minimumSources':10})
    d['setup'].update(position=[x+.5,y,z+1.5],commands=c,loadChunks=[{'dimension':OW,'position':bed}],usedBedSpawn=d['bedSpawn'])
    target=out/f'8-lava-pool-{seed}-v2.json';target.write_text(json.dumps(d,indent=2)+'\n');manifest.append({'file':target.name,'bed':bed,'route':route,'newSeed':True})
(out.parent/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Wrote {len(manifest)} versioned checkpoints to {out}')
