"""Build seven clean, complete vector assets per character from the locked masters."""
from pathlib import Path
import sys,json,hashlib,xml.etree.ElementTree as ET
sys.path.insert(0,'/private/tmp/flock-parts-deps')
import pathops
from fontTools.svgLib.path import parse_path
from fontTools.pens.svgPathPen import SVGPathPen
ROOT=Path(__file__).resolve().parents[1];NS={'s':'http://www.w3.org/2000/svg'}
def path(d):
 p=pathops.Path();parse_path(d,p.getPen());return p

def op(a,b,k):return pathops.op(a,b,getattr(pathops.PathOp,k))
def rect(x,y,w,h):return path(f'M{x} {y}h{w}v{h}h{-w}Z')
def expand(p,r):
 q=pathops.Path(p);q.stroke(r*2,pathops.LineCap.ROUND_CAP,pathops.LineJoin.ROUND_JOIN,4);q.convertConicsToQuads(.02);return op(p,q,'UNION')
def string(p):
 pen=SVGPathPen(None,ntos=lambda n:str(round(n,3)));p.draw(pen);return pen.getCommands()
def draw(p,color):return f'<path fill="{color}" d="{string(p)}"/>'
def capsule(cx,cy,w,h):
 x=cx-w/2;y=cy-h/2;r=w/2;k=.5522847498*r
 return path(f'M{x+r} {y}C{x+r+k} {y} {x+w} {y+r-k} {x+w} {y+r}V{y+h-r}C{x+w} {y+h-r+k} {x+r+k} {y+h} {x+r} {y+h}C{x+r-k} {y+h} {x} {y+h-r+k} {x} {y+h-r}V{y+r}C{x} {y+r-k} {x+r-k} {y} {x+r} {y}Z')

CONFIG={'pixel': {'eyes': [(209, 277, 18, 53), (260, 277, 18, 53)], 'ears': [(0, 210, 111, 91), (345, 209, 112, 96)], 'pivots': [(93, 233), (362, 239)], 'earfront': False, 'eargray': 1, 'feet': [(158, 551), (300, 551)]}, 'guardian': {'eyes': [(240, 319, 20, 64), (311, 319, 20, 64)], 'ears': [(109, 162, 64, 61), (365, 160, 66, 65)], 'pivots': [(148, 197), (394, 197)], 'earfront': False, 'eargray': 1, 'feet': [(176, 550), (360, 550)]}, 'sunny': {'eyes': [(220, 327, 20, 59), (284, 327, 20, 59)], 'ears': [(48, 287, 108, 76), (349, 287, 105, 75)], 'pivots': [(141, 307), (365, 307)], 'earfront': True, 'eargray': 1, 'feet': [(174, 550), (328, 550)]}}

FEET={
'pixel':[
'M129.22 586.27C128.32 593.95 136.21 597.43 154.5 597.43C174.95 597.43 178.59 595.34 181.38 581.99C184 569 189 545 186 535C182 516 150 514 145 530C139 544 130 578 129.22 586.27Z',
'M278.54 581.37C280.72 590.55 282.18 592.75 287.67 595.18C293.26 597.65 308.14 598.67 316.29 597.14C328.26 594.89 332.19 590.96 330.08 583.36C327 572 325 549 320 535C315 518 280 515 275 534C272 549 275 566 278.54 581.37Z'],
'guardian':[
'M146.54 572.35C144.33 582.02 144.21 583.56 145.43 586.48C149.46 596.13 180.79 600.25 195.01 593C199.89 590.5 200.01 590.26 204.04 574.91L207.34 562.32C212 544 216 529 201 521C180 511 158 516 153 537C151 545 149.5 559.3 146.54 572.35Z',
'M333.6 564.33C333.67 564.42 335.4 569.9 337.45 576.5C342.52 592.79 343.85 594.06 357.74 595.96C371.48 597.85 389.11 594.62 394.5 589.23C398.26 585.47 398.16 583.23 393.59 566.98L389.25 551.55C385 530 384 517 369 515C352 511 333 516 329 531C327 538 330 551 333.6 564.33Z'],
'sunny':[
'M143.5 574C140.17 583.78 140.24 587.4 143.83 590.98C150.88 598.03 177.72 600.02 189.61 594.38C194.01 592.29 195.11 590.08 198.59 576.38L201.41 565.27C207 542 212 526 194 518C180 512 158 516 154 531C151 543 146 566.65 143.5 574Z',
'M303.68 576.63C307.46 590.07 308.87 592.63 313.54 594.58C326.82 600.13 354.48 597.03 359.45 589.43C361.62 586.12 361.39 582.49 358.45 573.93C357.05 569.84 355.06 563.46 354.02 559.75L352.13 553C348 536 347 523 333 519C316 512 297 519 295 532C293 543 300 563.5 303.68 576.63Z']}

def run(name,c):
 src=ROOT/'svg'/f'{name}.svg';root=ET.parse(src).getroot();w,h=int(root.get('width')),int(root.get('height'))
 silhouette=path(root.find('.//s:clipPath/s:path',NS).get('d')).transform(.01,0,0,-.01,0,h)
 layers=[]
 for group in root.findall('s:g/s:g',NS):
  p=pathops.Path()
  for child in group.findall('s:path',NS):p.addPath(path(child.get('d')))
  layers.append([op(p.transform(.01,0,0,-.01,0,h),silhouette,'INTERSECTION'),group.get('fill')])
 ink=layers[0][1]
 gray=layers[c['eargray']][1];cream=layers[-1][1]
 original_layers=[(pathops.Path(p),fill) for p,fill in layers]
 eyes=[];eye_erase=pathops.Path()
 for cx,cy,ew,eh in c['eyes']:
  eye=capsule(cx,cy,17.5 if name=='pixel' else 19 if name=='sunny' else 20,eh);eyes.append(eye);eye_erase=op(eye_erase,expand(eye,4),'UNION')
 # Remove the former eye geometry all the way down to the continuous dark face layer.
 for i in range(1,len(layers)):layers[i][0]=op(layers[i][0],eye_erase,'DIFFERENCE')
 ear_shapes=[];ear_erase=pathops.Path()
 neutral=op(original_layers[1][0],original_layers[2][0],'DIFFERENCE')
 for ear_index,roi in enumerate(c['ears']):
  candidates=list(op(neutral,rect(*roi),'INTERSECTION').contours)
  inner=max(candidates,key=lambda p:abs(p.area))
  if name=='guardian':
   inner=path('M114 168C137 162 166 182 170 218C146 222 120 205 114 168Z')
   if ear_index:inner=inner.transform(-1,0,0,1,546,0)
  # Keep the source's smooth inner leaf, and create a continuous ink border around it.
  outer=expand(inner,{'pixel':11,'sunny':8,'guardian':6}[name])
  if name=='pixel':
   outer=path(['M99 219C90 214 80 217 65.21 220.58C43.29 225.42 29.03 232.28 17.55 243.53C-.67 261.37 3.15 280.05 26.88 289.1C33.46 291.6 48.26 292.71 54.84 291.18C76 286 95 257 99 231C100 225 101 220 99 219Z','M357 222C364 217 376 222 394.12 224.91C441.62 231 468.12 263.12 443.51 284.78C434.96 292.31 418.62 297.9 409.25 296.51C384 293 360 264 355 235C352 227 351 224 357 222Z'][ear_index])
  ear_shapes.append((outer,inner));ear_erase=op(ear_erase,expand(outer,5),'UNION')
 # The continuous coloured wool contour defines the anatomy, including its hidden roots.
 fur_index={'pixel':4,'guardian':1,'sunny':5}[name]
 wool=original_layers[fur_index][0]
 if name=='guardian':wool=neutral
 envelopes=sorted(wool.contours,key=lambda p:abs(p.area),reverse=True)[:2 if name=='pixel' else 1]
 envelope=pathops.Path()
 for component in envelopes:envelope=op(envelope,component,'UNION')
 body=expand(envelope,9)
 if name=='guardian':
  warm=original_layers[5][0]
  horns=sorted(warm.contours,key=lambda p:abs(p.area),reverse=True)[:4]
  for horn in horns:body=op(body,expand(horn,9),'UNION')
 if name=='pixel':body=max(body.contours,key=lambda p:abs(p.area))
 if name=='sunny':
  # Ears sit in front of the yellow wool; close their old shapes in the wool geometry itself.
  for i in range(1,len(layers)):layers[i][0]=op(layers[i][0],ear_erase,'DIFFERENCE')
  layers[5][0]=op(layers[5][0],op(ear_erase,body,'INTERSECTION'),'UNION')
 # Rebuild attachment outlines from the wool alone; the source silhouette includes
 # black appendage roots and cannot define the exposed body edge at these joins.
 # The gray foot/ear insets are separate components, including anti-aliased fringes.
 inset_remnants=pathops.Path()
 for cx,cy in c['feet']:
  inset=max(op(neutral,rect(cx-32,540,64,45),'INTERSECTION').contours,key=lambda q:abs(q.area))
  inset_remnants=op(inset_remnants,expand(inset,1.2),'UNION')
 if name=='guardian':
  for roi in c['ears']:
   x,y,rw,rh=roi
   candidates=[q for q in neutral.contours if q.bounds[0]>=x and q.bounds[1]>=y and q.bounds[2]<=x+rw and q.bounds[3]<=y+rh]
   inset=max(candidates,key=lambda q:abs(q.area))
   inset_remnants=op(inset_remnants,expand(inset,1.2),'UNION')
 for index in range(1,len(layers)):
  layers[index][0]=op(layers[index][0],inset_remnants,'DIFFERENCE')
 # Preserve the source palette and internal fur curves inside the complete body silhouette.
 fur=[draw(body,ink)]
 for p,fill in layers[1:]:fur.append(draw(op(p,body,'INTERSECTION'),fill))
 parts=[]
 def add(k,label,pivot,offset,geometry,outline):
  bounds=list(outline.bounds);parts.append(dict(id=k,label=label,pivot=list(pivot),offset=list(offset),bounds=[round(x,3) for x in bounds],parent='character',hasCompletion=True,geometry=geometry))
 # Author complete rounded roots while retaining the approved visible sole curves.
 for i,(cx,cy) in enumerate(c['feet']):
  from fontTools.pens.recordingPen import RecordingPen
  base=path(FEET[name][i]);recording=RecordingPen();base.draw(recording)
  outer=pathops.Path();pen=outer.getPen()
  for verb,points in recording.value:
   extended=[]
   for x,y in points:
    # A continuous tapered extension within the fur provides travel for a lifted foot.
    t=max(0,min(1,(550-y)/35))
    extended.append((x+((17 if i==0 else -17)*t),y-70*t))
   getattr(pen,verb)(*extended)

  roi=(cx-32,540,64,45)
  highlight=max(op(neutral,rect(*roi),'INTERSECTION').contours,key=lambda p:abs(p.area))
  add('foot-'+('left' if i==0 else 'right'),('Left' if i==0 else 'Right')+' foot',(cx+(17 if i==0 else -17),475),(-45 if i==0 else 45,85),draw(outer,ink)+draw(highlight,gray),outer)
 def add_ears():
  for i,(outer,inner) in enumerate(ear_shapes):add('ear-'+('left' if i==0 else 'right'),('Left' if i==0 else 'Right')+' ear',c['pivots'][i],(-110 if i==0 else 110,-10),draw(outer,ink)+draw(inner,gray),outer)
 if not c['earfront']:add_ears()
 add('fur','Fur / body',(w/2,390),(0,20),''.join(fur),body)
 if c['earfront']:add_ears()
 for i,(eye,coords) in enumerate(zip(eyes,c['eyes'])):add('eye-'+('left' if i==0 else 'right'),('Left' if i==0 else 'Right')+' eye',coords[:2],(-65 if i==0 else 65,-30),draw(eye,cream),eye)
 output=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" role="img" aria-labelledby="{name}-title"><title id="{name}-title">{name.title()} — clean seven-part artwork</title><desc>Complete eyes, ears and feet; continuous fur, face and fixed horns. Static vector artwork with no clipping masks or animation.</desc><g id="{name}-character" data-part="character" data-pivot="{w/2} 390">']
 export_dir=ROOT/'parts'/name;export_dir.mkdir(exist_ok=True)
 for part in parts:
  x0,y0,x1,y1=part['bounds'];part['file']=f"{name}/{part['id']}.svg"
  standalone=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0-10} {y0-10} {x1-x0+20} {y1-y0+20}"><title>{name.title()} — {part["label"]}</title>{part["geometry"]}</svg>'
  (export_dir/f"{part['id']}.svg").write_text(standalone)
  output.append(f'<g id="{name}-{part["id"]}" data-part="{part["id"]}" data-pivot="{part["pivot"][0]} {part["pivot"][1]}" aria-label="{part["label"]}">{part.pop("geometry")}</g>')
 output.append('</g></svg>');dest=ROOT/'parts';dest.mkdir(exist_ok=True);(dest/f'{name}.svg').write_text('\n'.join(output))
 meta=dict(name=name,width=w,height=h,source=f'svg/{name}.svg',sourceSha256=hashlib.sha256(src.read_bytes()).hexdigest(),parts=parts,convention='Viewer left/right. Seven controls. Face and horns remain fixed in the fur/body group.',revision='clean-roots-long-legs')
 (dest/f'{name}.json').write_text(json.dumps(meta,indent=2));print(name, len(parts),'parts')
for n,c in CONFIG.items():run(n,c)
