"""Trace the fixed concept crops to real SVG paths. No bitmap embedding."""
from pathlib import Path
import argparse, json, subprocess, xml.etree.ElementTree as ET
import numpy as np
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[1]
NS={'s':'http://www.w3.org/2000/svg'}

def trace(mask,folder,name,tolerance):
    pbm=folder/(name+'.pbm');svg=folder/(name+'.svg')
    Image.fromarray(np.where(mask,0,255).astype('uint8')).convert('1').save(pbm)
    subprocess.run(['potrace',str(pbm),'-s','--flat','-t','2','-O',str(tolerance),'-u','100','-o',str(svg)],check=True)
    tree=ET.parse(svg);g=tree.find('s:g',NS)
    paths=[p.attrib['d'] for p in g.findall('s:path',NS)]
    return g.attrib['transform'],paths

def run(name,version,colors,tolerance):
    src=Image.open(ROOT/'assets'/f'{name}-reference.png').convert('RGB');a=np.asarray(src);w,h=src.size
    maskpath=ROOT/'assets'/f'{name}-mask.png'
    if not maskpath.exists():
        # Every character has a closed dark outer contour. Flood only the exterior.
        barrier=np.min(a,axis=2)<160
        region=Image.fromarray(np.where(barrier,0,255).astype('uint8')).copy()
        ImageDraw.floodfill(region,(0,0),128,thresh=0)
        mask=np.asarray(region)!=128
        Image.fromarray((mask*255).astype('uint8')).save(maskpath)
    mask=np.asarray(Image.open(maskpath))>0
    assert .15 < mask.mean() < .95 and not mask[0,0], 'Invalid reference mask'
    dest=ROOT/'versions'/version;temp=dest/'trace-work'/name;temp.mkdir(parents=True,exist_ok=True)
    pixels=a[mask];training=Image.fromarray(pixels.reshape(-1,1,3)).quantize(colors=colors,method=Image.Quantize.MEDIANCUT)
    quant=src.quantize(palette=training,dither=Image.Dither.NONE);labels=np.asarray(quant);palette=np.array(quant.getpalette()).reshape(-1,3)
    transform,silhouette=trace(mask,temp,'silhouette',tolerance)
    shape=''.join(f'<path d="{d}"/>' for d in silhouette)
    clip=f'{name}-boundary'
    clipshape=''.join(f'<path transform="{transform}" d="{d}"/>' for d in silhouette)
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="{name}-title">',f'<title id="{name}-title">{name.title()} — bold sticker</title>',f'<desc>Vector paths traced from the locked original concept. Revision {version}. No embedded raster content.</desc>',f'<defs><clipPath id="{clip}">{clipshape}</clipPath></defs>',f'<g clip-path="url(#{clip})"><g id="outer-ink" transform="{transform}" fill="#161718">{shape}</g>']
    groups=[]
    for i in sorted(np.unique(labels[mask]),key=lambda i:-np.count_nonzero((labels==i)&mask)):
        rgb=palette[i];color='#'+''.join(f'{int(x):02x}' for x in rgb)
        tf,paths=trace((labels==i)&mask,temp,'color-'+str(i),tolerance)
        if not paths:continue
        # A subpixel overlap prevents hairline seams between adjacent traced fills.
        parts.append(f'<g id="palette-{i}" data-color="{color}" fill="{color}" stroke="{color}" stroke-width="35" stroke-linejoin="round" transform="{tf}">')
        parts.extend(f'<path d="{d}"/>' for d in paths);parts.append('</g>')
        groups.append({'id':f'palette-{i}','color':color})
    parts.extend(['</g>','</svg>']);(dest/f'{name}.svg').write_text('\n'.join(parts))
    (dest/f'{name}-palette.json').write_text(json.dumps(groups,indent=2))
    print(name,version,colors,'colours',flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--version',required=True);p.add_argument('--colors',type=int,default=16);p.add_argument('--tolerance',type=float,default=.2)
    a=p.parse_args()
    for n in ['guardian','pixel','sunny']:run(n,a.version,a.colors,a.tolerance)
