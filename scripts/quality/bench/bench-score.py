#!/usr/bin/env python3
"""Read only. bench-score.py <tag> [--runs-dir path]; ? means missing evidence."""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path


def load_report(file):
    def resolve(value):
        if isinstance(value, dict) and value.get('reportArtifact', {}).get('version') == 1:
            ref = value['reportArtifact']
            data = (file.parent / ref['path']).read_bytes()
            if hashlib.sha256(data).hexdigest() != ref['sha256']:
                raise ValueError('artifact digest mismatch')
            return resolve(json.loads(data))
        if isinstance(value, dict):
            return {k: resolve(v) for k, v in value.items()}
        if isinstance(value, list):
            return [resolve(v) for v in value]
        return value
    return resolve(json.loads(file.read_text()))


def score(root, tag):
    paths = sorted({p.with_suffix('') if p.suffix in ('.log', '.done') else p
                    for p in root.iterdir() if p.name.startswith(tag + '-')
                    and (p.is_dir() or p.suffix in ('.log', '.done'))})
    rows = []
    for directory in paths:
        try:
            report = load_report(directory / 'results.json')
            runs = report.get('runs', [])
            if not runs:
                raise ValueError('no completed runs')
        except (OSError, ValueError) as error:
            identity = re.search(r'-(codex|claude)-([A-Z]-[A-Za-z0-9]+)-r\d+$', directory.name)
            rows.append([identity[2] if identity else directory.name, identity[1] if identity else '?', 'UNAVAILABLE' if Path(str(directory)+'.done').exists() else 'PENDING', None, None, str(error), None])
            continue
        for run in runs:
            metrics = run.get('metrics') or {}
            evaluation = run.get('evaluation') or {}
            passed = evaluation.get('pass') if evaluation.get('status') == 'EVALUATED' else None
            status = ('PASS' if passed else 'FAIL') if passed is not None else 'UNKNOWN'
            if run.get('measurementStatus') != 'MEASURED':
                status += '/' + str(run.get('measurementStatus', 'UNKNOWN'))
            minutes = metrics.get('playWallTimeMs')
            causes = collections.Counter()
            for event in metrics.get('deathEvents', []):
                cause = event.get('cause') or 'unknown'
                causes[cause if isinstance(cause, str) else json.dumps(cause, sort_keys=True)] += 1
            deaths = metrics.get('deaths')
            if deaths is not None and deaths > sum(causes.values()):
                causes['unknown'] += deaths - sum(causes.values())
            reflex = metrics.get('reflexFirings', metrics.get('reflexFiringsCount'))
            # Leave absent telemetry unknown, rather than claiming zero firings on old jars.
            if isinstance(reflex, list):
                reflex = len(reflex)
            if isinstance(reflex, dict):
                reflex = sum(v for v in reflex.values() if isinstance(v, (int, float)))
            rows.append([run.get('scenario'), (run.get('profile') or {}).get('provider'), status,
                         minutes / 60000 if minutes is not None else None, deaths,
                         ', '.join(f'{k}: {v}' for k, v in sorted(causes.items())) or ('none' if deaths == 0 else '?'), reflex])
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    parser.add_argument('--runs-dir', type=Path, default=Path('/home/agaminggod/Desktop/Projects/arena-beat-game/sub/runs'))
    args = parser.parse_args()
    rows = score(args.runs_dir, args.tag)
    if not rows:
        parser.error('no matching run artifacts')
    totals = ['TOTAL', f'{len(rows)} runs', f'{sum(r[2].startswith("PASS") for r in rows)}/{len(rows)} pass',
              sum(r[3] or 0 for r in rows), sum(r[4] or 0 for r in rows), '', sum(r[6] or 0 for r in rows)]
    for i in (3, 4, 6):
        missing = sum(r[i] is None for r in rows)
        if missing:
            totals[i] = f'{totals[i]:.2f} known; {missing} unknown' if i == 3 else f'{totals[i]} known; {missing} unknown'
    print('| Room | Provider | Pass / measurement | Minutes played | Deaths | Death causes | Reflex firings |')
    print('|---|---|---|---:|---:|---|---:|')
    for row in [*rows, totals]:
        print('| ' + ' | '.join(('?' if v is None else f'{v:.2f}' if isinstance(v, float) else str(v)).replace('|', '/').replace('\n', ' ') for v in row) + ' |')


if __name__ == '__main__':
    main()
