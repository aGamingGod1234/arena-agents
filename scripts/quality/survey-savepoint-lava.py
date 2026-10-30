#!/usr/bin/env python3
"""Find exposed natural casting pools and read their recovery-shaft surface heights from owned survey worlds.
Usage: survey-savepoint-lava.py CAVE_SURVEY_ROOT CAVE_SURVEY_JSON OUTPUT_JSON
"""
import importlib.util,json,math,pathlib,sys
spec=importlib.util.spec_from_file_location('lava_survey',pathlib.Path(__file__).with_name('lava-survey.py'));mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
root,cave_file,out=map(pathlib.Path,sys.argv[1:]);caves=json.loads(cave_file.read_text());result={}
for seed,site in caves.items():
    chunks={}
    for region in (root/seed/'server/world/dimensions/minecraft/overworld/region').glob('*.mca'):
        for c in mod.chunks(region):
            if c.get('Status','').endswith('full'): chunks[(c['xPos'],c['zPos'])]=c
    sections={(cx,sec['Y'],cz):sec for (cx,cz),c in chunks.items() for sec in c.get('sections',[])}
    def block(x,y,z):
        bs=sections.get((x//16,y//16,z//16),{}).get('block_states',{});pal=bs.get('palette',[])
        if not pal:return {}
        if len(pal)==1:return pal[0]
        bits=max(4,(len(pal)-1).bit_length());per=64//bits;i=((y%16)<<8)|((z%16)<<4)|(x%16);data=bs.get('data',[])
        return pal[((data[i//per]&((1<<64)-1))>>((i%per)*bits))&((1<<bits)-1)]
    exposed=set();lava=set()
    for (cx,sy,cz),sec in sections.items():
        if sy!=-4:continue
        pal,idx=mod.blocks_of(sec)
        if idx is None:continue
        for i,p in enumerate(pal):
            if p.get('Name')!='minecraft:lava' or p.get('Properties',{}).get('level','0')!='0':continue
            for n,v in enumerate(idx):
                if v!=i:continue
                x,y,z=cx*16+(n&15),sy*16+(n>>8),cz*16+((n>>4)&15)
                if y!=-55:continue
                lava.add((x,y,z))
                if block(x,y+1,z).get('Name') in ['minecraft:air','minecraft:cave_air']:exposed.add((x,y,z))
    ox,_,oz=site['campBed'];chosen=None
    for x,y,z in sorted(exposed,key=lambda p:(p[0]-ox)**2+(p[2]-oz)**2):
        bed=[x+6,y+1,z];sx,sz=bed[0]+4,bed[2]+1;c=chunks.get((sx//16,sz//16));hm=(c or {}).get('Heightmaps',{}).get('MOTION_BLOCKING_NO_LEAVES')
        if not hm:continue
        nearby=sum((x+dx,y,z+dz) in lava for dx in range(-3,1) for dz in range(-2,3))
        if nearby<10:continue
        # Heightmaps that ignore leaves still stop on logs and mangrove roots. Find the
        # ground or fluid surface below vegetation, then flag any obstructing headroom.
        top=None
        for h in range(319,-65,-1):
            b=block(sx,h,sz);name=b.get('Name','')
            if not name:continue
            if b.get('Properties',{}).get('waterlogged')=='true':top=h+1;break
            if name.endswith(('_leaves','_log','_wood')) or name in ['minecraft:air','minecraft:cave_air','minecraft:void_air','minecraft:vine','minecraft:mangrove_roots','minecraft:muddy_mangrove_roots']:continue
            top=h+1;break
        if top is None:continue
        obstructed=any(block(sx,h,sz).get('Name') not in ['minecraft:air','minecraft:cave_air','minecraft:void_air'] for h in [top,top+1])
        chosen={'poolEdge':[x,y,z],'bed':bed,'shaftTop':top,'nearbyNaturalSources':nearby,'world':str(root/seed/'server/world'),'method':'Offline existing lava-survey.py NBT reader; exposed source lava and ground/fluid surface below tree vegetation.'}
        if obstructed:chosen['exitObstructed']=True
        break
    if not chosen:raise RuntimeError('No usable exposed natural pool with a surveyed shaft on '+seed)
    result[seed]=chosen
out.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
