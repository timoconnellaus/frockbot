"""Measure the resting split against the checkpoint; inspect semantic invariants."""
import json,hashlib,xml.etree.ElementTree as ET
import numpy as np
from PIL import Image
from measure import ROOT,box,edge,dilate
result={'checkpoint':'ad85697c70','reference':'Committed smooth SVG masters','characters':{}}
for name in ['guardian','pixel','sunny']:
    meta=json.loads((ROOT/'parts'/f'{name}.json').read_text());svg=ROOT/'parts'/f'{name}.svg';tree=ET.parse(svg)
    assert hashlib.sha256((ROOT/meta['source']).read_bytes()).hexdigest()==meta['sourceSha256']
    ids=[n.get('id') for n in tree.iter() if n.get('id')];assert len(ids)==len(set(ids))
    assert not any(n.tag.split('}')[-1] in ['image','foreignObject','animate','animateTransform','script','clipPath','mask','use'] for n in tree.iter())
    nodes={n.get('data-part'):n for n in tree.iter() if n.get('data-part')}
    assert set(nodes)=={'character',*[p['id'] for p in meta['parts']]}
    assert set(nodes)=={'character','fur','eye-left','eye-right','ear-left','ear-right','foot-left','foot-right'}
    for key in ['eye-left','eye-right','ear-left','ear-right','foot-left','foot-right']:
        assert len(list(nodes[key]))==(1 if key.startswith('eye') else 2)
        assert all(p.get('d').endswith(('Z','z')) for p in nodes[key])
    for p in meta['parts']:
        export=ET.parse(ROOT/'parts'/p['file'])
        assert len(export.findall('{http://www.w3.org/2000/svg}path'))>0
        x0,y0,x1,y1=p['bounds'];assert x1>x0 and y1>y0,p['id']
    a=np.asarray(Image.open(ROOT/'parts'/f'{name}-reference-render.png').convert('RGBA'),dtype=float);b=np.asarray(Image.open(ROOT/'parts'/f'{name}-render.png').convert('RGBA'),dtype=float)
    domain=(a[:,:,3]>127)|(b[:,:,3]>127);bg=np.array([255,249,239])
    x=a[:,:,:3]*(a[:,:,3:4]/255)+bg*(1-a[:,:,3:4]/255);y=b[:,:,:3]*(b[:,:,3:4]/255)+bg*(1-b[:,:,3:4]/255)
    color=100*(1-np.abs(x-y)[domain].mean()/255);ss=[]
    for c in range(3):
        xx=x[:,:,c];yy=y[:,:,c];mx=box(xx);my=box(yy);vx=np.maximum(0,box(xx*xx)-mx*mx);vy=np.maximum(0,box(yy*yy)-my*my);cov=box(xx*yy)-mx*my;c1=(.01*255)**2;c2=(.03*255)**2
        ss.append((((2*mx*my+c1)*(2*cov+c2))/((mx*mx+my*my+c1)*(vx+vy+c2)))[domain].mean()*100)
    ssim=float(np.mean(ss));ea=edge(x)&dilate(domain);eb=edge(y)&dilate(domain);precision=(eb&dilate(ea)).sum()/max(1,eb.sum());recall=(ea&dilate(eb)).sum()/max(1,ea.sum());f1=200*precision*recall/max(1e-10,precision+recall)
    alpha=100*(1-np.abs(a[:,:,3]-b[:,:,3])[domain].mean()/255)
    score=float(min(color,ssim,f1));result['characters'][name]={k:round(float(v),6) for k,v in dict(score=score,color=color,ssim=ssim,edge=f1,alpha=alpha).items()};result['characters'][name]['parts']=len(meta['parts'])
    diff=np.abs(x-y)*8;Image.fromarray(np.clip(diff,0,255).astype('uint8')).save(ROOT/'parts'/f'{name}-rest-diff.png')
    print(name,result['characters'][name])
(ROOT/'parts'/'validation.json').write_text(json.dumps(result,indent=2))
# This is a measured redraw, so the report records change rather than assuming an identical assembly.
