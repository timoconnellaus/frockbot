"""Smooth region boundaries with cubic Bézier paths and overlapping colour layers."""
from pathlib import Path
import argparse,json
import numpy as np
from PIL import Image,ImageFilter
from trace import trace
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--version',required=True);p.add_argument('--colors',type=int,default=6);a=p.parse_args()
for name in ['guardian','pixel','sunny']:
    im=Image.open(ROOT/'assets'/f'{name}-reference.png').convert('RGB');rgb=np.asarray(im).astype(float);w,h=im.size
    mask=np.asarray(Image.open(ROOT/'assets'/f'{name}-mask.png'))>0
    x=rgb[mask][::5];centers=[x[np.argmin(x.sum(1))]]
    for _ in range(a.colors-1):
        d=((x[:,None,:]-np.array(centers)[None,:,:])**2).sum(2).min(1);centers.append(x[d.argmax()])
    centers=np.array(centers)
    for _ in range(30):
        labels=((x[:,None,:]-centers[None,:,:])**2).sum(2).argmin(1)
        centers=np.array([x[labels==i].mean(0) if (labels==i).any() else centers[i] for i in range(a.colors)])
    centers=centers[np.argsort(centers.sum(1))]
    labels=((rgb[:,:,None,:]-centers[None,None,:,:])**2).sum(3).argmin(2)
    folder=ROOT/'versions'/a.version;tmp=folder/'trace-work'/name;tmp.mkdir(parents=True,exist_ok=True)
    tf,paths=trace(mask,tmp,'silhouette',.3)
    boundary=''.join(f'<path d="{d}" transform="{tf}"/>' for d in paths)
    out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="{name}-title"><title id="{name}-title">{name.title()} — bold sticker</title><desc>Smooth editable Bézier paths traced from the locked bold-sticker concept. No embedded raster.</desc><defs><clipPath id="{name}-boundary">{boundary}</clipPath></defs><g clip-path="url(#{name}-boundary)">']
    for i,center in enumerate(centers):
        region=mask if i==0 else (labels>=i)&mask
        if i:region=np.asarray(Image.fromarray((region*255).astype('uint8')).filter(ImageFilter.MedianFilter(3)))>127
        tf,paths=trace(region,tmp,str(i),.3)
        color='#'+''.join(f'{int(round(v)):02x}' for v in center)
        out.append(f'<g id="{name}-colour-{i}" fill="{color}" transform="{tf}">')
        out.extend(f'<path d="{d}"/>' for d in paths);out.append('</g>')
    out.append('</g></svg>');(folder/f'{name}.svg').write_text('\n'.join(out));print(name,centers.round().tolist(),flush=True)
