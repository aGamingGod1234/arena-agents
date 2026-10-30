# Offline ground truth for analysis (never reaches a model): still lava pools in a run world's generated Overworld chunks.
# usage: python3 -I scripts/quality/lava-survey.py WORLD_DIR X Z   (pools by horizontal distance from X, Z; exposed = air above)
import struct, zlib, sys, os, glob, math, json
from collections import deque

def nbt(buf):
    pos = 0
    def u(fmt, n):
        nonlocal pos
        v = struct.unpack_from(fmt, buf, pos); pos += n; return v[0]
    def string():
        nonlocal pos
        n = u('>H', 2); s = buf[pos:pos + n].decode('utf-8', 'replace'); pos += n; return s
    def payload(t):
        nonlocal pos
        if t == 1: return u('>b', 1)
        if t == 2: return u('>h', 2)
        if t == 3: return u('>i', 4)
        if t == 4: return u('>q', 8)
        if t == 5: return u('>f', 4)
        if t == 6: return u('>d', 8)
        if t == 7: n = u('>i', 4); pos += n; return None
        if t == 8: return string()
        if t == 9:
            et = u('>b', 1); n = u('>i', 4); return [payload(et) for _ in range(n)]
        if t == 10:
            out = {}
            while True:
                tt = u('>b', 1)
                if tt == 0: return out
                name = string(); out[name] = payload(tt)
        if t == 11: n = u('>i', 4); v = struct.unpack_from('>%di' % n, buf, pos); pos += 4 * n; return v
        if t == 12: n = u('>i', 4); v = struct.unpack_from('>%dq' % n, buf, pos); pos += 8 * n; return v
        raise ValueError(t)
    t = u('>b', 1); string(); return payload(t)

def chunks(path):
    with open(path, 'rb') as f: data = f.read()
    for i in range(1024):
        off = int.from_bytes(data[i * 4:i * 4 + 3], 'big'); cnt = data[i * 4 + 3]
        if off == 0 or cnt == 0: continue
        start = off * 4096
        length = struct.unpack_from('>i', data, start)[0]; comp = data[start + 4]
        raw = data[start + 5:start + 4 + length]
        if comp == 2: yield nbt(zlib.decompress(raw))

def blocks_of(section):
    bs = section.get('block_states') or {}
    pal = bs.get('palette') or []
    if len(pal) == 1: return pal, None
    bits = max(4, math.ceil(math.log2(len(pal))))
    per = 64 // bits; mask = (1 << bits) - 1
    data = bs.get('data') or ()
    idx = []
    for word in data:
        w = word & 0xFFFFFFFFFFFFFFFF
        for k in range(per):
            idx.append((w >> (k * bits)) & mask)
            if len(idx) == 4096: break
    return pal, idx

def main():
    world, ox, oz = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    lava = set(); air_above = set(); solid = {}
    sky = {}  # (x,z) -> highest non-air y among scanned chunk columns (heightmap WORLD_SURFACE)
    full = 0
    for path in glob.glob(os.path.join(world, 'dimensions/minecraft/overworld/region/*.mca')):
        for c in chunks(path):
            if c.get('Status', '').split(':')[-1] != 'full': continue
            full += 1
            cx, cz = c['xPos'], c['zPos']
            hm = (c.get('Heightmaps') or {}).get('WORLD_SURFACE')
            for sec in c.get('sections', []):
                pal, idx = blocks_of(sec)
                names = [p.get('Name') for p in pal]
                if 'minecraft:lava' not in names: continue
                sy = sec['Y']
                lav = [i for i, p in enumerate(pal) if p.get('Name') == 'minecraft:lava' and (p.get('Properties') or {}).get('level', '0') == '0']
                airs = {i for i, n in enumerate(names) if n in ('minecraft:air', 'minecraft:cave_air')}
                if idx is None:
                    continue  # a section entirely lava: interior of a lake, counted via neighbours rarely matters
                for n, v in enumerate(idx):
                    if v in lav:
                        x = cx * 16 + (n & 15); z = cz * 16 + ((n >> 4) & 15); y = sy * 16 + (n >> 8)
                        lava.add((x, y, z))
                    elif v in airs:
                        x = cx * 16 + (n & 15); z = cz * 16 + ((n >> 4) & 15); y = sy * 16 + (n >> 8)
                        air_above.add((x, y, z))
            if hm:
                # 9-bit packed heights, 7 per long (1.16+); WORLD_SURFACE minus min y (-64)
                vals = []
                for word in hm:
                    w = word & 0xFFFFFFFFFFFFFFFF
                    for k in range(7):
                        vals.append((w >> (k * 9)) & 511)
                for n in range(256):
                    sky[(cx * 16 + (n & 15), cz * 16 + (n >> 4))] = vals[n] - 64 - 1
    seen = set(); pools = []
    for cell in lava:
        if cell in seen: continue
        q = deque([cell]); seen.add(cell); members = []
        while q:
            x, y, z = q.popleft(); members.append((x, y, z))
            for d in ((1,0,0),(-1,0,0),(0,0,1),(0,0,-1),(0,1,0),(0,-1,0)):
                nb = (x + d[0], y + d[1], z + d[2])
                if nb in lava and nb not in seen: seen.add(nb); q.append(nb)
        exposed = [m for m in members if (m[0], m[1] + 1, m[2]) in air_above]
        open_sky = [m for m in exposed if sky.get((m[0], m[2]), 999) <= m[1]]
        cxp = sum(m[0] for m in members) / len(members); czp = sum(m[2] for m in members) / len(members)
        top = max(m[1] for m in members)
        pools.append({'sources': len(members), 'exposed': len(exposed), 'sky': len(open_sky), 'x': round(cxp), 'y': top, 'z': round(czp),
                      'dist': round(math.hypot(cxp - ox, czp - oz))})
    pools.sort(key=lambda p: p['dist'])
    print(json.dumps({'fullChunks': full, 'pools': len(pools), 'usable': [p for p in pools if p['sources'] >= 10 and p['exposed'] >= 1][:40]}))

if __name__ == '__main__':
    main()
