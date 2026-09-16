"""Check buried leg caps in static poses; this creates no animation."""
from pathlib import Path
import json, math, sys, xml.etree.ElementTree as ET
sys.path.insert(0, '/private/tmp/flock-parts-deps')
import pathops
from fontTools.svgLib.path import parse_path
ROOT=Path(__file__).resolve().parents[1]
def path(d):
    p=pathops.Path(); parse_path(d,p.getPen()); return p
report={'rotationDegrees':[-12,0,12],'verticalOffsets':[-20,0,20],'characters':{}}
for name in ['pixel','guardian','sunny']:
    root=ET.parse(ROOT/'parts'/f'{name}.svg').getroot()
    nodes={n.get('data-part'):n for n in root.iter() if n.get('data-part')}
    meta=json.loads((ROOT/'parts'/f'{name}.json').read_text())
    body=path(list(nodes['fur'])[0].get('d'))
    sequence=[p['id'] for p in meta['parts']]
    result=[]
    for side in ['left','right']:
        key=f'foot-{side}';part=next(p for p in meta['parts'] if p['id']==key)
        assert sequence.index(key)<sequence.index('fur')
        assert part['bounds'][3]-part['bounds'][1]>125
        foot=path(list(nodes[key])[0].get('d'));px,py=part['pivot']
        cap=pathops.op(foot,path(f'M0 0H1000V{py+20}H0Z'),pathops.PathOp.INTERSECTION)
        maximum=0
        for angle in report['rotationDegrees']:
            a=math.radians(angle);c=math.cos(a);s=math.sin(a)
            for dy in report['verticalOffsets']:
                posed=cap.transform(c,s,-s,c,px-c*px+s*py,py-s*px-c*py+dy)
                exposed=pathops.op(posed,body,pathops.PathOp.DIFFERENCE).area
                maximum=max(maximum,exposed)
        assert maximum<.01,(name,side,maximum)
        result.append({'part':key,'posesChecked':9,'exposedRootArea':round(maximum,6),'pivot':part['pivot'],'height':round(part['bounds'][3]-part['bounds'][1],2)})
    report['characters'][name]=result
(ROOT/'parts/overlap.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
