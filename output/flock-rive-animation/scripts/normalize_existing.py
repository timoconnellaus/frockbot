from pathlib import Path
import sys,json,xml.etree.ElementTree as E
sys.path.insert(0,'/private/tmp/flock-parts-deps')
from fontTools.svgLib.path import parse_path
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
ROOT=Path(__file__).resolve().parents[1]
for name,primary,shade,profile in [('guardian','#424242','#736f62','grounded'),('sunny','#fdcd34','#a6842b','sunshine')]:
 source=ROOT.parent/'flock-svg-rig/parts'/name
 meta=json.loads(source.with_suffix('.json').read_text());svg=E.parse(source.with_suffix('.svg')).getroot()
 w,h=meta['width'],meta['height'];s=min(440/w,580/h);tx=(457-w*s)/2;ty=598-h*s
 doc=E.Element('svg',xmlns='http://www.w3.org/2000/svg',width='457',height='615',viewBox='0 0 457 615')
 for group in svg.findall('.//{*}g'):
  pid=group.get('data-part')
  if pid=='character' or not pid:continue
  part=next(p for p in meta['parts'] if p['id']==pid);x,y=part['pivot'];part['pivot']=[x*s+tx,y*s+ty]
  part['bounds']=[v*s+(tx if i%2==0 else ty) for i,v in enumerate(part['bounds'])]
  g=E.SubElement(doc,'g',id=name+'-'+pid,**{'data-part':pid,'data-pivot':' '.join(map(str,part['pivot']))})
  for p in group.findall('{*}path'):
   pen=SVGPathPen(None,ntos=lambda v:str(round(v,4)));parse_path(p.get('d'),TransformPen(pen,(s,0,0,s,tx,ty)))
   a={'fill':p.get('fill'),'d':pen.getCommands()}
   if pid=='fur' and p.get('fill')==primary:a['data-color-role']='primary'
   if pid=='fur' and p.get('fill')==shade:a['data-color-role']='shade'
   if pid.startswith('eye-'):a['data-color-role']='eyeColor'
   E.SubElement(g,'path',**a)
 meta.update(width=457,height=615,profile=profile,palette={'primary':primary,'shade':shade,'eyeColor':'#fcf6e3'})
 dest=ROOT/'characters'/name;dest.mkdir(exist_ok=True)
 E.indent(doc,space='  ');(dest/(name+'.svg')).write_text(E.tostring(doc,encoding='unicode')+'\n')
 (dest/(name+'.json')).write_text(json.dumps(meta,indent=2)+'\n')
 print(name,'normalized approved geometry')
