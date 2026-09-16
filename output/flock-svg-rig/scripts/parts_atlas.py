from pathlib import Path
import json,xml.etree.ElementTree as E
root=Path(__file__).resolve().parents[1]; E.register_namespace('','http://www.w3.org/2000/svg')
for name in ['pixel','guardian','sunny']:
 meta=json.loads((root/'parts'/f'{name}.json').read_text());tree=E.parse(root/'parts'/f'{name}.svg');nodes={n.get('data-part'):n for n in tree.iter()}
 text=['<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="680" viewBox="0 0 1200 680"><rect width="1200" height="680" fill="#eee9df"/>']
 for i,p in enumerate(meta['parts']):
  x=(i%4)*300;y=(i//4)*340;x0,y0,x1,y1=p['bounds'];size=max(x1-x0,y1-y0)+30;cx=(x0+x1)/2;cy=(y0+y1)/2
  text.append(f'<text x="{x+20}" y="{y+30}" font-family="sans-serif" font-size="18">{name.title()} · {p["label"]}</text><svg x="{x+10}" y="{y+45}" width="280" height="280" viewBox="{cx-size/2} {cy-size/2} {size} {size}">{E.tostring(nodes[p["id"]],encoding="unicode")}</svg>')
 text.append('</svg>');(root/'parts'/f'{name}-atlas.svg').write_text(''.join(text))
