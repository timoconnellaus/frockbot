"""Negative controls for the image metric, separate from candidate revision history."""
import json,shutil
import numpy as np
from PIL import Image
from measure import ROOT,metrics
name='pixel';base=np.array(Image.open(ROOT/'versions/v7/pixel-render.png').convert('RGBA'));ref=np.array(Image.open(ROOT/'assets/pixel-reference.png').convert('RGBA'));ref[:,:,3]=np.asarray(Image.open(ROOT/'assets/pixel-mask.png'))
blank=np.zeros_like(base);shifted=np.zeros_like(base);shifted[:,12:]=base[:,:-12];recolored=base.copy();pink=(base[:,:,0]>180)&(base[:,:,1]<180)&(base[:,:,3]>0);recolored[pink,:3]=[40,180,220]
results={}
for label,array in [('perfect-reference',ref),('blank',blank),('shifted-12px',shifted),('recolored',recolored)]:
    folder=ROOT/'versions'/('control-'+label);folder.mkdir(exist_ok=True)
    shutil.copy2(ROOT/'versions/v7/pixel.svg',folder/'pixel.svg');Image.fromarray(array).save(folder/'pixel-render.png')
    c=metrics('pixel',folder.name);results[label]={k:round(float(c[k]),5) for k in ['score','color','ssim','edge']}
assert results['perfect-reference']['score']>99.999
assert all(results[n]['score']<95 for n in ['blank','shifted-12px','recolored'])
(ROOT/'metric-controls.json').write_text(json.dumps({'purpose':'Tests of the metric using intentionally altered rendered images; these are not SVG candidate revisions.','results':results},indent=2));print(json.dumps(results,indent=2))
