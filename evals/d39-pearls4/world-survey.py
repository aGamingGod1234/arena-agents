"""Operator-only Anvil census. Collision/LOS approximations are reported, never sent to Sol."""
import sys, pathlib, json, collections, math, io, struct,zlib,gzip,zipfile
# Reuse the local, read-only NBT parser by file path; no third-party package.
lib=pathlib.Path(sys.argv[1]);ns={};exec(lib.read_text().split('want = ')[0],ns);chunks=ns['chunks'];nbt=ns['nbt']
root=pathlib.Path(sys.argv[2]);jar=zipfile.ZipFile(sys.argv[3]);templates={}
for name in jar.namelist():
 if name.startswith('data/minecraft/structure/bastion/') and name.endswith('.nbt'):
  d=nbt(io.BytesIO(gzip.decompress(jar.read(name))));pal=d['palette'];cnt=collections.Counter((b.get('nbt',{}).get('final_state','minecraft:air').split('[')[0] if pal[b['state']]['Name']=='minecraft:jigsaw' else pal[b['state']]['Name']) for b in d['blocks'])
  templates['minecraft:'+name[25:-4]]={'gold':cnt['minecraft:gold_block'],'chests':cnt['minecraft:chest']}
(root/'templates.json').write_text(json.dumps(templates,indent=2))
summary=[]
for d in sorted(root.iterdir()):
 if not (d/'survey.json').exists():continue
 meta=json.load(open(d/'survey.json'));p=tuple(map(math.floor,meta['portal'])); sections={};gold=[];ore=[];chests=[];starts={};fullChunks=set()
 for f in (d/'server/world/dimensions/minecraft/the_nether/region').glob('*.mca'):
  for c in chunks(str(f)):
   if c.get('Status') not in ('full','minecraft:full'):continue
   cx,cz=c['xPos'],c['zPos'];fullChunks.add((cx,cz))
   for name,start in c.get('structures',{}).get('starts',{}).items():
    if 'bastion' in name and start.get('Children'):starts[(start['ChunkX'],start['ChunkZ'])]=start
   for b in c.get('block_entities',[]):
    if b.get('id') in ('minecraft:chest','minecraft:barrel'):chests.append({'at':[b['x'],b['y'],b['z']],'lootTable':b.get('LootTable'),'items':b.get('Items')})
   for s in c.get('sections',[]):
    bs=s.get('block_states');
    if not bs:continue
    pal=[q['Name'] for q in bs['palette']];sy=s['Y'];codes=[]
    for name in pal:
     code=1 if name in ('minecraft:air','minecraft:cave_air','minecraft:void_air','minecraft:nether_portal','minecraft:torch','minecraft:wall_torch','minecraft:oak_door','minecraft:chain','minecraft:lantern','minecraft:soul_lantern') else 3 if name in ('minecraft:lava','minecraft:fire','minecraft:soul_fire','minecraft:magma_block') else 4 if name=='minecraft:gold_block' else 5 if name=='minecraft:nether_gold_ore' else 6 if name=='minecraft:chest' else 2
     if any(t in name for t in ('_stairs','_slab','_wall','_fence','blackstone_button','iron_bars')):code=7
     codes.append(code)
    arr=bytearray(4096);bits=max(4,(len(pal)-1).bit_length());per=64//bits;mask=(1<<bits)-1;data=bs.get('data')
    for i in range(4096):
     v=(data[i//per]>>((i%per)*bits))&mask if data else 0;code=codes[v];arr[i]=code
     if code in (4,5):
      at=(cx*16+(i&15),sy*16+(i>>8),cz*16+((i>>4)&15));(gold if code==4 else ore).append(at)
    sections[(cx,sy,cz)]=arr
 def at(x,y,z):
  arr=sections.get((x>>4,y>>4,z>>4));return arr[((y&15)<<8)|((z&15)<<4)|(x&15)] if arr else 0
 def stand(x,y,z):return at(x,y,z)==1 and at(x,y+1,z)==1 and at(x,y-1,z) in (2,4,5,6)
 start=p if stand(*p) else next(((p[0]+dx,p[1]+dy,p[2]+dz)for dx in range(-3,4)for dz in range(-3,4)for dy in range(-2,3)if stand(p[0]+dx,p[1]+dy,p[2]+dz)),None)
 distances={start:0} if start else {};q=collections.deque(distances)
 while q:
  x,y,z=q.popleft();dist=distances[x,y,z]
  for dx,dz in [(1,0),(-1,0),(0,1),(0,-1)]:
   nx,nz=x+dx,z+dz
   if abs(nx-p[0])>112 or abs(nz-p[2])>112:continue
   for dy in (0,1,-1,-2,-3):
    ny=y+dy;key=(nx,ny,nz)
    if not stand(*key):continue
    if dy==1 and at(x,y+2,z)!=1:continue
    if dy<0 and any(at(nx,yy,nz)!=1 for yy in range(ny+2,y+2)):continue
    if key not in distances:distances[key]=dist+1;q.append(key)
    break
 def los(eye,target):
  # Voxel sampled line to the near-visible centre. Conservative: other solids occlude.
  tx,ty,tz=target;ex,ey,ez=eye;dx,dy,dz=tx+.5-ex,ty+.5-ey,tz+.5-ez;n=max(1,math.ceil(math.sqrt(dx*dx+dy*dy+dz*dz)*8))
  for i in range(n):
   k=(math.floor(ex+dx*i/n),math.floor(ey+dy*i/n),math.floor(ez+dz*i/n))
   if k==target:return True
   if at(*k)!=1:return False
  return True
 def reachable(source):
  x,y,z=source;candidates=[]
  for dx in range(-4,5):
   for dz in range(-4,5):
    for dy in range(-5,4):
     pos=(x+dx,y+dy,z+dz)
     if pos not in distances:continue
     eye=(pos[0]+.5,pos[1]+1.62,pos[2]+.5)
     if math.dist(eye,(x+.5,y+.5,z+.5))<=4.5:candidates.append((distances[pos],pos,eye))
  for cost,pos,eye in sorted(candidates):
   if los(eye,source):return {'at':source,'walkSteps':cost,'stand':pos}
  return None
 routeore=[r for g in ore if abs(g[0]-p[0])<=116 and abs(g[2]-p[2])<=116 and (r:=reachable(g))]
 routegold=[r for g in gold if (r:=reachable(g))]
 bastions=[]
 for start in starts.values():
  pieces=start['Children'];names=collections.Counter(c.get('pool_element',{}).get('location',c.get('id'))for c in pieces);bb=[min(c['BB'][i]for c in pieces)for i in range(3)]+[max(c['BB'][i]for c in pieces)for i in range(3,6)]
  inside=lambda g:all(bb[i]<=g[i]<=bb[i+3]for i in range(3))
  rows=[g for g in gold if inside(g)];contents=[g for g in chests if inside(g['at'])]
  kind=next((name.split('/')[1]for name in names if name and name.startswith('minecraft:bastion/')),'unknown')
  bastions.append({'type':kind,'bounds':bb,'horizontalDistance':round(math.hypot(start['ChunkX']*16-p[0],start['ChunkZ']*16-p[2]),1),'actualGoldBlocks':len(rows),'goldPositions':rows,'chests':contents,'pieces':dict(names),'templateGoldBeforeProcessors':sum(n*templates.get(k,{}).get('gold',0)for k,n in names.items()),'templateChestsBeforeProcessors':sum(n*templates.get(k,{}).get('chests',0)for k,n in names.items())})
 expected={(x,z)for x in range((p[0]-112)>>4,((p[0]+112)>>4)+1)for z in range((p[2]-112)>>4,((p[2]+112)>>4)+1)}
 result={**meta,'portalChunksExpected':len(expected),'portalChunksFull':len(expected&fullChunks),'portalChunksMissing':sorted(expected-fullChunks),'walkablePositions':len(distances),'goldReachableByUnmodifiedWalking':routegold,'oreReachableByUnmodifiedWalking':routeore,'oreDensityByShortestRoute':{str(n):{'ore':sum(r['walkSteps']<=n for r in routeore),'positions':sum(v<=n for v in distances.values())}for n in (10,25,50,100,200,400)},'bastions':bastions,'limits':'No digging, bridging or mob-risk simulation; cardinal steps with +1/-3, full-block floors only, closed doors treated open; centre-ray approximate eye visibility. Geometry upper/lower biases make this a terrain census, not a player yield trial.'}
 (d/'analysis.json').write_text(json.dumps(result,indent=2));summary.append(result);print(meta['seed'],len(distances),len(routeore),len(routegold),[(b['type'],b['actualGoldBlocks'],b['templateGoldBeforeProcessors'])for b in bastions],flush=True)
(root/'summary.json').write_text(json.dumps(summary,indent=2))
