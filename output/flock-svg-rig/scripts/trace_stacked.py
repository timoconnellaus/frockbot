"""Layered colour tracing to preserve closed shapes without quantization pinholes."""
from pathlib import Path
import sys,argparse,json
sys.path.insert(0,'/private/tmp/flock-svg-deps312')
import vtracer
import numpy as np
from PIL import Image,ImageFilter
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--version',required=True);p.add_argument('--precision',type=int,default=6);p.add_argument('--difference',type=int,default=12);p.add_argument('--speckle',type=int,default=4);p.add_argument('--mode',default='spline');p.add_argument('--scale',type=int,default=1);p.add_argument('--blur',type=float,default=0);a=p.parse_args()
folder=ROOT/'versions'/a.version;folder.mkdir(parents=True,exist_ok=True)
for name in ['guardian','pixel','sunny']:
    src=np.array(Image.open(ROOT/'assets'/f'{name}-reference.png').convert('RGBA'))
    mask=np.array(Image.open(ROOT/'assets'/f'{name}-mask.png'))>0
    src[:,:,3]=mask*255;src[~mask,:3]=0
    inp=folder/f'{name}-trace-input.png';im=Image.open(ROOT/'assets'/f'{name}-reference.png').convert('RGB');w,h=im.size;im=im.filter(ImageFilter.GaussianBlur(a.blur)).resize((w*a.scale,h*a.scale),Image.Resampling.LANCZOS).convert('RGBA');im.putalpha(Image.fromarray((mask*255).astype('uint8')).resize(im.size,Image.Resampling.NEAREST));im.save(inp)
    out=folder/f'{name}.svg'
    vtracer.convert_image_to_svg_py(str(inp),str(out),colormode='color',hierarchical='stacked',mode=a.mode,filter_speckle=a.speckle,color_precision=a.precision,layer_difference=a.difference,corner_threshold=60,length_threshold=3.5,max_iterations=10,splice_threshold=45,path_precision=3)
    text=out.read_text();text=text.replace(f'width="{w*a.scale}" height="{h*a.scale}"',f'width="{w}" height="{h}" viewBox="0 0 {w*a.scale} {h*a.scale}"');offset=text.index('>',text.index('<svg'))+1
    text=text[:offset]+f'<title>{name.title()} — bold sticker</title><desc>Original concept traced as editable vector paths. No embedded raster.</desc>'+text[offset:]
    out.write_text(text);print(name,a.version,flush=True)
(folder/'settings.json').write_text(json.dumps(vars(a),indent=2))
